import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getRaw } from '../src/scan.js';

const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-scan-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: object[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

describe('getRaw (scanAll mtime cache)', () => {
  it('reuses the cached parse when mtime is unchanged, even if the file on disk changed underneath it', async () => {
    const f = write('a.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: '2026-07-14T12:00:00.000Z', message: { role: 'user', content: 'first' } },
    ]);
    const first = await getRaw(f, 1000);
    expect(first?.lastUserText).toBe('first');

    // Rewrite the file's content without changing the mtime we pass in —
    // simulates a scan where stat() reported the same mtime as last time.
    writeFileSync(f, JSON.stringify({ type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: '2026-07-14T12:00:00.000Z', message: { role: 'user', content: 'second' } }));
    const second = await getRaw(f, 1000);
    expect(second).toBe(first); // same cached object, not re-read from disk
    expect(second?.lastUserText).toBe('first');
  });

  it('re-parses when mtime changes', async () => {
    const f = write('b.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: '2026-07-14T12:00:00.000Z', message: { role: 'user', content: 'v1' } },
    ]);
    const v1 = await getRaw(f, 2000);
    expect(v1?.lastUserText).toBe('v1');

    writeFileSync(f, JSON.stringify({ type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: '2026-07-14T12:00:00.000Z', message: { role: 'user', content: 'v2' } }));
    const v2 = await getRaw(f, 2001);
    expect(v2).not.toBe(v1);
    expect(v2?.lastUserText).toBe('v2');
  });

  it('caches a null result (no cwd) without re-reading on the same mtime', async () => {
    const f = write('c.jsonl', [{ type: 'mode', mode: 'normal', sessionId: 'x' }]);
    const first = await getRaw(f, 3000);
    expect(first).toBeNull();
    const second = await getRaw(f, 3000);
    expect(second).toBeNull();
  });
});

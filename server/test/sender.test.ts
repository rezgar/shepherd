import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countLines, didMessageLand } from '../src/sender.js';

const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-sender-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: object[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function append(file: string, line: object): void {
  appendFileSync(file, JSON.stringify(line) + '\n');
}

const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistantLine = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

describe('didMessageLand', () => {
  it('finds a real user turn matching what was sent, after the anchor', async () => {
    const f = write('landed.jsonl', [userLine('earlier unrelated message'), assistantLine('ok')]);
    const linesBefore = await countLines(f);
    // Simulate the PTY write landing as a new transcript line, same as a real send would.
    append(f, userLine('please implement the new feature'));

    expect(await didMessageLand(f, 'please implement the new feature', linesBefore)).toBe(true);
  });

  it('returns false when the aggregate transcript moved on but our text never actually appears — the collision false-positive this guards against', async () => {
    const f = write('not-landed.jsonl', [userLine('earlier unrelated message'), assistantLine('ok')]);
    const linesBefore = await countLines(f);
    // A DIFFERENT live process's own unrelated turn lands instead of ours —
    // aggregate "it finished" heuristics would be satisfied, but our exact
    // text is nowhere in the new lines.
    append(f, userLine('totally unrelated thing the other terminal typed'));

    expect(await didMessageLand(f, 'please implement the new feature', linesBefore)).toBe(false);
  });

  it('only looks at lines after the anchor — a match that already existed before sending does not count', async () => {
    const f = write('pre-existing.jsonl', [userLine('please implement the new feature'), assistantLine('already handled')]);
    const linesBefore = await countLines(f);
    // Nothing new written after the anchor.
    expect(await didMessageLand(f, 'please implement the new feature', linesBefore)).toBe(false);
  });

  it('matches on a prefix — Claude Code may reformat trailing whitespace without changing the substance', async () => {
    const f = write('prefix.jsonl', [assistantLine('ok')]);
    const linesBefore = await countLines(f);
    append(f, userLine('please implement the new feature   \n'));

    expect(await didMessageLand(f, 'please implement the new feature', linesBefore)).toBe(true);
  });
});

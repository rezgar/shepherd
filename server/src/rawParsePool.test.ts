import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTranscriptInWorker } from './rawParsePool.js';
import { parseTranscript } from './transcript.js';

// #123: parseTranscript used to run on the daemon's main thread with no size
// cap or worker isolation — a huge, actively-growing session transcript
// (confirmed live at 245MB) repeatedly OOM'd the whole process the instant
// it was focused. This exercises the worker-isolated replacement wired into
// index.ts's sendWindow/sendSubagentWindow.

const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-rawparsepool-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: object[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

describe('parseTranscriptInWorker', () => {
  it('parses a normal transcript through the worker identically to the in-process parser', async () => {
    const f = write('hello.jsonl', [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-07-14T12:00:00.000Z',
        message: { role: 'user', content: 'hello there' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-07-14T12:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi!' }] },
      },
    ]);

    const [viaWorker, direct] = await Promise.all([
      parseTranscriptInWorker(f, 'sess1'),
      parseTranscript(f, 'sess1'),
    ]);

    expect(viaWorker).toEqual(direct);
    expect(viaWorker.messages.map((m) => m.text)).toEqual(['hello there', 'hi!']);
  });

  it('returns an empty transcript (not a throw) for a file that does not exist', async () => {
    const missing = path.join(dir, 'does-not-exist.jsonl');
    const result = await parseTranscriptInWorker(missing, 'sess2');
    expect(result).toEqual({ type: 'transcript', sessionId: 'sess2', file: missing, messages: [], activeSubagents: [] });
  });
});

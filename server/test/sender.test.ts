import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { countLines, didMessageLand, AsyncLock, RingBuffer } from '../src/sender.js';

describe('RingBuffer', () => {
  it('replays everything written so far, in order, under the cap', () => {
    const buf = new RingBuffer(1024);
    buf.push(Buffer.from('hello '));
    buf.push(Buffer.from('world'));
    expect(buf.replay().toString('utf8')).toBe('hello world');
  });

  it('drops the oldest bytes once the cap is exceeded, keeping the tail', () => {
    const buf = new RingBuffer(10);
    buf.push(Buffer.from('0123456789')); // exactly the cap
    buf.push(Buffer.from('AB')); // pushes it 2 over
    expect(buf.replay().toString('utf8')).toBe('23456789AB');
  });

  it('a single push larger than the cap keeps only its own tail', () => {
    const buf = new RingBuffer(5);
    buf.push(Buffer.from('abcdefghij'));
    expect(buf.replay().toString('utf8')).toBe('fghij');
  });
});

describe('AsyncLock', () => {
  it('runs queued work strictly one at a time, in call order, even if an earlier call is still pending', async () => {
    const lock = new AsyncLock();
    const order: number[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const a = lock.run(async () => {
      order.push(1);
      await delay(20); // slow first call
      order.push(2);
    });
    const b = lock.run(async () => {
      order.push(3); // must not run until `a`'s work above has fully finished
    });

    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a rejected call does not break the chain for the next one', async () => {
    const lock = new AsyncLock();
    const order: string[] = [];

    const a = lock.run(async () => {
      order.push('a');
      throw new Error('boom');
    });
    const b = lock.run(async () => {
      order.push('b');
    });

    await expect(a).rejects.toThrow('boom');
    await b;
    expect(order).toEqual(['a', 'b']);
  });
});

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

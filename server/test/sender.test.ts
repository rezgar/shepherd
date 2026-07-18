import { describe, it, expect } from 'vitest';
import { AsyncLock, RingBuffer, pinSession, unpinSession, unpinAllForConnection, isPinned } from '../src/sender.js';

function fakeWs() {
  return { readyState: 1, send: () => {} };
}

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

describe('pinSession / unpinSession / unpinAllForConnection (#73)', () => {
  it('is not pinned until a connection pins it', () => {
    expect(isPinned('s1')).toBe(false);
  });

  it('pinning marks it pinned; unpinning the same connection releases it', () => {
    const ws = fakeWs();
    pinSession('s2', ws);
    expect(isPinned('s2')).toBe(true);
    unpinSession('s2', ws);
    expect(isPinned('s2')).toBe(false);
  });

  it('stays pinned while ANY connection still holds it, even after another unpins', () => {
    const wsA = fakeWs();
    const wsB = fakeWs();
    pinSession('s3', wsA);
    pinSession('s3', wsB);
    unpinSession('s3', wsA);
    expect(isPinned('s3')).toBe(true); // wsB still has it
    unpinSession('s3', wsB);
    expect(isPinned('s3')).toBe(false);
  });

  it('unpinning a connection that never pinned it is a harmless no-op', () => {
    const ws = fakeWs();
    expect(() => unpinSession('never-pinned', ws)).not.toThrow();
    expect(isPinned('never-pinned')).toBe(false);
  });

  it('pinning the same session twice from the same connection is idempotent', () => {
    const ws = fakeWs();
    pinSession('s4', ws);
    pinSession('s4', ws);
    unpinSession('s4', ws);
    expect(isPinned('s4')).toBe(false); // one unpin fully releases it, no leftover ref
  });

  it('unpinAllForConnection releases every session a connection pinned, leaving others alone', () => {
    const wsA = fakeWs();
    const wsB = fakeWs();
    pinSession('s5', wsA);
    pinSession('s6', wsA);
    pinSession('s6', wsB); // wsB also pins s6
    pinSession('s7', wsB);

    unpinAllForConnection(wsA);

    expect(isPinned('s5')).toBe(false); // only wsA had it
    expect(isPinned('s6')).toBe(true); // wsB still holds it
    expect(isPinned('s7')).toBe(true); // untouched, wsA never pinned it
  });
});

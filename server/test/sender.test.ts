import { describe, it, expect } from 'vitest';
import { AsyncLock, RingBuffer } from '../src/sender.js';

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

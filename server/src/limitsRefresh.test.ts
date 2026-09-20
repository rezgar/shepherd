import { describe, it, expect, vi } from 'vitest';

/** The /usage refresh interval is not a tuning knob — it is the leak rate.
 *
 *  Every refresh spawns a pty, and on Windows ConPTY node-pty does not release
 *  the socket handle backing it even when the child is killed and its `onExit`
 *  has been awaited (measured: exit fires in ~78ms and the handle leaks
 *  anyway). So the retirement path cannot help and the spawn rate is the only
 *  lever. At the original 5 minutes the daemon leaked ~12 handles an hour for
 *  as long as it ran; the pre-fix log shows the floor climbing 2 -> 99 across
 *  one ~8h boot.
 *
 *  These tests exist so that lowering the interval back toward 5 minutes has
 *  to be a deliberate act that updates this file, rather than a one-character
 *  edit that silently restores a leak nobody notices for hours. */

/** Reads the env var the way index.ts does, with the env set for the duration
 *  of the read. `msFromEnv` reads `process.env` when CALLED, so the variable
 *  has to still be in place at that point — restoring it before the call (the
 *  obvious shape) silently tests the default every time. */
async function readInterval(value: string | undefined): Promise<number> {
  const key = 'SHEPHERD_LIMITS_REFRESH_MS';
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    vi.resetModules();
    const { msFromEnv } = await import('./sender.js');
    return msFromEnv(key, 30 * 60_000);
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('limits refresh interval', () => {
  it('defaults to 30 minutes — 6x fewer pty spawns than the original 5', async () => {
    const ms = await readInterval(undefined);

    expect(ms).toBe(30 * 60_000);
    // Stated as a leak budget rather than a duration, because that is what it
    // actually buys: 2 leaked handles an hour instead of 12.
    expect(3_600_000 / ms).toBe(2);
  });

  it('accepts an env override for anyone who wants it tighter or looser', async () => {
    expect(await readInterval('60000')).toBe(60_000);
  });

  it('falls back to the default on a malformed value rather than polling wildly', async () => {
    // A bare Number() would yield NaN here, and setInterval(fn, NaN) fires on
    // the next tick — turning a typo into a spawn loop, which with a
    // per-spawn leak is the worst possible failure.
    expect(await readInterval('half an hour')).toBe(30 * 60_000);
  });

  it('falls back on zero and on negative values', async () => {
    expect(await readInterval('0')).toBe(30 * 60_000);
    expect(await readInterval('-5')).toBe(30 * 60_000);
  });
});

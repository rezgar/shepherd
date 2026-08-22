import { describe, it, expect, vi } from 'vitest';

/** Minimal pty stub — this file only cares about how the eviction interval is
 *  read from the environment, not about terminal behaviour. */
class StubPty {
  pid = 4242;
  private exitHandlers: (() => void)[] = [];
  onData() {
    return { dispose() {} };
  }
  onExit(cb: () => void) {
    this.exitHandlers.push(cb);
    return { dispose() {} };
  }
  write() {}
  resize() {}
  kill() {
    for (const h of this.exitHandlers) h();
  }
}

vi.mock('node-pty', () => ({ default: { spawn: () => new StubPty() } }));
vi.mock('./claudeExecutable.js', () => ({ resolveClaudeExecutable: () => 'claude-stub' }));

// Set BEFORE importing: the module reads its intervals once, at import time.
// A bare Number() would turn this into NaN, and `x <= NaN` is false — so the
// sweep would stop skipping and close every live pty on its first pass. A
// typo in an env var must not silently kill the operator's sessions.
process.env.SHEPHERD_IDLE_EVICT_MS = 'ten-minutes-please';

const { attachTerminal, evictIdlePtys, livePtyCount } = await import('./sender.js');

describe('malformed eviction-interval env values fall back instead of poisoning the sweep', () => {
  it('keeps the default idle window when the override is not a number', async () => {
    const res = await attachTerminal('env-guard', 'C:/repo', { readyState: 1, send: () => {} });
    expect(res.ok).toBe(true);
    const readyAt = Date.now();
    expect(livePtyCount()).toBe(1);

    // One minute of idleness. Under the default 10-minute window this session
    // stays. With NaN it would be closed immediately.
    expect(evictIdlePtys(readyAt + 60_000)).toEqual([]);
    expect(livePtyCount()).toBe(1);

    // And the default is genuinely still in force, not merely "never evicts".
    expect(evictIdlePtys(readyAt + 11 * 60_000)).toEqual(['env-guard']);
  });
});

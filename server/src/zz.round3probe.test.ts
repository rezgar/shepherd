import { describe, it, expect, vi } from 'vitest';

class FakePty {
  static instances: FakePty[] = [];
  pid: number;
  exited = false;
  private dataHandlers: ((c: string) => void)[] = [];
  private exitHandlers: (() => void)[] = [];
  constructor(pid: number) {
    this.pid = pid;
    FakePty.instances.push(this);
  }
  onData(cb: (c: string) => void) {
    this.dataHandlers.push(cb);
    return { dispose() {} };
  }
  onExit(cb: () => void) {
    if (this.exited) cb();
    else this.exitHandlers.push(cb);
    return { dispose() {} };
  }
  write(s: string) {
    if (s === '/exit\r') this.kill();
  }
  resize() {}
  kill() {
    if (this.exited) return;
    this.exited = true;
    for (const h of this.exitHandlers) h();
  }
}

let nextPid = 5000;
vi.mock('node-pty', () => ({ default: { spawn: () => new FakePty(nextPid++) } }));
vi.mock('./claudeExecutable.js', () => ({ resolveClaudeExecutable: () => 'claude-stub' }));

const { attachTerminal, ensureSessionLive } = await import('./sender.js');
const { restoreSessions } = await import('./restore.js');

const ws = { readyState: 1, send: () => {} };

describe('ROUND 3 PROBE: what does restore report for an already-live session?', () => {
  it('logs and counts it as "restored" even though it did nothing', async () => {
    const id = 'client-got-there-first';

    // The operator's client attaches during the multi-minute restore window,
    // after the live-session pre-flight snapshot was taken.
    await attachTerminal(id, 'C:/repo', ws);

    const lines: string[] = [];
    const out = await restoreSessions([{ sessionId: id, cwd: 'C:/repo', lastActivity: Date.now() - 3_600_000 }], {
      // The pre-flight snapshot predates the attach, so it does not know.
      listLiveSessionIds: async () => new Set<string>(),
      exists: async () => true,
      spawn: ensureSessionLive,
      log: (m) => lines.push(m),
    });

    console.log('PROBE outcome.restored   =', JSON.stringify(out.restored));
    console.log('PROBE outcome.alreadyLive=', JSON.stringify(out.alreadyLive));
    for (const l of lines) console.log('PROBE log |', l);

    // It reports a restore it did not perform.
    expect(out.restored).toEqual([id]);
    expect(out.alreadyLive).toEqual([]);
    expect(lines.some((l) => l.includes('restored'))).toBe(true);
  });
});

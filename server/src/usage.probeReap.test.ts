import { describe, it, expect, beforeEach, vi } from 'vitest';

/** A pty that separates "was signalled" from "was reaped", which is the whole
 *  distinction this bug turned on. node-pty releases the handle backing the
 *  pty when it reaps the child and fires onExit — `kill()` alone only sends
 *  the signal, so a probe that returns without awaiting onExit abandons the
 *  handle. `exitDelayMs` models that gap; `neverExits` models a child that
 *  refuses to die at all. */
class FakePty {
  static instances: FakePty[] = [];
  static exitDelayMs = 0;
  static neverExits = false;

  pid: number;
  killed = false;
  reaped = false;
  /** Exit listeners registered BEFORE kill() was called. The ordering bug —
   *  registering onExit after the kill — is invisible unless the test can see
   *  which side of the kill each listener arrived on. */
  handlersAtKill = -1;
  private exitHandlers: (() => void)[] = [];
  private dataHandlers: ((c: string) => void)[] = [];

  constructor(pid: number) {
    this.pid = pid;
    FakePty.instances.push(this);
  }
  onData(cb: (c: string) => void) {
    this.dataHandlers.push(cb);
    // Hand the probe a panel it can parse straight away. Without this the
    // read waits out its full multi-second budget on every test, which buries
    // the thing under test (how the pty is retired) in unrelated latency.
    setTimeout(() => {
      cb('Current session 42% used\r\nResets 7:50am\r\nCurrent week 13% used\r\nResets Jul 23, 3am\r\n');
    }, 0).unref?.();
    return { dispose() {} };
  }
  onExit(cb: () => void) {
    if (this.reaped) cb();
    else this.exitHandlers.push(cb);
    return { dispose() {} };
  }
  write() {}
  resize() {}
  kill() {
    if (this.killed) return;
    this.killed = true;
    this.handlersAtKill = this.exitHandlers.length;
    if (FakePty.neverExits) return;
    const fire = () => {
      this.reaped = true;
      for (const h of this.exitHandlers) h();
    };
    if (FakePty.exitDelayMs > 0) setTimeout(fire, FakePty.exitDelayMs).unref?.();
    else fire();
  }
}

let nextPid = 500;
vi.mock('node-pty', () => ({
  default: { spawn: () => new FakePty(nextPid++) },
}));
vi.mock('./claudeExecutable.js', () => ({ resolveClaudeExecutable: () => 'claude-stub' }));
// cleanEnv is imported from sender.js alongside resolveClaudeExecutable;
// stubbing it keeps this test off sender's much heavier module graph.
vi.mock('./sender.js', () => ({
  resolveClaudeExecutable: () => 'claude-stub',
  cleanEnv: () => ({}),
}));
// The probe writes and then deletes transcripts; neither belongs in a unit test.
vi.mock('node:fs', () => ({
  mkdirSync: () => undefined,
  readdirSync: () => [],
  unlinkSync: () => undefined,
}));

const { computeLimits } = await import('./usage.js');

beforeEach(() => {
  FakePty.instances = [];
  FakePty.exitDelayMs = 0;
  FakePty.neverExits = false;
});

describe('the /usage probe releases its pty handle (#133)', () => {
  it('waits for the pty to actually be reaped, not merely signalled', async () => {
    // The real gap between kill() and onExit. Before the fix, computeLimits
    // resolved inside this window and left the handle behind — one per
    // five-minute refresh, forever.
    FakePty.exitDelayMs = 40;

    await computeLimits();

    const probe = FakePty.instances[0];
    expect(probe).toBeDefined();
    expect(probe.killed).toBe(true);
    expect(probe.reaped).toBe(true);
  }, 15_000);

  it('registers its exit listener before killing, so an instant exit is not missed', async () => {
    // A process that dies the moment it is signalled fires its exit before a
    // listener registered afterwards could ever hear it — that probe would
    // then wait out the full timeout for an event already gone by.
    FakePty.exitDelayMs = 0;

    await computeLimits();

    expect(FakePty.instances[0].handlersAtKill).toBeGreaterThan(0);
  }, 15_000);

  it('gives up on a probe that never exits instead of wedging the refresh loop', async () => {
    FakePty.neverExits = true;

    // Resolving at all is the assertion: an unbounded wait here would hang
    // the five-minute refresh forever. vitest's own timeout is the backstop.
    await expect(computeLimits()).resolves.toBeDefined();
    expect(FakePty.instances[0].killed).toBe(true);
  }, 20_000);

  it('still kills and reaps the probe when reading the panel throws', async () => {
    // The pre-existing guarantee this fix must not regress: the kill lives in
    // a finally precisely so a throw mid-read cannot strand a whole `claude`
    // process (which is what the multi-day-old orphans turned out to be).
    // Awaiting the reap must happen on that path too, or a failing probe
    // leaks the same handle a succeeding one used to.
    FakePty.exitDelayMs = 10;
    // onData is the first thing readUsagePanel touches after spawning, so
    // throwing from it aborts the read before any panel parsing happens.
    const onData = vi.spyOn(FakePty.prototype, 'onData').mockImplementation(() => {
      throw new Error('panel read blew up');
    });

    try {
      await expect(computeLimits()).rejects.toThrow('panel read blew up');
    } finally {
      onData.mockRestore();
    }

    const probe = FakePty.instances[0];
    expect(probe.killed).toBe(true);
    expect(probe.reaped).toBe(true);
  }, 20_000);
});

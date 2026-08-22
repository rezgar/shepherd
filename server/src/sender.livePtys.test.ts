import { describe, it, expect, beforeEach, vi } from 'vitest';

/** A pty that behaves like node-pty's, with a knob for the one thing these
 *  tests care about: whether its output ever goes quiet. A spawn is only
 *  considered ready after READY_QUIET_MS of silence, so a pty that keeps
 *  chattering stays stuck in that wait — which is precisely the window the
 *  old code left a process untracked in. */
class FakePty {
  static instances: FakePty[] = [];
  pid: number;
  exited = false;
  written: string[] = [];
  private dataHandlers: ((c: string) => void)[] = [];
  private exitHandlers: (() => void)[] = [];
  private chatter?: NodeJS.Timeout;

  constructor(pid: number, neverQuiet = false) {
    this.pid = pid;
    FakePty.instances.push(this);
    if (neverQuiet) {
      // Emit continuously so waitForPtyQuiet never sees its quiet window.
      this.chatter = setInterval(() => this.emit('.'), 50);
      this.chatter.unref?.();
    }
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
  emit(chunk: string) {
    for (const h of this.dataHandlers) h(chunk);
  }
  write(s: string) {
    this.written.push(s);
    if (s === '/exit\r') this.kill(); // the real REPL exits on this
  }
  resize() {}
  kill() {
    if (this.exited) return;
    this.exited = true;
    if (this.chatter) clearInterval(this.chatter);
    for (const h of this.exitHandlers) h();
  }
}

let nextPid = 1000;
let spawnNeverQuiet = false;

vi.mock('node-pty', () => ({
  default: {
    spawn: () => new FakePty(nextPid++, spawnNeverQuiet),
  },
}));

vi.mock('./claudeExecutable.js', () => ({
  resolveClaudeExecutable: () => 'claude-stub',
}));

const {
  attachTerminal,
  evictIdlePtys,
  livePtyCount,
  noteTranscriptActivity,
  shutdownAllSessions,
  ensureSessionLive,
  isAwaitingFirstTouch,
  writeTermInput,
} = await import('./sender.js');

const IDLE_EVICT_MS = 10 * 60_000;
const ws = { readyState: 1, send: () => {} };

/** Session ids must be unique per test: an in-flight spawn is memoised by
 *  session id, so reusing one would hand back the previous test's promise
 *  instead of spawning anything. */
let seq = 0;
const sid = (name: string) => `${name}-${seq++}`;

beforeEach(() => {
  // Kill directly rather than via shutdownAllSessions — each graceful close
  // costs a real 2.5s grace window, and every pty's exit handler already
  // deregisters it.
  for (const p of FakePty.instances) p.kill();
  FakePty.instances = [];
  spawnNeverQuiet = false;
});

describe('live pty registry (CoD 7)', () => {
  it('tracks a pty from the moment it spawns, before the spawn is ready', async () => {
    spawnNeverQuiet = true; // this attach will never resolve
    void attachTerminal(sid('never-ready'), 'C:/repo', ws);

    // Long enough for the spawn to happen, nowhere near long enough for it to
    // be declared ready (READY_QUIET_MS is 900ms, and this pty never quiets).
    await new Promise((r) => setTimeout(r, 100));

    expect(livePtyCount()).toBe(1);
    expect(FakePty.instances).toHaveLength(1);
  });

  it('reaps a pty that never finished starting, ageing it from its spawn time', async () => {
    spawnNeverQuiet = true;
    const id = sid('never-ready');
    const spawnedAt = Date.now();
    void attachTerminal(id, 'C:/repo', ws);
    await new Promise((r) => setTimeout(r, 100));
    expect(livePtyCount()).toBe(1);

    // This pty never became ready, so it never reached readyPtys and has no
    // lastActivity to consult — it ages from the moment it spawned instead.
    // Exactly the leak the old sweep could not see: that sweep walked only
    // readyPtys, so a process stuck here was invisible to it forever.
    const closed = evictIdlePtys(spawnedAt + IDLE_EVICT_MS + 1);

    expect(closed).toEqual([id]);
    expect(livePtyCount()).toBe(0);
  });

  it('leaves a not-yet-idle unidentified pty alone', async () => {
    spawnNeverQuiet = true;
    const spawnedAt = Date.now();
    void attachTerminal(sid('never-ready'), 'C:/repo', ws);
    await new Promise((r) => setTimeout(r, 100));

    expect(evictIdlePtys(spawnedAt + IDLE_EVICT_MS - 1000)).toEqual([]);
    expect(livePtyCount()).toBe(1);
  });

  it('shuts down every pty it holds, identified or not', { timeout: 20_000 }, async () => {
    spawnNeverQuiet = true;
    void attachTerminal(sid('a'), 'C:/repo/a', ws);
    void attachTerminal(sid('b'), 'C:/repo/b', ws);
    await new Promise((r) => setTimeout(r, 100));
    expect(livePtyCount()).toBe(2);

    await shutdownAllSessions();

    expect(livePtyCount()).toBe(0);
    expect(FakePty.instances.every((p) => p.exited)).toBe(true);
  });
});

describe('transcript activity keeps a session alive (CoD 8)', () => {
  it('evicts an idle session that nothing has touched', async () => {
    const id = sid('idle-one');
    const res = await attachTerminal(id, 'C:/repo', ws);
    expect(res.ok).toBe(true);
    const readyAt = Date.now();

    const closed = evictIdlePtys(readyAt + IDLE_EVICT_MS + 1);

    expect(closed).toEqual([id]);
    expect(livePtyCount()).toBe(0);
  });

  it('spares a session whose transcript changed, with no input through Shepherd', async () => {
    const id = sid('remote-one');
    const res = await attachTerminal(id, 'C:/repo', ws);
    expect(res.ok).toBe(true);
    const readyAt = Date.now();

    // The session is being driven from phone or web: its turns land in the
    // transcript file but never pass through Shepherd's own input path.
    noteTranscriptActivity(id, readyAt + IDLE_EVICT_MS);

    // The very same eviction pass that killed the untouched session above.
    const closed = evictIdlePtys(readyAt + IDLE_EVICT_MS + 1);

    expect(closed).toEqual([]);
    expect(livePtyCount()).toBe(1);
  });

  it('ignores transcript activity for a session it does not hold', () => {
    expect(() => noteTranscriptActivity('not-a-session', Date.now())).not.toThrow();
  });
});

/** Without this the feature undoes itself: a restored session is idle by
 *  design, so the ordinary rule would close it 10-15 minutes after boot and
 *  the operator — who is remote, hours away, and cannot click anything —
 *  would find nothing to connect to. Found by an independent review of the
 *  first implementation, which shipped the activity tracking but not the
 *  exemption. */
describe('a restored session survives until someone reaches it (CoD 9)', () => {
  it('is not evicted while still untouched, however long it sits', async () => {
    const id = sid('restored');
    await ensureSessionLive(id, 'C:/repo');
    const readyAt = Date.now();
    expect(isAwaitingFirstTouch(id)).toBe(true);

    // Hours later — the operator is still asleep on the other side of the
    // country. The session must still be there.
    expect(evictIdlePtys(readyAt + 6 * 3_600_000)).toEqual([]);
    expect(livePtyCount()).toBe(1);
  });

  it('is not kept alive by its own resume writing to the transcript', async () => {
    const id = sid('restored');
    await ensureSessionLive(id, 'C:/repo');
    const readyAt = Date.now();

    // `claude --resume` appends to the transcript as it starts up (confirmed
    // against a real restore), so transcript activity must NOT count as the
    // operator arriving — otherwise the exemption lifts seconds after boot.
    noteTranscriptActivity(id, readyAt + 1000);

    expect(isAwaitingFirstTouch(id)).toBe(true);
    expect(evictIdlePtys(readyAt + 6 * 3_600_000)).toEqual([]);
  });

  it('goes back under the normal idle rule once a terminal attaches', async () => {
    const id = sid('restored');
    await ensureSessionLive(id, 'C:/repo');
    expect(isAwaitingFirstTouch(id)).toBe(true);

    await attachTerminal(id, 'C:/repo', ws);
    const touchedAt = Date.now();

    expect(isAwaitingFirstTouch(id)).toBe(false);
    expect(evictIdlePtys(touchedAt + IDLE_EVICT_MS + 1)).toEqual([id]);
  });

  it('goes back under the normal idle rule once input is sent', async () => {
    const id = sid('restored');
    await ensureSessionLive(id, 'C:/repo');
    await writeTermInput(id, 'C:/repo', 'hello', undefined);
    const touchedAt = Date.now();

    expect(isAwaitingFirstTouch(id)).toBe(false);
    expect(evictIdlePtys(touchedAt + IDLE_EVICT_MS + 1)).toEqual([id]);
  });

  it('drops the exemption when the session is closed, leaving nothing behind', async () => {
    const id = sid('restored');
    await ensureSessionLive(id, 'C:/repo');
    await shutdownAllSessions();
    expect(isAwaitingFirstTouch(id)).toBe(false);
  });
});

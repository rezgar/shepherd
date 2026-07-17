import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentModel } from '../src/types.js';
import type { Limits } from '../src/usage.js';
import {
  activitySignature,
  isNearLimit,
  decideRefresh,
  sanitizeSummary,
  summaryCliArgs,
  SummaryManager,
  SUMMARY_MODEL,
} from '../src/summarize.js';

// --- fixtures ---------------------------------------------------------------

let seq = 0;
function mk(state: AgentModel['state'], over: Partial<AgentModel> = {}): AgentModel {
  return {
    sessionId: over.sessionId ?? `s${seq++}`,
    product: 'p',
    repoPath: '/p',
    cwd: '/p',
    branch: 'main',
    label: 'main',
    title: null,
    name: 'p',
    state,
    stage: 'implementation',
    status: 'wiring the summarizer',
    activity: 'editing summarize.ts',
    action: null,
    lastActivity: 1000,
    createdAt: 0,
    queued: 0,
    file: '/does/not/matter.jsonl',
    ...over,
  };
}

const limits = (session: number | null, weekly: number | null = null): Limits => ({
  session: session == null ? null : { percent: session, resetMs: 0 },
  weekly: weekly == null ? null : { percent: weekly, resetMs: 0 },
});

// Flush all pending microtasks (the manager resolves refreshes via Promise chains).
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A manager wired to a counting fake transport and a hand-cranked clock. */
function harness(opts: { fail?: boolean; maxConcurrent?: number; throttleMs?: number } = {}) {
  let clock = 100_000;
  let calls = 0;
  let updates = 0;
  const runLlm = async (_prompt: string) => {
    calls++;
    if (opts.fail) throw new Error('boom');
    return 'reconnecting the relay';
  };
  const mgr = new SummaryManager({
    runLlm,
    now: () => clock,
    onUpdate: () => {
      updates++;
    },
    buildPrompt: async () => 'PROMPT',
    throttleMs: opts.throttleMs ?? 25_000,
    maxConcurrent: opts.maxConcurrent ?? 2,
  });
  return {
    mgr,
    calls: () => calls,
    updates: () => updates,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// --- pure helpers -----------------------------------------------------------

describe('activitySignature', () => {
  it('changes when the momentary activity changes, holds when it does not', () => {
    const a = mk('working', { status: 'task', activity: 'editing a.ts' });
    const b = mk('working', { status: 'task', activity: 'editing a.ts' });
    const c = mk('working', { status: 'task', activity: 'running tests' });
    expect(activitySignature(a)).toBe(activitySignature(b));
    expect(activitySignature(a)).not.toBe(activitySignature(c));
  });
});

describe('isNearLimit', () => {
  it('is false with no limits and true once either bar is at/above the threshold', () => {
    expect(isNearLimit(null)).toBe(false);
    expect(isNearLimit(limits(10, 20))).toBe(false);
    expect(isNearLimit(limits(96, 10))).toBe(true);
    expect(isNearLimit(limits(10, 99))).toBe(true);
  });
});

describe('sanitizeSummary', () => {
  it('keeps the first line, strips quotes and trailing period, caps length', () => {
    expect(sanitizeSummary('"Reconnecting the relay."')).toBe('Reconnecting the relay');
    expect(sanitizeSummary('Doing a thing\nsecond line')).toBe('Doing a thing');
    expect(sanitizeSummary('   ')).toBe('');
    expect(sanitizeSummary('x'.repeat(200)).length).toBeLessThanOrEqual(120);
  });
});

describe('summaryCliArgs (transport is the local CLI, no API key)', () => {
  it('builds a headless `-p` call against a fast model', () => {
    const args = summaryCliArgs('hello');
    expect(args).toContain('-p');
    expect(args).toContain('hello');
    expect(args).toEqual(expect.arrayContaining(['--model', SUMMARY_MODEL]));
    // no api-key flags anywhere
    expect(args.join(' ')).not.toMatch(/api[-_]?key/i);
  });
});

describe('decideRefresh', () => {
  const opts = { throttleMs: 25_000, nearLimit: false, slotFree: true };

  it('summarizes a working session on first sight', () => {
    expect(decideRefresh(undefined, mk('working'), 1_000, opts)).toBe(true);
  });

  it('does not summarize needs-you or error sessions', () => {
    expect(decideRefresh(undefined, mk('needs-you'), 1_000, opts)).toBe(false);
    expect(decideRefresh(undefined, mk('error'), 1_000, opts)).toBe(false);
  });

  it('holds when nothing changed within the throttle window', () => {
    const a = mk('working');
    const prev = { sig: activitySignature(a), text: 'x', ts: 1_000, inFlight: false, lastState: 'working' as const, idleFinalized: false };
    expect(decideRefresh(prev, a, 1_000 + 10_000, opts)).toBe(false); // <25s, same sig
  });

  it('refreshes once the work advanced and the window elapsed', () => {
    const a = mk('working', { activity: 'running tests' });
    const prev = { sig: 'old sig', text: 'x', ts: 1_000, inFlight: false, lastState: 'working' as const, idleFinalized: false };
    expect(decideRefresh(prev, a, 1_000 + 30_000, opts)).toBe(true);
  });

  it('holds when the work advanced but the throttle window has NOT elapsed', () => {
    // Isolates the throttle clause: the signature differs (sig gate passes),
    // so only `now - prev.ts >= throttleMs` can block — and here it must.
    const a = mk('working', { activity: 'running tests' });
    const prev = { sig: 'old sig', text: 'x', ts: 1_000, inFlight: false, lastState: 'working' as const, idleFinalized: false };
    expect(decideRefresh(prev, a, 1_000 + 5_000, opts)).toBe(false); // changed sig, but 5s < 25s
  });

  it('never refreshes when near a limit, out of slots, or already in flight', () => {
    const a = mk('working');
    expect(decideRefresh(undefined, a, 1_000, { ...opts, nearLimit: true })).toBe(false);
    expect(decideRefresh(undefined, a, 1_000, { ...opts, slotFree: false })).toBe(false);
    const prev = { sig: '', text: null, ts: 0, inFlight: true, lastState: 'working' as const, idleFinalized: false };
    expect(decideRefresh(prev, a, 1_000, opts)).toBe(false);
  });

  it('does one final summary on working→idle, then never again', () => {
    const idle = mk('idle');
    const wasWorking = { sig: 's', text: 'x', ts: 0, inFlight: false, lastState: 'working' as const, idleFinalized: false };
    expect(decideRefresh(wasWorking, idle, 100_000, opts)).toBe(true);
    const finalized = { ...wasWorking, idleFinalized: true };
    expect(decideRefresh(finalized, idle, 100_000, opts)).toBe(false);
    const stayedIdle = { ...wasWorking, lastState: 'idle' as const };
    expect(decideRefresh(stayedIdle, idle, 100_000, opts)).toBe(false);
  });
});

// --- manager integration ----------------------------------------------------

describe('SummaryManager.attach', () => {
  beforeEach(() => {
    seq = 0;
  });

  it('stamps a summary onto a working card after the refresh lands', async () => {
    const h = harness();
    const a = mk('working', { sessionId: 'w' });
    h.mgr.attach([a], null);
    await flush();
    // a later snapshot (fresh object, same id) picks the cached summary up
    const a2 = mk('working', { sessionId: 'w' });
    h.mgr.attach([a2], null);
    expect(a2.summary).toBe('reconnecting the relay');
    expect(h.updates()).toBeGreaterThan(0);
  });

  it('leaves needs-you and error cards untouched (no call, summary null)', async () => {
    const h = harness();
    const q = mk('needs-you', { sessionId: 'q' });
    const e = mk('error', { sessionId: 'e' });
    h.mgr.attach([q, e], null);
    await flush();
    expect(h.calls()).toBe(0);
    expect(q.summary ?? null).toBeNull();
    expect(e.summary ?? null).toBeNull();
  });

  it('never blanks or throws when the model call fails — card falls back', async () => {
    const h = harness({ fail: true });
    const a = mk('working', { sessionId: 'w' });
    expect(() => h.mgr.attach([a], null)).not.toThrow();
    await flush();
    const a2 = mk('working', { sessionId: 'w' });
    h.mgr.attach([a2], null);
    expect(a2.summary ?? null).toBeNull(); // no summary → card uses status
  });

  it('does not spend a call while a session grinds on the same step', async () => {
    const h = harness();
    const a = mk('working', { sessionId: 'w', activity: 'running long build' });
    h.mgr.attach([a], null);
    await flush();
    expect(h.calls()).toBe(1);
    // same signature, well past the throttle → still no second call
    h.advance(60_000);
    h.mgr.attach([mk('working', { sessionId: 'w', activity: 'running long build' })], null);
    await flush();
    expect(h.calls()).toBe(1);
  });

  it('refreshes again once the work advances and the window has elapsed', async () => {
    const h = harness();
    h.mgr.attach([mk('working', { sessionId: 'w', activity: 'reading code' })], null);
    await flush();
    expect(h.calls()).toBe(1);
    h.advance(30_000);
    h.mgr.attach([mk('working', { sessionId: 'w', activity: 'running tests' })], null);
    await flush();
    expect(h.calls()).toBe(2);
  });

  it('pauses entirely when usage is near a limit', async () => {
    const h = harness();
    const a = mk('working', { sessionId: 'w' });
    h.mgr.attach([a], limits(97));
    await flush();
    expect(h.calls()).toBe(0);
    expect(a.summary ?? null).toBeNull();
  });

  it('summarizes a finished session exactly once, then rests', async () => {
    const h = harness();
    // working first, so the manager sees the working→idle transition
    h.mgr.attach([mk('working', { sessionId: 'w' })], null);
    await flush();
    expect(h.calls()).toBe(1);
    // now idle — the working→idle transition earns one final summary
    h.mgr.attach([mk('idle', { sessionId: 'w' })], null);
    await flush();
    expect(h.calls()).toBe(2);
    // the final summary shows on the next snapshot ("where it left off")
    const idle2 = mk('idle', { sessionId: 'w' });
    h.mgr.attach([idle2], null);
    expect(idle2.summary).toBe('reconnecting the relay');
    // staying idle does not summarize again
    await flush();
    expect(h.calls()).toBe(2);
  });

  it('caps concurrent calls so many working sessions do not fork many CLIs', async () => {
    const h = harness({ maxConcurrent: 2 });
    const agents = [mk('working', { sessionId: 'a' }), mk('working', { sessionId: 'b' }), mk('working', { sessionId: 'c' })];
    h.mgr.attach(agents, null);
    await flush();
    expect(h.calls()).toBe(2); // third waited for a free slot
  });

  it('only sets summary — state, stage and activity are untouched', async () => {
    const h = harness();
    const a = mk('working', { sessionId: 'w', state: 'working', stage: 'testing', activity: 'running vitest' });
    h.mgr.attach([a], null);
    await flush();
    expect(a.state).toBe('working');
    expect(a.stage).toBe('testing');
    expect(a.activity).toBe('running vitest');
  });
});

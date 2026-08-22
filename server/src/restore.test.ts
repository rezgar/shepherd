import { describe, it, expect } from 'vitest';
import {
  selectRestoreTargets,
  restoreSessions,
  RESTORE_WINDOW_MS,
  RESTORE_MAX,
  type RestoreTarget,
} from './restore.js';
import type { AgentModel } from './types.js';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

function agent(sessionId: string, agoHours: number, cwd = `C:/repo/${sessionId}`): AgentModel {
  return {
    sessionId,
    product: 'repo',
    repoPath: 'C:/repo',
    cwd,
    branch: null,
    label: sessionId,
    title: null,
    name: sessionId,
    state: 'idle',
    stage: 'unknown',
    status: '',
    activity: '',
    action: null,
    lastActivity: NOW - agoHours * HOUR,
    createdAt: NOW - agoHours * HOUR,
    queued: 0,
    file: `C:/projects/${sessionId}.jsonl`,
  };
}

/** A restore that records the order and overlap of its spawns. */
function recordingDeps(overrides: Partial<Parameters<typeof restoreSessions>[1]> = {}) {
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    order,
    peakConcurrency: () => maxInFlight,
    deps: {
      listLiveSessionIds: async () => new Set<string>(),
      exists: async () => true,
      spawn: async (sessionId: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        order.push(sessionId);
        inFlight -= 1;
      },
      ...overrides,
    },
  };
}

describe('selectRestoreTargets', () => {
  it('keeps only sessions active inside the window (CoD 1, CoD 2)', () => {
    const picked = selectRestoreTargets([agent('fresh', 1), agent('stale', 30)], NOW);
    expect(picked.map((t) => t.sessionId)).toEqual(['fresh']);
  });

  it('treats the window edge as inclusive, and anything past it as out', () => {
    const onEdge = agent('edge', 0);
    onEdge.lastActivity = NOW - RESTORE_WINDOW_MS;
    const justPast = agent('past', 0);
    justPast.lastActivity = NOW - RESTORE_WINDOW_MS - 1;
    const picked = selectRestoreTargets([onEdge, justPast], NOW);
    expect(picked.map((t) => t.sessionId)).toEqual(['edge']);
  });

  it('orders most-recent-first and caps at the maximum (CoD 1)', () => {
    // 15 sessions inside the window, deliberately shuffled going in.
    const agents = [11, 3, 14, 1, 7, 5, 12, 2, 9, 4, 13, 6, 15, 8, 10].map((h) =>
      agent(`s${h}`, h),
    );
    const picked = selectRestoreTargets(agents, NOW);
    expect(picked).toHaveLength(RESTORE_MAX);
    expect(picked.map((t) => t.sessionId)).toEqual([
      's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10',
    ]);
  });

  it('caps at 10 by default', () => {
    expect(RESTORE_MAX).toBe(10);
  });

  it('uses a 24 hour window by default', () => {
    expect(RESTORE_WINDOW_MS).toBe(24 * HOUR);
  });

  it('does not mutate the caller’s array', () => {
    const agents = [agent('b', 2), agent('a', 1)];
    const before = agents.map((a) => a.sessionId);
    selectRestoreTargets(agents, NOW);
    expect(agents.map((a) => a.sessionId)).toEqual(before);
  });

  it('returns nothing when every session is stale (CoD 2)', () => {
    expect(selectRestoreTargets([agent('old', 48), agent('older', 100)], NOW)).toEqual([]);
  });

  // Regression: found by the end-to-end restore test, which spawned two
  // `claude` processes for a single session. A session id is not one-to-one
  // with a transcript file — classification reads the id out of the file's
  // content, so a forked or copied transcript carries the same id — and
  // restoring both collides two `--resume` processes on one transcript.
  it('collapses duplicate session ids to one target (CoD 4)', () => {
    const a = agent('dup', 3, 'C:/repo/old-copy');
    const b = agent('dup', 1, 'C:/repo/current');
    const picked = selectRestoreTargets([a, b], NOW);
    expect(picked).toHaveLength(1);
    expect(picked[0].sessionId).toBe('dup');
  });

  it('keeps the freshest sighting of a duplicated session id', () => {
    const stale = agent('dup', 5, 'C:/repo/stale');
    const fresh = agent('dup', 1, 'C:/repo/fresh');
    // Order in must not matter.
    expect(selectRestoreTargets([stale, fresh], NOW)[0].cwd).toBe('C:/repo/fresh');
    expect(selectRestoreTargets([fresh, stale], NOW)[0].cwd).toBe('C:/repo/fresh');
  });

  it('counts unique sessions, not files, against the cap', () => {
    // 12 files, but only 6 distinct sessions — all 6 must come back.
    const agents = Array.from({ length: 12 }, (_, i) => agent(`s${i % 6}`, i + 1));
    const picked = selectRestoreTargets(agents, NOW);
    expect(picked).toHaveLength(6);
    expect(new Set(picked.map((t) => t.sessionId)).size).toBe(6);
  });
});

describe('restoreSessions', () => {
  const targets = (...ids: string[]): RestoreTarget[] =>
    ids.map((id, i) => ({ sessionId: id, cwd: `C:/repo/${id}`, lastActivity: NOW - i }));

  it('spawns each selected session', async () => {
    const { deps, order } = recordingDeps();
    const out = await restoreSessions(targets('a', 'b'), deps);
    expect(order).toEqual(['a', 'b']);
    expect(out.restored).toEqual(['a', 'b']);
  });

  it('never runs two spawns at once (CoD 5)', async () => {
    const { deps, peakConcurrency } = recordingDeps();
    await restoreSessions(targets('a', 'b', 'c', 'd', 'e'), deps);
    expect(peakConcurrency()).toBe(1);
  });

  it('spawns in the order given, most-recent first (CoD 1)', async () => {
    const { deps, order } = recordingDeps();
    await restoreSessions(targets('first', 'second', 'third'), deps);
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('skips a session that is already running (CoD 4)', async () => {
    const { deps, order } = recordingDeps({
      listLiveSessionIds: async () => new Set(['b']),
    });
    const out = await restoreSessions(targets('a', 'b', 'c'), deps);
    expect(order).toEqual(['a', 'c']);
    expect(out.alreadyLive).toEqual(['b']);
    expect(out.restored).toEqual(['a', 'c']);
  });

  it('reads the live-session registry once, not once per session (CoD 4)', async () => {
    let calls = 0;
    const { deps } = recordingDeps({
      listLiveSessionIds: async () => {
        calls += 1;
        return new Set<string>();
      },
    });
    await restoreSessions(targets('a', 'b', 'c', 'd'), deps);
    expect(calls).toBe(1);
  });

  it('still restores when the live-session registry cannot be read', async () => {
    const { deps, order } = recordingDeps({
      listLiveSessionIds: async () => {
        throw new Error('claude agents --json failed');
      },
    });
    const out = await restoreSessions(targets('a', 'b'), deps);
    expect(order).toEqual(['a', 'b']);
    expect(out.restored).toEqual(['a', 'b']);
  });

  it('skips a session whose working directory is gone, and keeps going (CoD 6)', async () => {
    const { deps, order } = recordingDeps({
      exists: async (dir: string) => !dir.endsWith('gone'),
    });
    const out = await restoreSessions(targets('a', 'gone', 'c'), deps);
    expect(order).toEqual(['a', 'c']);
    expect(out.missingCwd).toEqual(['gone']);
    expect(out.restored).toEqual(['a', 'c']);
  });

  it('records a spawn failure and still restores the rest (CoD 6)', async () => {
    const order: string[] = [];
    const out = await restoreSessions(targets('a', 'boom', 'c'), {
      listLiveSessionIds: async () => new Set<string>(),
      exists: async () => true,
      spawn: async (sessionId: string) => {
        if (sessionId === 'boom') throw new Error('pty.spawn exploded');
        order.push(sessionId);
      },
    });
    expect(order).toEqual(['a', 'c']);
    expect(out.restored).toEqual(['a', 'c']);
    expect(out.failed).toEqual([{ sessionId: 'boom', error: 'pty.spawn exploded' }]);
  });

  it('does nothing, and does not consult the registry, when there is nothing to restore', async () => {
    let consulted = false;
    const out = await restoreSessions([], {
      listLiveSessionIds: async () => {
        consulted = true;
        return new Set<string>();
      },
      spawn: async () => {
        throw new Error('should never spawn');
      },
    });
    expect(consulted).toBe(false);
    expect(out).toEqual({ restored: [], alreadyLive: [], missingCwd: [], failed: [] });
  });

  it('logs a one-line summary of what happened', async () => {
    const lines: string[] = [];
    const { deps } = recordingDeps({ listLiveSessionIds: async () => new Set(['b']) });
    await restoreSessions(targets('a', 'b'), { ...deps, log: (m: string) => lines.push(m) });
    expect(lines.at(-1)).toContain('1 restored');
    expect(lines.at(-1)).toContain('1 already running');
  });
});

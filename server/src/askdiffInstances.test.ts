import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  getOrSpawnAskdiffInstance,
  markAskdiffFocused,
  markAskdiffUnfocused,
  startAskdiffIdleEvictionSweep,
  shutdownAllAskdiffInstances,
} from './askdiffInstances.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

// A minimal stand-in for the WS connection type these functions key
// focus-tracking Sets by — only object identity matters here.
const fakeWs = () => ({ readyState: 1, send: () => {} });

describe('askdiffInstances', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shepherd-askdiff-instances-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await shutdownAllAskdiffInstances();
    rmSync(dir, { recursive: true, force: true });
  });

  it('spawns an instance and returns a listening port', async () => {
    const sessionId = randomUUID();
    const result = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.port).toBeGreaterThan(0);
  });

  it('reuses the same instance (and port) for a second call', async () => {
    const sessionId = randomUUID();
    const first = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
    const second = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
    expect(first.ok && second.ok && first.port === second.port).toBe(true);
  });

  it('shares one spawn across concurrent calls for the same not-yet-spawned session', async () => {
    const sessionId = randomUUID();
    const [a, b] = await Promise.all([
      getOrSpawnAskdiffInstance(sessionId, dir, sessionId),
      getOrSpawnAskdiffInstance(sessionId, dir, sessionId),
    ]);
    expect(a.ok && b.ok && a.port === b.port).toBe(true);
  });

  it('gives different sessions different instances (different ports)', async () => {
    const a = await getOrSpawnAskdiffInstance(randomUUID(), dir, randomUUID());
    const b = await getOrSpawnAskdiffInstance(randomUUID(), dir, randomUUID());
    expect(a.ok && b.ok && a.port !== b.port).toBe(true);
  });

  it("panel diff compares against the merge-base with main, matching the top-bar pill (#96)", async () => {
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(dir, 'add', 'tracked.ts');
    git(dir, 'commit', '-q', '-m', 'committed on branch');
    writeFileSync(
      join(dir, 'tracked.ts'),
      'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n',
    );

    const sessionId = randomUUID();
    const result = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const diff = await new Promise<{ raw: string; label?: string }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(result.port)}/ws`);
      ws.on('message', (data) => {
        const msg: unknown = JSON.parse(data.toString());
        if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'diff') {
          ws.close();
          resolve(msg as { raw: string; label?: string });
        }
      });
      ws.on('error', reject);
    });

    // A `HEAD`-only diff would show just the uncommitted `z` addition — the
    // committed `y` line only appears if the panel diffs against the
    // merge-base with `main`, not `HEAD`.
    expect(diff.raw).toContain('+export const y = 2;');
    expect(diff.raw).toContain('+export const z = 3;');
    expect(diff.label).toBe('Working tree vs main');
  });

  it('fails without leaking a temp diff directory when cwd does not exist', async () => {
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith('shepherd-askdiff-'));

    const sessionId = randomUUID();
    const result = await getOrSpawnAskdiffInstance(
      sessionId,
      join(dir, 'this-path-does-not-exist'),
      sessionId,
    );
    expect(result.ok).toBe(false);

    const after = readdirSync(tmpdir()).filter((f) => f.startsWith('shepherd-askdiff-'));
    expect(after.length).toBe(before.length);
  });

  it('evicts an unfocused instance after the idle window, respawning fresh on the next call', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = randomUUID();
      const first = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
      expect(first.ok).toBe(true);

      startAskdiffIdleEvictionSweep();
      // Past both the 10-minute idle window and a 5-minute sweep tick.
      await vi.advanceTimersByTimeAsync(16 * 60_000);

      const second = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
      expect(second.ok).toBe(true);
      expect(first.ok && second.ok && first.port !== second.port).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never evicts a focused instance, even past the idle window', async () => {
    vi.useFakeTimers();
    try {
      const sessionId = randomUUID();
      const ws = fakeWs();
      const first = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
      expect(first.ok).toBe(true);
      markAskdiffFocused(sessionId, ws);

      startAskdiffIdleEvictionSweep();
      await vi.advanceTimersByTimeAsync(16 * 60_000);

      const second = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
      expect(first.ok && second.ok && first.port === second.port).toBe(true);

      markAskdiffUnfocused(sessionId, ws);
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the least-recently-active non-focused instance when spawning would exceed the concurrency cap', async () => {
    // Matches MAX_CONCURRENT_INSTANCES in askdiffInstances.ts. Regression
    // test for opening session after session accumulating unbounded live
    // instances — each one its own chokidar watcher + diff computation,
    // with no ceiling on how many run concurrently through the daemon.
    const CAP = 4;
    const sessions = Array.from({ length: CAP }, () => randomUUID());
    const ports: number[] = [];
    for (const sessionId of sessions) {
      const result = await getOrSpawnAskdiffInstance(sessionId, dir, sessionId);
      expect(result.ok).toBe(true);
      if (result.ok) ports.push(result.port);
    }

    // A 5th, unfocused session in the same project pushes past the cap.
    const extra = await getOrSpawnAskdiffInstance(randomUUID(), dir, randomUUID());
    expect(extra.ok).toBe(true);

    // The least-recently-active session (the first spawned) should have
    // been evicted to make room — its next request respawns on a new port
    // rather than reusing the original.
    const respawned = await getOrSpawnAskdiffInstance(sessions[0], dir, sessions[0]);
    expect(respawned.ok).toBe(true);
    expect(respawned.ok && respawned.port !== ports[0]).toBe(true);
  });
});

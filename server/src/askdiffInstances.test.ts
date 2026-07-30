import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer as startAskdiffServer, type ServerHandle } from '../vendor/askdiff/server/index.js';
import { captureWorkingTreeDiff } from '../vendor/askdiff/server/util/working-tree-diff.js';
import { createAskdiffUiHttpServer } from '../vendor/askdiff/static-server.js';
import { resolveDiffBase } from './diffStat.js';

// Mirrors sender.ts's PTY idle window/sweep cadence — same "how long is
// this worth keeping warm after the user stops looking at it" call.
const IDLE_EVICT_MS = 10 * 60_000;
const EVICT_SWEEP_MS = 5 * 60_000;

interface AskdiffInstance {
  handle: ServerHandle;
  httpServer: HttpServer;
  port: number;
  diffDir: string;
  lastActivity: number;
}

/** Live askdiff instances, one per session — the vendored diff-server
 *  process (in-process, not a subprocess: askdiff's server is just a
 *  function call) backing that session's diff panel. */
const instances = new Map<string, AskdiffInstance>();
/** In-flight spawns, so two rapid focus events for the same session don't
 *  each start their own instance and leak a port. */
const spawning = new Map<string, Promise<AskdiffInstance>>();

/** The minimal shape needed from a WS connection — same trimmed structural
 *  type sender.ts uses for its own pin-tracking, so this file doesn't need
 *  to import the `ws` package just to key a Set by connection identity. */
interface FocusWsLike {
  readyState: number;
  send(data: string): void;
}

/** Sessions currently focused (for diff-panel purposes) by at least one
 *  connection — exempt from idle eviction while so. Ref-counted by
 *  connection (a Set, not a single id): each WS connection tracks its own
 *  focused session independently (multiple browser tabs can each focus a
 *  different session), so eviction-eligibility must ask "is ANY connection
 *  still focused here", not assume a single global focus. Mirrors
 *  sender.ts's `pinnedSessions` shape exactly — deliberately a separate map
 *  from it, since that one protects PTYs for card-strip visibility, a
 *  different concern from this one's "pre-warm the diff-panel instance
 *  only for what's actually focused right now" scope. */
const focusedForAskdiff = new Map<string, Set<FocusWsLike>>();

export function markAskdiffFocused(sessionId: string, ws: FocusWsLike): void {
  let set = focusedForAskdiff.get(sessionId);
  if (!set) {
    set = new Set();
    focusedForAskdiff.set(sessionId, set);
  }
  set.add(ws);
}

export function markAskdiffUnfocused(sessionId: string, ws: FocusWsLike): void {
  const set = focusedForAskdiff.get(sessionId);
  if (!set) return;
  set.delete(ws);
  if (!set.size) focusedForAskdiff.delete(sessionId);
}

/** Release every askdiff-focus this connection holds — called on WS close,
 *  same as `unpinAllForConnection` in sender.ts, so a closed tab doesn't
 *  protect a session's instance forever. */
export function unmarkAskdiffAllForConnection(ws: FocusWsLike): void {
  for (const [sessionId, set] of focusedForAskdiff) {
    if (set.delete(ws) && !set.size) focusedForAskdiff.delete(sessionId);
  }
}

function isFocusedForAskdiff(sessionId: string): boolean {
  return !!focusedForAskdiff.get(sessionId)?.size;
}

export interface AskdiffPortResult {
  ok: true;
  port: number;
}

export interface AskdiffErrorResult {
  ok: false;
  message: string;
}

/** Returns the port of a live (or newly spawned) askdiff instance for this
 *  session, spawning one lazily if needed. Concurrent calls for the same
 *  session share one in-flight spawn rather than racing two instances (and
 *  two ports) into existence. */
export async function getOrSpawnAskdiffInstance(
  sessionId: string,
  cwd: string,
  claudeSessionId: string,
): Promise<AskdiffPortResult | AskdiffErrorResult> {
  const existing = instances.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return { ok: true, port: existing.port };
  }

  let spawnPromise = spawning.get(sessionId);
  if (!spawnPromise) {
    spawnPromise = spawnInstance(cwd, claudeSessionId);
    spawning.set(sessionId, spawnPromise);
    // A `.finally()` derived from a rejecting promise itself rejects with
    // the same error — a SEPARATE promise chain from the `await
    // spawnPromise` below, so that call's own try/catch does not also
    // cover this one. Left un-caught here, a failed spawn (confirmed live:
    // a session whose cwd no longer exists) surfaced as a Node
    // "unhandled rejection" despite the caller correctly receiving an
    // `{ok: false}` result from the awaited branch below.
    spawnPromise.finally(() => spawning.delete(sessionId)).catch(() => {});
  }

  try {
    const instance = await spawnPromise;
    instances.set(sessionId, instance);
    return { ok: true, port: instance.port };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function spawnInstance(cwd: string, claudeSessionId: string): Promise<AskdiffInstance> {
  // Every step below can fail independently (cwd vanished, port exhaustion,
  // the vendored server's own startup errors) — since the caller never gets
  // an `instances` entry to clean up on failure, THIS function is the only
  // place that can close whatever it already opened. Without this,
  // `getOrSpawnAskdiffInstance` would leak a fresh temp dir (and possibly a
  // bound port) on every retried focus of a session that can't spawn.
  const diffDir = await mkdtemp(join(tmpdir(), 'shepherd-askdiff-'));
  try {
    const diffFile = join(diffDir, 'diff');
    // Resolved once per spawn (mirrors the rest of this instance's
    // lifecycle: pre-warmed at focus time, held fixed until the instance is
    // evicted/respawned) rather than on every live refresh — the same base
    // `diffStat.ts` uses for the top-bar count, so this panel normally
    // agrees with it instead of showing its own separately-computed
    // HEAD-only diff. Since a *focused* instance is exempt from idle
    // eviction (see the sweep below), this can go stale relative to the
    // pill for as long as a single focus session runs, if `main` moves in
    // the meantime — accepted, since re-resolving on every filesystem-event
    // refresh would mean extra git calls on every keystroke-adjacent save.
    const base = await resolveDiffBase(cwd);
    // startServer's initial `sendDiff` reads this file immediately on
    // connect, before the working-tree watcher has ever fired — it must
    // already hold valid content, not just an empty placeholder.
    const initialDiff = await captureWorkingTreeDiff(cwd, base?.sha);
    await writeFile(diffFile, initialDiff, 'utf8');

    const httpServer = createAskdiffUiHttpServer();
    try {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.once('listening', () => resolve());
        httpServer.listen(0, '127.0.0.1');
      });

      const handle = await startAskdiffServer({
        cwd,
        sessionId: claudeSessionId,
        diffFile,
        diffLabel: base ? `Working tree vs ${base.branchName}` : 'Working tree',
        volatile: true,
        ...(base ? { baseRef: base.sha } : {}),
        httpServer,
        // CRITICAL: askdiff's own idle-shutdown calls `process.exit()` when
        // no WS client has been connected for `idleShutdownMs` — harmless
        // for its normal standalone-CLI-subprocess use, but fatal here:
        // this runs in-process inside the Shepherd daemon, so an
        // un-disabled timer would kill the entire daemon (every other
        // session's terminal included) a few minutes after any diff panel
        // was opened and left idle. Shepherd owns this instance's
        // lifecycle itself via the eviction sweep below.
        idleShutdownMs: 0,
      });

      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : handle.port;

      return { handle, httpServer, port, diffDir, lastActivity: Date.now() };
    } catch (err) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      throw err;
    }
  } catch (err) {
    await rm(diffDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function evict(sessionId: string, instance: AskdiffInstance): Promise<void> {
  instances.delete(sessionId);
  await instance.handle.close().catch(() => {});
  await new Promise<void>((resolve) => instance.httpServer.close(() => resolve()));
  await rm(instance.diffDir, { recursive: true, force: true }).catch(() => {});
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Evicts any askdiff instance that isn't the currently-focused session and
 *  has been idle past the window — same shape as sender.ts's
 *  `startIdleEvictionSweep`. Call once at daemon boot. */
export function startAskdiffIdleEvictionSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, instance] of instances) {
      if (isFocusedForAskdiff(sessionId)) continue;
      if (now - instance.lastActivity > IDLE_EVICT_MS) {
        void evict(sessionId, instance);
      }
    }
  }, EVICT_SWEEP_MS);
  sweepTimer.unref?.();
}

/** Closes every live askdiff instance — called from the daemon's shutdown
 *  path alongside `shutdownAllSessions()` so a restart never orphans a
 *  listening port. */
export async function shutdownAllAskdiffInstances(): Promise<void> {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  const entries = [...instances.entries()];
  instances.clear();
  await Promise.all(entries.map(([sessionId, instance]) => evict(sessionId, instance)));
}

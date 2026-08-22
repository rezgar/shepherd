import { access } from 'node:fs/promises';
import type { AgentModel } from './types.js';

/** How far back a session's last conversation activity can be and still be
 *  worth bringing back on startup. A session is only reachable from phone or
 *  web while its process is alive, so after an unattended reboot (power cut,
 *  crash) nothing is connectable until something respawns it — and the
 *  operator, being remote, has no way to click. 24h is the window that covers
 *  "what I was working on before I left" without dragging back a month of
 *  history. */
export const RESTORE_WINDOW_MS = 24 * 3_600_000;

/** Ceiling on how many sessions one restore brings back. Every live PTY
 *  streams its TUI's redraws into the daemon's single event loop and must be
 *  drained continuously (see sender.ts's drainAndTrack), so the working set
 *  is a real cost, not just memory — #71 shortened idle eviction for exactly
 *  this reason. 10 covers a realistic working set with room to spare. */
export const RESTORE_MAX = 10;

export interface RestoreTarget {
  sessionId: string;
  cwd: string;
  lastActivity: number;
}

/** The sessions a startup restore should bring back: those with real
 *  conversation activity inside the window, most recent first, capped.
 *
 *  Pure on purpose — the whole selection policy is decidable from a snapshot
 *  and a clock, with no processes, filesystem or daemon state involved, which
 *  is what makes it testable without spawning anything.
 *
 *  Subagent transcripts can never appear here: scan.ts's listSessionFiles
 *  reads only the top level of each project directory, and a session's
 *  subagents live one level deeper (`<sessionId>/subagents/*.jsonl`), so they
 *  are excluded before this ever sees them. */
export function selectRestoreTargets(
  agents: AgentModel[],
  now: number,
  windowMs: number = RESTORE_WINDOW_MS,
  max: number = RESTORE_MAX,
): RestoreTarget[] {
  // Collapse by session id first, keeping the freshest sighting. A session id
  // is NOT one-to-one with a transcript file: classification reads the id out
  // of the transcript's own content, so a forked session (the CLI's daemon
  // forks on resume) or any copied transcript yields a second file carrying
  // the same id. Restoring both would spawn two `--resume` processes for one
  // session — the collision where both run, neither errors, and their output
  // interleaves into the same transcript with no way to tell the turns apart.
  // Caught by the end-to-end restore test, which spawned two processes for
  // one session before this existed.
  const freshest = new Map<string, AgentModel>();
  for (const a of agents) {
    const prev = freshest.get(a.sessionId);
    if (!prev || a.lastActivity > prev.lastActivity) freshest.set(a.sessionId, a);
  }

  return [...freshest.values()]
    .filter((a) => now - a.lastActivity <= windowMs)
    .sort((a, b) => b.lastActivity - a.lastActivity)
    .slice(0, max)
    .map((a) => ({ sessionId: a.sessionId, cwd: a.cwd, lastActivity: a.lastActivity }));
}

export interface RestoreDeps {
  /** Session ids that already have a live process attached — from the CLI's
   *  own registry, not inferred. Spawning a second `--resume` for one of
   *  these collides: both run, neither errors, and their output interleaves
   *  into the same transcript (see sender.ts's isSessionLiveElsewhere). */
  listLiveSessionIds: () => Promise<Set<string>>;
  spawn: (sessionId: string, cwd: string) => Promise<unknown>;
  /** Whether a working directory still exists — worktrees get deleted while
   *  their transcripts stay behind. */
  exists?: (dir: string) => Promise<boolean>;
  log?: (msg: string) => void;
}

export interface RestoreOutcome {
  restored: string[];
  alreadyLive: string[];
  missingCwd: string[];
  failed: { sessionId: string; error: string }[];
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

/** Bring back each target, one at a time.
 *
 *  Strictly sequential, and that is not incidental: `pty.spawn` has been seen
 *  throwing synchronously under "several `claude` processes competing for
 *  resources at once" (sender.ts:289), and each spawn is a full CLI cold
 *  start — plugins, hooks, MCP servers — that the caller then waits out. Ten
 *  of those at once would be the exact load that breaks it.
 *
 *  Every failure is contained to its own session: a dead worktree or a spawn
 *  that throws is recorded and the loop moves on, because one broken session
 *  must not cost the operator all the others. */
export async function restoreSessions(
  targets: RestoreTarget[],
  deps: RestoreDeps,
): Promise<RestoreOutcome> {
  const log = deps.log ?? (() => {});
  const exists = deps.exists ?? dirExists;
  const outcome: RestoreOutcome = { restored: [], alreadyLive: [], missingCwd: [], failed: [] };

  if (!targets.length) {
    log('[restore] no sessions with recent activity — nothing to restore');
    return outcome;
  }

  // Name every target up front. A restore that silently brings back fewer
  // sessions than expected is the failure the operator cannot see — they are
  // remote, and an absent session looks identical to one that was never
  // selected.
  log(`[restore] ${targets.length} session(s) to restore: ${targets.map((t) => short(t.sessionId)).join(', ')}`);

  // One call for the whole run, not one per target: it shells out to the CLI.
  // Failing open (empty set) is the safe direction — the duplicate check is a
  // collision guard, and losing it costs a possible duplicate, whereas
  // treating the failure as "everything is live" would silently restore
  // nothing at all, which is the failure the operator cannot see.
  let live: Set<string>;
  try {
    live = await deps.listLiveSessionIds();
  } catch (e) {
    log(`[restore] could not read the live-session registry, continuing without it: ${msg(e)}`);
    live = new Set();
  }

  for (const t of targets) {
    if (live.has(t.sessionId)) {
      outcome.alreadyLive.push(t.sessionId);
      log(`[restore] ${short(t.sessionId)} already running — skipped`);
      continue;
    }
    if (!(await exists(t.cwd))) {
      outcome.missingCwd.push(t.sessionId);
      log(`[restore] ${short(t.sessionId)} skipped — working directory is gone: ${t.cwd}`);
      continue;
    }
    try {
      await deps.spawn(t.sessionId, t.cwd);
      outcome.restored.push(t.sessionId);
      log(`[restore] ${short(t.sessionId)} restored (${t.cwd})`);
    } catch (e) {
      outcome.failed.push({ sessionId: t.sessionId, error: msg(e) });
      log(`[restore] ${short(t.sessionId)} failed to restore: ${msg(e)}`);
    }
  }

  log(
    `[restore] done — ${outcome.restored.length} restored, ${outcome.alreadyLive.length} already running, ` +
      `${outcome.missingCwd.length} skipped (missing cwd), ${outcome.failed.length} failed`,
  );
  return outcome;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function short(sessionId: string): string {
  return sessionId.slice(0, 8);
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

// Any single git invocation gets a hard ceiling — a hung/wedged process
// (a lock file, a stalled filesystem, antivirus intercepting the spawn)
// must not block a diff-stat computation indefinitely.
const GIT_TIMEOUT_MS = 10_000;

// Untracked files are diffed individually (git has no single call that
// reports stats for N independent untracked files at once without
// mutating the index — see diffStat's own doc comment) — bounding how many
// run at once avoids spawning hundreds/thousands of processes in one burst
// for a repo with many untracked files, while still being far faster than
// doing them one at a time.
const UNTRACKED_CONCURRENCY = 16;

export interface DiffStat {
  added: number;
  removed: number;
}

// git's canonical empty-tree object — used as a last-resort diff base when
// there's no commit history yet (a brand-new repo), so "everything on disk
// is new" rather than surfacing a ref-resolution error.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

// Checked in order — the first one that resolves locally wins.
const MAIN_BRANCH_CANDIDATES = ['main', 'master'];

// In-flight computations, keyed by cwd (what the computation actually
// depends on, not any caller-specific id) — de-dupes concurrent requests
// for the same cwd into one shared git-spawning pass, mirroring
// askdiffInstances.ts's `spawning` map. THIS IS LOAD-BEARING, not an
// optimization, and lives HERE (wrapping the function itself) rather than
// being left as a caller responsibility: confirmed live in production
// (#89), a computation slower than a 3s poll interval let every
// subsequent tick kick off ANOTHER full computation on top of the one
// still running — an unbounded, compounding pile-up of concurrent git
// subprocesses that starved the daemon's event loop and crashed it within
// about a minute of real use. A caller-side guard is one omission away
// from reintroducing the exact same failure for any future caller; making
// `computeDiffStat` de-dupe itself makes that failure mode impossible to
// reintroduce by construction.
const inFlight = new Map<string, Promise<DiffStat | null>>();

/** Diff stat for `cwd`, scoped to what this branch/worktree actually
 *  contributes: everything since it forked from `main` (or `master` if
 *  there's no local `main`), plus any uncommitted/untracked changes on top.
 *  Diffs against the *merge-base* with that branch rather than its tip, so
 *  commits landed on main after this branch forked aren't counted as this
 *  branch's own changes. Falls back to comparing against `HEAD`
 *  (uncommitted changes only) when neither `main` nor `master` resolves
 *  locally.
 *
 *  Note this means the count no longer always matches the embedded askdiff
 *  panel opened by clicking the pill — that vendored instance always shows
 *  a working-tree-vs-`HEAD` diff (see working-tree-diff.ts) with no
 *  base-ref option. Accepted tradeoff (#94): the pill's job is to reflect
 *  "how much has this branch changed", not to mirror the panel exactly.
 *
 *  Deliberately uncached, unlike `repoSlug`/`issueTitle` in scan.ts: those
 *  cache static facts that don't change once known; this reflects live
 *  disk state and must be recomputed on every call — but concurrent calls
 *  for the same `cwd` share one in-flight computation rather than each
 *  spawning their own (see `inFlight` above). Returns `null` when `cwd`
 *  isn't inside a git repository (or the check itself fails) — callers
 *  should treat that as "no indicator to show", not an error. */
export function computeDiffStat(cwd: string): Promise<DiffStat | null> {
  let p = inFlight.get(cwd);
  if (!p) {
    p = computeDiffStatUncached(cwd).finally(() => inFlight.delete(cwd));
    inFlight.set(cwd, p);
  }
  return p;
}

async function computeDiffStatUncached(cwd: string): Promise<DiffStat | null> {
  const isGitRepo = await pexec('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
  })
    .then(() => true)
    .catch(() => false);
  if (!isGitRepo) return null;

  // Prefer the merge-base with main/master; fall back to `HEAD` (no such
  // branch found locally), then to the empty tree (`HEAD` itself doesn't
  // resolve yet — a brand-new repo with no commits) rather than surfacing
  // a ref-resolution error.
  const base = await resolveDiffBase(cwd);
  const tracked =
    (base !== null ? await numstat(cwd, ['diff', base, '--numstat']) : null) ??
    (await numstat(cwd, ['diff', 'HEAD', '--numstat'])) ??
    (await numstat(cwd, ['diff', EMPTY_TREE_SHA, '--numstat'])) ?? { added: 0, removed: 0 };

  const untrackedFiles = await listUntrackedFiles(cwd);
  let added = tracked.added;
  let removed = tracked.removed;

  const untrackedStats = await mapWithConcurrency(untrackedFiles, UNTRACKED_CONCURRENCY, (file) =>
    numstat(cwd, ['diff', '--no-index', '--numstat', '--', '/dev/null', file], {
      tolerateNonZeroExit: true,
    }),
  );
  for (const stat of untrackedStats) {
    if (stat === null) continue; // binary or unreadable — contributes nothing, same as git itself
    added += stat.added;
    removed += stat.removed;
  }

  return { added, removed };
}

/** Resolves the diff base as the merge-base of `HEAD` and whichever of
 *  `main`/`master` exists as a *local* branch (worktrees share refs with
 *  the main checkout, so this resolves correctly even when the branch
 *  itself is checked out elsewhere). Returns `null` — letting the caller
 *  fall back to `HEAD` — when neither branch exists locally, or `HEAD`
 *  doesn't resolve yet. */
async function resolveDiffBase(cwd: string): Promise<string | null> {
  for (const candidate of MAIN_BRANCH_CANDIDATES) {
    const exists = await pexec('git', ['rev-parse', '--verify', '--quiet', candidate], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    })
      .then(() => true)
      .catch(() => false);
    if (!exists) continue;

    const mergeBase = await pexec('git', ['merge-base', candidate, 'HEAD'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    })
      .then(({ stdout }) => stdout.trim())
      .catch(() => null);
    if (mergeBase) return mergeBase;
  }
  return null;
}

/** Maps `items` through `fn`, running at most `concurrency` calls at once —
 *  a plain worker-pool loop rather than chunked batches, so a handful of
 *  slow files can't stall an otherwise-fast batch behind them. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function listUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await pexec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.split('\0').filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/** Runs a git command expected to produce `--numstat` output (one
 *  "added\tremoved\tpath" line per file; binary files report `-` for both
 *  counts, which don't parse as numbers and are skipped rather than
 *  counted as 0 — same as git's own stat summaries never claim a line
 *  count for binary content).
 *
 *  `tolerateNonZeroExit` must be true only for `git diff --no-index`
 *  calls: those exit 1 whenever the two sides differ (always true when
 *  comparing a real file against /dev/null), which is the expected case,
 *  not a failure — its stdout is read from the error object rather than
 *  treated as one. Left false (the default) for `git diff HEAD`, where a
 *  non-zero exit means something actually went wrong (e.g. `HEAD` doesn't
 *  resolve yet) and must surface as `null` so the caller can fall back to
 *  the empty-tree diff instead of silently reporting a zero stat. */
async function numstat(
  cwd: string,
  args: string[],
  opts: { tolerateNonZeroExit?: boolean } = {},
): Promise<DiffStat | null> {
  let stdout: string;
  try {
    stdout = (await pexec('git', args, { cwd, timeout: GIT_TIMEOUT_MS })).stdout;
  } catch (err) {
    if (opts.tolerateNonZeroExit && isExecFileErrorWithStdout(err)) {
      stdout = err.stdout;
    } else {
      return null;
    }
  }

  let added = 0;
  let removed = 0;
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    const [a, r] = line.split('\t');
    const addedNum = Number(a);
    const removedNum = Number(r);
    if (Number.isFinite(addedNum)) added += addedNum;
    if (Number.isFinite(removedNum)) removed += removedNum;
  }
  return { added, removed };
}

function isExecFileErrorWithStdout(err: unknown): err is { stdout: string } {
  return (
    typeof err === 'object' && err !== null && 'stdout' in err && typeof err.stdout === 'string'
  );
}

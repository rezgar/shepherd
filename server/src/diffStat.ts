import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface DiffStat {
  added: number;
  removed: number;
}

// git's canonical empty-tree object — see working-tree-diff.ts in the
// vendored askdiff server for the matching fallback (this stat must agree
// with what that computation would show).
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Working-tree diff stat for `cwd` — uncommitted (tracked) changes plus
 *  untracked files, computed the same way the vendored askdiff instance's
 *  own working-tree capture does (tracked via `git diff HEAD`, untracked
 *  unioned in via `--no-index` against `/dev/null`), so this number always
 *  agrees with what the diff panel shows once opened.
 *
 *  Deliberately uncached, unlike `repoSlug`/`issueTitle` in scan.ts: those
 *  cache static facts that don't change once known; this reflects live
 *  disk state and must be recomputed on every call. Returns `null` when
 *  `cwd` isn't inside a git repository (or the check itself fails) —
 *  callers should treat that as "no indicator to show", not an error. */
export async function computeDiffStat(cwd: string): Promise<DiffStat | null> {
  const isGitRepo = await pexec('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    .then(() => true)
    .catch(() => false);
  if (!isGitRepo) return null;

  // `HEAD` may not resolve yet (a brand-new repo with no commits) — fall
  // back to the empty tree rather than surfacing the ref-resolution error.
  const tracked =
    (await numstat(cwd, ['diff', 'HEAD', '--numstat'])) ??
    (await numstat(cwd, ['diff', EMPTY_TREE_SHA, '--numstat'])) ?? { added: 0, removed: 0 };

  const untrackedFiles = await listUntrackedFiles(cwd);
  let added = tracked.added;
  let removed = tracked.removed;

  for (const file of untrackedFiles) {
    const stat = await numstat(
      cwd,
      ['diff', '--no-index', '--numstat', '--', '/dev/null', file],
      { tolerateNonZeroExit: true },
    );
    if (stat === null) continue; // binary or unreadable — contributes nothing, same as git itself
    added += stat.added;
    removed += stat.removed;
  }

  return { added, removed };
}

async function listUntrackedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await pexec('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
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
    stdout = (await pexec('git', args, { cwd })).stdout;
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

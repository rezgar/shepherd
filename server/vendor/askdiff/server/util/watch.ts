import { execFileSync } from "node:child_process";
import path from "node:path";
import chokidar, { type FSWatcher, type Matcher } from "chokidar";

export interface WorkingTreeWatcher {
  close: () => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 300;

/** A chokidar v4 matcher that ignores everything under `dir`, recursively.
 *
 *  chokidar v4 removed glob support from `ignored` — a string matcher is
 *  exact-equality-only (`matcher === string`), not a glob (confirmed
 *  against chokidar's own `createPattern`: only `RegExp`, a predicate
 *  function, or a `{path, recursive}` matcher object actually match a
 *  subtree). The globs this file used before matched nothing, ever —
 *  `.git` and `node_modules` were never actually excluded, and neither
 *  was anything else. */
function ignoreSubtree(dir: string): Matcher {
  return { path: dir, recursive: true };
}

/** Directories git itself considers ignored for `cwd` (`.gitignore`,
 *  `.git/info/exclude`, global excludes), as chokidar matchers that skip
 *  the whole subtree instead of recursing into it.
 *
 *  Without this (and working matchers — see `ignoreSubtree` above), a
 *  recursive chokidar watch descends into EVERY directory regardless of
 *  git's own ignore rules — confirmed live (#89): a repo with large
 *  gitignored directories nested inside it (this very repo's own dev
 *  worktrees under `.worktrees/`/`.claude/worktrees/`, each a full copy of
 *  the source tree) blew a single watch up to ~19,000 native
 *  directory-watch handles that persisted even after the watcher was
 *  closed — closing chokidar does not release them — and multiple such
 *  watches compounding across a session (one per focused-then-evicted
 *  askdiff instance) crashed the daemon.
 *
 *  `--directory` collapses an entirely-ignored directory to one entry
 *  instead of listing/recursing into its contents, so this stays fast
 *  even for a huge ignored subtree (~60ms on this repo). A synchronous,
 *  one-time call at watch setup — not per file-change event. */
function ignoredDirectoryMatchers(cwd: string): Matcher[] {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { cwd, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return out
      .split("\0")
      .filter((p) => p.endsWith("/"))
      .map((p) => ignoreSubtree(path.join(cwd, p)));
  } catch {
    // Not a git repo (or git failed) — fall back to just the hardcoded
    // node_modules/.git exclusion below; callers only ever watch a
    // known-git cwd in practice, so this is a defensive fallback, not the
    // expected path.
    return [];
  }
}

// Watches the project's working tree for changes and calls `onChange`
// (debounced) whenever anything moves — real OS-level filesystem events
// (inotify/FSEvents/ReadDirectoryChangesW via chokidar), not polling.
// Used to auto-refresh volatile (working-tree) sessions instead of
// requiring the user to re-invoke `/askdiff`. `.git` and `node_modules`
// are always excluded (they can never be part of a working-tree diff even
// for a non-git-repo fallback); everything else git itself considers
// ignored for this `cwd` is excluded too, computed fresh per call.
export function watchWorkingTree(
  cwd: string,
  onChange: () => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): WorkingTreeWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher: FSWatcher = chokidar.watch(cwd, {
    ignored: [
      ignoreSubtree(path.join(cwd, ".git")),
      ignoreSubtree(path.join(cwd, "node_modules")),
      ...ignoredDirectoryMatchers(cwd),
    ],
    ignoreInitial: true,
    persistent: true,
  });

  const scheduleChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
  };

  watcher.on("all", scheduleChange);
  watcher.on("error", (err: unknown) => {
    console.error("working-tree watcher error:", err);
  });

  return {
    close: async () => {
      if (timer) clearTimeout(timer);
      await watcher.close();
    },
  };
}

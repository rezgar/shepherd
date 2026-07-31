import chokidar, { type FSWatcher } from "chokidar";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorkingTreeWatcher {
  close: () => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 300;
const GIT_IGNORED_LOOKUP_TIMEOUT_MS = 5_000;
const ALWAYS_IGNORED_DIR_NAMES = new Set([".git", "node_modules"]);

// This repo's git-ignored top-level entries, collapsed at the directory
// level (a gitignored directory is returned as one entry, not recursed
// into) — exactly what the watcher needs to skip whole subtrees instead of
// walking into them file-by-file. Best-effort: an empty list on any
// failure (git not on PATH, cwd not a repo, timeout) just falls back to the
// ALWAYS_IGNORED_DIR_NAMES check below — never blocks the watch starting.
async function gitIgnoredTopLevelEntries(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { cwd, timeout: GIT_IGNORED_LOOKUP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

// Builds the ignore predicate chokidar actually calls per path. NOT a glob
// string list — chokidar 4 dropped glob support entirely (see its own
// README: "v4: remove glob support... If you've used globs before [...]
// use a function"), so passing glob strings like '**/.git/**' silently
// matches nothing: v4's string matcher is a plain `===` equality check
// (chokidar/index.js's `createPattern`), never true for any real path.
// Confirmed live and by direct repro against this repo: `.git`,
// `node_modules`, AND (see watchWorkingTree's own comment) `.worktrees`
// were ALL still being fully recursed into despite "excluding" them via
// glob strings — the exclusion had never actually worked.
function makeIgnorePredicate(cwd: string, ignoredEntries: string[]): (path: string) => boolean {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const ignoredPrefixes = ignoredEntries.map((entry) => `${normalizedCwd}/${entry.replace(/\/$/, "")}`);
  return (path: string): boolean => {
    const normalized = path.replace(/\\/g, "/");
    if (normalized.split("/").some((part) => ALWAYS_IGNORED_DIR_NAMES.has(part))) return true;
    return ignoredPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
  };
}

// Watches the project's working tree for changes and calls `onChange`
// (debounced) whenever anything moves — real OS-level filesystem events
// (inotify/FSEvents/ReadDirectoryChangesW via chokidar), not polling.
// Used to auto-refresh volatile (working-tree) sessions instead of
// requiring the user to re-invoke `/askdiff`. `.git` and `node_modules`
// are excluded purely to avoid churning on directories that can never be
// part of a working-tree diff — the diff computation's own git commands
// remain the actual authority on what's tracked/ignored.
//
// Also excludes whatever else `git` itself ignores. Confirmed live: a repo
// using a `.worktrees/` convention (each entry a FULL nested checkout, with
// its own `node_modules`) sent this watcher's native handle count into the
// hundreds of thousands and crashed the daemon. `git` itself already
// excludes `.worktrees` from diff computation (via `.git/info/exclude`),
// but this watcher's exclusion — see makeIgnorePredicate's comment on why
// the ORIGINAL `.git`/`node_modules` glob-string exclusion never actually
// worked either — had no way to know it existed and happily recursed into
// all 50+ nested checkouts. Resolved ONCE at watch setup, not re-checked
// live — same "pre-warmed at spawn time" tradeoff `askdiffInstances.ts`
// already accepts for `resolveDiffBase`: a directory newly gitignored
// mid-session won't be picked up without a fresh focus, an acceptable gap
// next to re-shelling to git on every filesystem event.
export async function watchWorkingTree(
  cwd: string,
  onChange: () => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): Promise<WorkingTreeWatcher> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const ignoredEntries = await gitIgnoredTopLevelEntries(cwd);
  const isIgnored = makeIgnorePredicate(cwd, ignoredEntries);

  const watcher: FSWatcher = chokidar.watch(cwd, {
    ignored: isIgnored,
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

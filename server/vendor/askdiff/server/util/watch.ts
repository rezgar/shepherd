import chokidar, { type FSWatcher } from "chokidar";

export interface WorkingTreeWatcher {
  close: () => Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 300;

// Watches the project's working tree for changes and calls `onChange`
// (debounced) whenever anything moves — real OS-level filesystem events
// (inotify/FSEvents/ReadDirectoryChangesW via chokidar), not polling.
// Used to auto-refresh volatile (working-tree) sessions instead of
// requiring the user to re-invoke `/askdiff`. `.git` and `node_modules`
// are excluded purely to avoid churning on directories that can never be
// part of a working-tree diff — the diff computation's own git commands
// remain the actual authority on what's tracked/ignored.
export function watchWorkingTree(
  cwd: string,
  onChange: () => void,
  debounceMs = DEFAULT_DEBOUNCE_MS,
): WorkingTreeWatcher {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher: FSWatcher = chokidar.watch(cwd, {
    ignored: ["**/.git/**", "**/node_modules/**"],
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

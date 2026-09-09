import { execFileSync } from 'node:child_process';
import path from 'node:path';

let cachedExe: string | null = null;
/** Resolve the real `claude` binary, not the `.cmd` shim on PATH — Windows'
 *  CreateProcess (what both node-pty and plain child_process.spawn use)
 *  won't run a .cmd directly, so this reads the shim's own install
 *  directory and points at the .exe it delegates to. No hardcoded
 *  per-machine path. Shared by every spawn site that needs `claude` —
 *  sender.ts's interactive PTYs and the vendored askdiff Q&A bridge alike —
 *  so a bare `spawn("claude", ...)` (which resolves via PATH and silently
 *  ENOENTs in environments where that shim directory isn't on PATH, e.g.
 *  the packaged desktop app) never creeps back in at a new call site. */
export function resolveClaudeExecutable(): string {
  if (cachedExe) return cachedExe;
  const isWin = process.platform === 'win32';
  try {
    const out = execFileSync(isWin ? 'where' : 'which', [isWin ? 'claude.cmd' : 'claude'], { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0]
      .trim();
    cachedExe = isWin
      ? path.join(path.dirname(out), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
      : out;
    return cachedExe;
  } catch {
    // Deliberately NOT cached: `where`/`which` can fail from a purely
    // transient environment hiccup (nvm switching the active Node version
    // out from under PATH, a Windows Update resetting shell/session state,
    // etc.) that clears itself well before this long-running daemon exits.
    // Caching the fallback here would mean the first such hiccup poisons
    // every terminal/askdiff spawn for the rest of the daemon's life — the
    // bare 'claude.exe'/'claude' below is unresolvable via node-pty's own
    // PATH search (Windows: conpty.cc throws "File not found: " with an
    // EMPTY path when its SearchPath comes up empty), so once wedged it
    // fails identically forever, even after a plain terminal would already
    // work again. Returning without caching lets the very next call retry.
    return isWin ? 'claude.exe' : 'claude';
  }
}

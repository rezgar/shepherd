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
  } catch {
    cachedExe = isWin ? 'claude.exe' : 'claude';
  }
  return cachedExe;
}

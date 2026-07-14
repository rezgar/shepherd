import spawn from 'cross-spawn';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PASTE_DIR = path.join(os.tmpdir(), 'agent-shepherd-pastes');

/** Decode a pasted `data:image/png;base64,...` URI to a temp file and return
 *  its absolute path — the CLI's `-p` has no image-attachment flag, but the
 *  agent's own Read tool can view an image given its path, so we hand it one. */
function saveImage(sessionId: string, dataUrl: string, index: number): string | null {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const dir = path.join(PASTE_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paste-${Date.now()}-${index}.${m[1]}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

/**
 * Reply into an existing session by resuming it. `claude --resume <id> -p`
 * continues the same session and appends to the transcript the daemon already
 * watches — so the reply renders through the normal transcript-update path; we
 * don't parse the child's stdout for rendering, only track completion/errors.
 *
 * The prompt is piped over stdin rather than passed as a `-p <text>` argv
 * entry — cross-spawn resolves `claude` through its Windows .cmd shim via
 * cmd.exe, which mangles a single argv containing embedded newlines (cmd.exe
 * parses line-by-line, so anything after the first `\n` was silently lost).
 * Stdin has no such quoting layer.
 */
export function sendToSession(
  sessionId: string,
  cwd: string,
  text: string,
  images: string[] | undefined,
  onDone: () => void,
  onError: (msg: string) => void,
  onCancelled: () => void,
): { cancel: () => void } {
  const paths = (images ?? []).map((img, i) => saveImage(sessionId, img, i)).filter((p): p is string => !!p);
  const notes = paths.map((p, i) => `[Pasted image ${i + 1} — read this file to view it: ${p}]`).join('\n');
  const fullText = notes ? `${notes}\n\n${text}`.trim() : text;

  const child = spawn(
    'claude',
    ['--resume', sessionId, '-p', '--output-format', 'stream-json', '--verbose'],
    { cwd, stdio: ['pipe', 'ignore', 'pipe'] },
  );
  child.stdin?.end(fullText);

  let err = '';
  let cancelled = false;
  child.stderr?.on('data', (d) => {
    err += d.toString();
  });
  child.on('error', (e) => {
    if (!cancelled) onError(e.message);
  });
  child.on('exit', (code) => {
    if (cancelled) onCancelled();
    else if (code === 0) onDone();
    else onError(err.trim() || `claude exited with ${code}`);
  });
  return {
    // `claude` on Windows re-execs into a further child process to do the
    // real work, so child.kill() here only kills the launcher and leaves the
    // actual worker running (and still burning API calls) — confirmed live:
    // the tracked child exited, but a same-session claude.exe kept going.
    // taskkill's /T kills the whole process tree, not just this pid.
    cancel: () => {
      cancelled = true;
      if (process.platform === 'win32' && child.pid) {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {});
      } else {
        child.kill();
      }
    },
  };
}

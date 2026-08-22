#!/usr/bin/env node
/**
 * End-to-end harness for startup session restore (issue #120).
 *
 * Unit tests cover the selection policy and the eviction rules; this covers
 * the thing they cannot — that a real daemon, started cold, actually brings
 * real `claude` processes back and that shutting it down takes them with it.
 * It is NOT part of `vitest run`: it spawns real sessions and takes minutes.
 *
 *   node server/scripts/restore-e2e.mjs
 *
 * It builds a fixture projects directory from real transcripts already on
 * this machine, so it needs a `~/.claude/projects` with at least one session
 * active in the last 24h. Every branch of the restore is represented:
 *
 *   - a recently-active session          -> restored
 *   - a session already running          -> skipped, already running
 *   - a second file with the same id     -> collapsed to one target
 *   - a session whose cwd was deleted    -> skipped, missing cwd
 *   - a session stale beyond the window  -> never selected
 *   - a subagent transcript              -> never treated as a session
 *
 * Exits non-zero on the first failed expectation.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const FIXTURE = path.join(os.tmpdir(), 'shepherd-restore-e2e', 'projects');
const PORT = 4199;
const DAY_MS = 24 * 3_600_000;

let failures = 0;
const check = (label, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  if (!ok) failures += 1;
};

/** Live `claude` processes, counted the same way on Windows and elsewhere. */
function claudeProcessCount() {
  try {
    const out =
      process.platform === 'win32'
        ? execFileSync('powershell.exe', [
            '-NoProfile',
            '-Command',
            "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Measure-Object).Count",
          ], { encoding: 'utf8' })
        : execFileSync('bash', ['-c', 'pgrep -c -f "claude" || true'], { encoding: 'utf8' });
    return Number(out.trim()) || 0;
  } catch {
    return -1;
  }
}

/** Throws rather than returning an empty set on failure. Failing open here
 *  would silently pick an already-running session as the restore target and
 *  then report a false negative — which is exactly what happened the first
 *  time this ran, because `claude` on Windows is a .cmd/.ps1 shim that
 *  execFile cannot invoke without a shell. */
/** Every session id the CLI knows a process for, of ANY kind. Used to choose
 *  a genuinely dormant session to restore: an id the CLI daemon already holds
 *  as a background worker does not surface a second *interactive* entry when
 *  it is resumed, so picking one makes the reachability check fail for a
 *  reason that has nothing to do with Shepherd. */
function allRegisteredIds() {
  const out = execSync('claude agents --json', { encoding: 'utf8', timeout: 30_000 });
  return new Set(JSON.parse(out).map((a) => a.sessionId));
}

function liveInteractiveIds() {
  // execSync, not execFileSync+shell: passing an args array with shell:true is
  // deprecated (DEP0190) because the args are concatenated unescaped.
  const out = execSync('claude agents --json', { encoding: 'utf8', timeout: 30_000 });
  return new Set(JSON.parse(out).filter((a) => a.kind === 'interactive').map((a) => a.sessionId));
}

/** First sessionId + cwd declared inside a transcript. */
function readHead(file) {
  let sid = null;
  let cwd = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      sid ??= j.sessionId ?? null;
      cwd ??= j.cwd ?? null;
      if (sid && cwd) break;
    } catch {
      /* partial line */
    }
  }
  return { sid, cwd };
}

function buildFixture() {
  rmSync(path.dirname(FIXTURE), { recursive: true, force: true });

  const now = Date.now();
  const candidates = [];
  for (const project of readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, project);
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const { sid, cwd } = readHead(full);
      if (!sid || !cwd) continue;
      candidates.push({ project, file: full, sid, cwd, mtime: statSync(full).mtimeMs });
    }
  }

  const live = liveInteractiveIds();
  const registered = allRegisteredIds();
  const recent = candidates
    .filter((c) => now - c.mtime <= DAY_MS && existsSync(c.cwd))
    .sort((a, b) => b.mtime - a.mtime);
  const restorable = recent.find((c) => !registered.has(c.sid));
  const alreadyRunning = recent.find((c) => live.has(c.sid));
  const stale = candidates.find((c) => now - c.mtime > 3 * DAY_MS);

  if (!restorable) {
    console.error('SKIP: no recently-active session that is not already running — nothing to restore.');
    process.exit(2);
  }

  // Copies keep the source's modification time: the scanner stat-filters on
  // mtime before it ever reads a file, so a stale fixture entry that arrived
  // with a fresh mtime would be read (and then correctly rejected on content)
  // rather than skipped — which would quietly stop testing the cheap filter.
  const copy = (src, relDir, name) => {
    const dir = path.join(FIXTURE, relDir);
    mkdirSync(dir, { recursive: true });
    const dst = path.join(dir, name);
    writeFileSync(dst, readFileSync(src));
    const { atime, mtime } = statSync(src);
    utimesSync(dst, atime, mtime);
    return dst;
  };

  copy(restorable.file, restorable.project, path.basename(restorable.file));
  // Same session id under a different filename — must collapse to one target.
  copy(restorable.file, restorable.project, 'duplicate-id-copy.jsonl');
  if (alreadyRunning) copy(alreadyRunning.file, alreadyRunning.project, path.basename(alreadyRunning.file));
  if (stale) copy(stale.file, restorable.project, `stale-${path.basename(stale.file)}`);

  // A subagent transcript, one level deeper — must never be seen as a session.
  const subDir = path.join(FIXTURE, restorable.project, path.basename(restorable.file, '.jsonl'), 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, 'agent-e2e.jsonl'), readFileSync(restorable.file));

  // A session whose worktree no longer exists.
  const gone = readFileSync(restorable.file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const j = JSON.parse(l);
        if (j.sessionId) j.sessionId = 'deadbeef-0000-1111-2222-333333333333';
        if (j.cwd) j.cwd = path.join(os.tmpdir(), 'shepherd-e2e-deleted-worktree');
        return JSON.stringify(j);
      } catch {
        return l;
      }
    })
    .join('\n');
  writeFileSync(path.join(FIXTURE, restorable.project, 'deadbeef-0000-1111-2222-333333333333.jsonl'), gone);

  return { restorable, alreadyRunning };
}

const { restorable, alreadyRunning } = buildFixture();
console.log(`fixture at ${FIXTURE}`);
console.log(`  expect restored:       ${restorable.sid.slice(0, 8)} (${restorable.cwd})`);
console.log(`  expect already-running: ${alreadyRunning ? alreadyRunning.sid.slice(0, 8) : '(none available)'}`);

const before = claudeProcessCount();
console.log(`\nclaude processes before: ${before}`);

const daemon = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(import.meta.dirname, '..', 'src', 'index.ts')], {
  env: { ...process.env, SHEPHERD_PROJECTS_DIR: FIXTURE, SHEPHERD_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let log = '';
const done = new Promise((resolve) => {
  const onChunk = (b) => {
    const s = b.toString();
    log += s;
    process.stdout.write(s.replace(/^/gm, '  | '));
    if (log.includes('[restore] done')) resolve();
  };
  daemon.stdout.on('data', onChunk);
  daemon.stderr.on('data', onChunk);
});

const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('restore did not finish in 10 minutes')), 600_000));
await Promise.race([done, timeout]);

const during = claudeProcessCount();

// A restored session registers itself with the CLI's daemon shortly AFTER
// Shepherd considers its spawn ready, so reading the registry the instant
// restore finishes is a race — it flaked on exactly this assertion once.
// Poll instead of sleeping a guessed amount.
// Generous: registration is the CLI's own startup work, and a cold start
// that has to bring up a dozen MCP servers can take minutes on a loaded
// machine. 90s was not enough on one run.
let liveNow = new Set();
for (const deadline = Date.now() + 300_000; Date.now() < deadline; ) {
  liveNow = liveInteractiveIds();
  if (liveNow.has(restorable.sid)) break;
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 5_000));
}
console.log();

console.log('\n--- assertions ---');
check('the chosen session was restored exactly once (duplicate id collapsed)', 1, (log.match(new RegExp(`${restorable.sid.slice(0, 8)} restored`, 'g')) ?? []).length);
check('restored session is running and reachable (listed as interactive)', true, liveNow.has(restorable.sid));
check('process count grew while restored', true, during > before);
check('session with a deleted worktree was skipped', true, log.includes('deadbeef skipped — working directory is gone'));
check('no subagent transcript was restored', false, log.includes('agent-e2e'));
if (alreadyRunning) {
  check('already-running session was skipped', true, log.includes(`${alreadyRunning.sid.slice(0, 8)} already running`));
}

await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: 'POST' }).catch(() => {});
await new Promise((r) => daemon.on('exit', r));
await new Promise((r) => setTimeout(r, 8_000)); // let graceful closes land

// Deliberately NOT a global process-count comparison. The real Shepherd
// daemon is usually running on the same machine and spawns its own sessions
// and /usage probes throughout; one appeared mid-run and made a
// count-based assertion fail while nothing was actually leaked. What matters
// is narrower and checkable: the session THIS restore started is gone.
let stillLive = true;
for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
  stillLive = liveInteractiveIds().has(restorable.sid);
  if (!stillLive) break;
  await new Promise((r) => setTimeout(r, 3_000));
}
const after = claudeProcessCount();
console.log(`\nclaude processes: ${before} before, ${during} during, ${after} after shutdown (informational — other daemons on this machine also spawn sessions)`);
check('the restored session is gone after shutdown', false, stillLive);

rmSync(path.dirname(FIXTURE), { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : '\nall assertions passed');
process.exit(failures ? 1 : 0);

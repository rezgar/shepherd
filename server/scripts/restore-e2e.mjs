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
 *   - a recently-active session          -> restored, and reachable remotely
 *   - a session already running          -> skipped, already running
 *   - a second file with the same id     -> collapsed to one target
 *   - a session whose cwd was deleted    -> skipped, missing cwd
 *   - a session stale beyond the window  -> never selected
 *   - a subagent transcript              -> never treated as a session
 *
 * It then compresses the idle-eviction timeline and waits past it, to prove a
 * restored session is not closed before the operator arrives — the regression
 * that shipped in this feature's first implementation and that no assertion
 * caught, because the harness used to shut down long before the idle mark.
 *
 * Assertions that the machine's state makes impossible are reported as SKIP
 * and counted separately; "0 failed" with skips is not a clean run.
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
let passes = 0;
let skips = 0;
const check = (label, expected, actual) => {
  const ok = JSON.stringify(expected) === JSON.stringify(actual);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  ok ? (passes += 1) : (failures += 1);
};
/** A check the machine's state made impossible to run. Counted and printed —
 *  a silently skipped assertion still reports "all assertions passed", which
 *  is how a suite quietly shrinks without anyone noticing. */
const skip = (label, why) => {
  console.log(`SKIP  ${label}\n        ${why}`);
  skips += 1;
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

/** Every session id the CLI knows a process for, of ANY kind. Used to choose
 *  a genuinely dormant session to restore: an id the CLI daemon already holds
 *  as a background worker does not surface a second *interactive* entry when
 *  it is resumed, so picking one makes the reachability check fail for a
 *  reason that has nothing to do with Shepherd. */
function allRegisteredIds() {
  const out = execSync('claude agents --json', { encoding: 'utf8', timeout: 30_000 });
  return new Set(JSON.parse(out).map((a) => a.sessionId));
}

/** Session ids with a live INTERACTIVE process — what a restore collides
 *  with, and what makes a session reachable from phone or web.
 *
 *  Throws rather than returning an empty set on failure. Failing open here
 *  would silently pick an already-running session as the restore target and
 *  then report a false negative — which is exactly what happened the first
 *  time this ran, because `claude` on Windows is a .cmd/.ps1 shim that
 *  execFile cannot invoke without a shell. */
function liveInteractiveIds() {
  // execSync, not execFileSync+shell: passing an args array with shell:true is
  // deprecated (DEP0190) because the args are concatenated unescaped.
  const out = execSync('claude agents --json', { encoding: 'utf8', timeout: 30_000 });
  return new Set(JSON.parse(out).filter((a) => a.kind === 'interactive').map((a) => a.sessionId));
}

const SUBAGENT_ID = 'aaaae2ea-0000-1111-2222-333333333333';
const MISSING_CWD_ID = 'deadbeef-0000-1111-2222-333333333333';

/** A copy of a transcript rewritten to declare a different session id and
 *  working directory — so a fixture entry is a genuinely distinct session
 *  rather than a duplicate that collapses into another target. */
function reidentify(srcFile, sessionId, cwd) {
  return readFileSync(srcFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const j = JSON.parse(l);
        if (j.sessionId) j.sessionId = sessionId;
        if (j.cwd) j.cwd = cwd;
        return JSON.stringify(j);
      } catch {
        return l;
      }
    })
    .join('\n');
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
  // It carries its OWN session id: a byte copy would inherit `restorable`'s
  // id, which duplicate-collapsing would then fold into the existing target,
  // making the subagent indistinguishable from correct behaviour. With a
  // distinct id, its appearance among the targets is unambiguous evidence of
  // failure.
  const subDir = path.join(FIXTURE, restorable.project, path.basename(restorable.file, '.jsonl'), 'subagents');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, 'agent-e2e.jsonl'), reidentify(restorable.file, SUBAGENT_ID, restorable.cwd));

  // A session whose worktree no longer exists.
  writeFileSync(
    path.join(FIXTURE, restorable.project, `${MISSING_CWD_ID}.jsonl`),
    reidentify(restorable.file, MISSING_CWD_ID, path.join(os.tmpdir(), 'shepherd-e2e-deleted-worktree')),
  );

  return { restorable, alreadyRunning, stale };
}

const { restorable, alreadyRunning, stale } = buildFixture();
console.log(`fixture at ${FIXTURE}`);
console.log(`  expect restored:       ${restorable.sid.slice(0, 8)} (${restorable.cwd})`);
console.log(`  expect already-running: ${alreadyRunning ? alreadyRunning.sid.slice(0, 8) : '(none available)'}`);

const before = claudeProcessCount();
console.log(`\nclaude processes before: ${before}`);

// Compress the idle-eviction timeline so the real sweep, in the real daemon,
// runs several times within this script's lifetime. Without this the harness
// shuts down a couple of minutes after restore and could never observe a
// restored session dying at the idle mark — which is the exact regression the
// restore exemption exists to prevent, and which shipped once already.
const IDLE_EVICT_MS = 15_000;
const SWEEP_MS = 5_000;

const daemon = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(import.meta.dirname, '..', 'src', 'index.ts')], {
  env: {
    ...process.env,
    SHEPHERD_PROJECTS_DIR: FIXTURE,
    SHEPHERD_PORT: String(PORT),
    SHEPHERD_IDLE_EVICT_MS: String(IDLE_EVICT_MS),
    SHEPHERD_EVICT_SWEEP_MS: String(SWEEP_MS),
  },
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

/** The one line naming every target the restore chose. Assertions about what
 *  was NOT selected have to read this — a session that was never a target
 *  produces no log line of its own, so "absent from the log" would pass
 *  vacuously. */
const targetsLine = (log.split('\n').find((l) => l.includes('session(s) to restore:')) ?? '');

console.log('\n--- assertions ---');
check('a targets line was logged at all', true, targetsLine.length > 0);
check('the chosen session was restored exactly once (duplicate id collapsed)', 1, (log.match(new RegExp(`${restorable.sid.slice(0, 8)} restored`, 'g')) ?? []).length);
check('restored session is running and reachable (listed as interactive)', true, liveNow.has(restorable.sid));
check('session with a deleted worktree was skipped', true, log.includes(`${MISSING_CWD_ID.slice(0, 8)} skipped — working directory is gone`));
// Asserted against the targets line, not against absence from the whole log:
// a subagent that was never selected logs nothing either way.
check('no subagent transcript was selected as a session', false, targetsLine.includes(SUBAGENT_ID.slice(0, 8)));
if (stale) {
  check('the stale session was not selected', false, targetsLine.includes(stale.sid.slice(0, 8)));
} else {
  skip('the stale session was not selected', 'no transcript older than 3 days on this machine');
}
if (alreadyRunning) {
  check('already-running session was skipped', true, log.includes(`${alreadyRunning.sid.slice(0, 8)} already running`));
} else {
  skip('already-running session was skipped', 'no live interactive session to use as a fixture');
}
console.log(`\n(process counts: ${before} before, ${during} during — informational only; the real Shepherd daemon on this machine spawns its own sessions and probes throughout, so counts are not asserted)`);

// THE regression test for this feature's own history. The first implementation
// restored sessions correctly and then let the idle sweep close every one of
// them 10-15 minutes later, so an operator arriving hours after a power cut
// found nothing — and no assertion caught it, because the harness shut the
// daemon down long before the idle mark. With the timeline compressed above,
// the real sweep has now had several passes at this session.
const waitMs = IDLE_EVICT_MS + 3 * SWEEP_MS + 5_000;
console.log(`\nwaiting ${Math.round(waitMs / 1000)}s — past a ${IDLE_EVICT_MS / 1000}s idle threshold with sweeps every ${SWEEP_MS / 1000}s...`);
await new Promise((r) => setTimeout(r, waitMs));

check('restored session survives real idle-eviction sweeps untouched', true, liveInteractiveIds().has(restorable.sid));
check('the sweep did not report closing it', false, log.includes(`idle-evicted`) && log.includes(restorable.sid.slice(0, 8)));

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
console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`);
if (skips) console.log('(a skipped assertion is not a passing one — see the SKIP lines above for why)');
process.exit(failures ? 1 : 0);

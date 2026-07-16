import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pty, { type IPty } from 'node-pty';
import { parseSession } from './parse.js';
import { readHookStates } from './hookState.js';
import { PROJECTS_DIR } from './scan.js';

const pexecFile = promisify(execFile);

const PASTE_DIR = path.join(os.tmpdir(), 'agent-shepherd-pastes');

// Drives the REAL interactive `claude` CLI over a pseudo-terminal — the same
// code path a human types into, not the SDK's print/stream-json mode. That
// print-mode control channel is where every reliability bug this daemon hit
// came from (orphaned processes, stuck "working" state, interrupts that
// didn't actually interrupt): a far less exercised path than the terminal
// REPL millions of people use daily. Sending a message is typing text + \r;
// stopping one is typing Escape — exactly what a person would do.
//
// One PTY per session, kept alive across sends — not spawned fresh and
// killed after every single message. A fresh spawn per message isn't how a
// terminal behaves (you don't close and reopen the window to say a second
// thing), and it showed: every message paid the ~4.5s startup tax, and Esc
// interrupted a disposable stand-in process rather than the one actually
// generating. `readyPtys` holds the live, ready-for-input process per
// session; a send reuses it if present, spawns (and waits out the startup
// window) only the first time or after eviction — exactly like typing into
// a terminal you already have open vs. having to open a new one.

let cachedExe: string | null = null;
/** Resolve the real `claude` binary, not the `.cmd` shim on PATH — Windows'
 *  CreateProcess (what node-pty uses under the hood) won't run a .cmd
 *  directly, so this reads the shim's own install directory and points at
 *  the .exe it delegates to. No hardcoded per-machine path. */
function resolveClaudeExecutable(): string {
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

/** This (Node, daemon) process must never hand a spawned `claude` a
 *  CLAUDE_ or ANTHROPIC_ env var of its own — in dev that daemon may itself
 *  run under `tsx`, but critically anyone testing this from inside a live
 *  Claude Code session would leak session-identifying vars that make the
 *  child think it's a nested child session and skip writing its transcript
 *  entirely (found the hard way — confirmed empirically before shipping this). */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC)/i.test(k)));
}

const POLL_MS = 700;
/** How long we'll wait to see the turn genuinely start (hook/transcript
 *  flips to "working") before giving up on that wait — guards against
 *  polling forever if something upstream never reflects the send. Generous
 *  for the same reason as FIND_NEW_SESSION_TIMEOUT_MS: observed real-world
 *  startup under daemon load can run well past what an idle machine shows —
 *  65s+ seen with three `claude` processes running concurrently on one
 *  machine, which blew straight through the previous 60s budget. Giving up
 *  here no longer means giving up on the SESSION (see the persistent-PTY
 *  model above) — it just means this one confirmation attempt was
 *  inconclusive; the PTY stays up either way. */
const START_TIMEOUT_MS = 90_000;
const GRACE_EXIT_MS = 2_500;
/** After spawning, how long the PTY's output must sit quiet (no new bytes)
 *  before we consider it settled at its input prompt and safe to type into.
 *  Replaces a fixed timer — confirmed the hard way that a fixed wait can
 *  fire while the CLI is still mid-splash-screen under heavy concurrent
 *  load (observed 65s+ startups earlier in this exact session), silently
 *  swallowing the typed kickoff with no error at all. A short quiet window
 *  is a far more direct signal of "done rendering" than a guessed timeout. */
const READY_QUIET_MS = 900;
/** Absolute cap on how long to wait for that quiet window — a process that
 *  never stops producing output (or is genuinely stuck) shouldn't hang the
 *  caller forever; proceed anyway and let the existing turn-confirmation
 *  logic downstream catch it if the type-in didn't actually land. */
const READY_MAX_WAIT_MS = 60_000;
/** How long spawnSession will wait to spot the new session's transcript file
 *  before giving up — observed startup can run well past 15s under real
 *  daemon load (many concurrent watchers/polls, not just this one spawn), so
 *  this is deliberately generous rather than tuned to an idle machine. */
const FIND_NEW_SESSION_TIMEOUT_MS = 90_000;
/** How long a session's PTY sits idle (no send through Shepherd) before it's
 *  closed to free the process — the terminal-window equivalent of closing a
 *  window you haven't touched in a while. A later send just reopens it,
 *  paying the startup wait once again; nothing about the session itself is
 *  lost, since ground truth always lives in its transcript file. */
const IDLE_EVICT_MS = 30 * 60_000;
const EVICT_SWEEP_MS = 5 * 60_000;
/** Gap between clearing the input line, typing text, and pressing Enter —
 *  each as its OWN `write()` call rather than one concatenated burst.
 *  Confirmed the hard way: writing `` `${text}\r` `` in a single call gets
 *  swallowed by the CLI's paste-burst detection (added in a recent Claude
 *  Code version) — the text lands in the input box but the trailing \r
 *  never registers as Enter, so nothing is ever submitted, silently, with
 *  no error anywhere. A newer CLI version apparently now treats a big burst
 *  of bytes arriving in one read() as pasted text and refuses to let an
 *  embedded \r submit it. Splitting into separate writes with a short gap
 *  reproduces how a human actually types and reliably submits instead. */
const TYPE_GAP_MS = 80;

/** Type a line into a PTY's input box and submit it — clear whatever's
 *  there first (see writeTermInput's doc comment for why it isn't always
 *  empty), then the text, then Enter, each a separate write with a gap.
 *  See TYPE_GAP_MS for why this can't be one concatenated write. */
async function typeLine(p: IPty, text: string): Promise<void> {
  p.write('\x01\x0b');
  await new Promise((r) => setTimeout(r, TYPE_GAP_MS));
  p.write(text);
  await new Promise((r) => setTimeout(r, TYPE_GAP_MS));
  p.write('\r');
}

/** Caps how much raw PTY output a session's ring buffer retains for replay
 *  on attach/reconnect — big enough to redraw a full screen plus some
 *  scrollback, small enough that many idle sessions don't add up. */
const RING_BUFFER_CAP_BYTES = 256 * 1024;

/** Bounded byte buffer of the most recent raw PTY output for one session —
 *  what a client attaching (or reconnecting) replays before it starts
 *  receiving live output, so the terminal redraws the current screen instead
 *  of starting blank. Oldest bytes are dropped first once the cap is hit. */
export class RingBuffer {
  private chunks: Buffer[] = [];
  private total = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    // Trim from the front until back under the cap — a chunk entirely
    // outside the cap window is dropped whole; one straddling the boundary
    // is sliced down to just its tail, not dropped wholesale (dropping it
    // would lose bytes that are still within the cap).
    while (this.total > this.cap) {
      const first = this.chunks[0];
      const excess = this.total - this.cap;
      if (first.length <= excess) {
        this.chunks.shift();
        this.total -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.total -= excess;
      }
    }
  }

  replay(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Serializes async work per key — the structural fix for the concurrent-
 *  write corruption found in #13: two independent callers writing to the
 *  same session's PTY at once (e.g. a WS reconnect racing an in-flight send)
 *  would clear-and-retype over each other. A per-WS-handler check can be
 *  bypassed by a future code path that forgets it; a lock owned by the PTY
 *  entry itself cannot be — every write, from wherever it originates, queues
 *  on the same promise chain and runs strictly one at a time. */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** The minimal shape sender.ts needs from a WS connection — avoids importing
 *  the `ws` package's own WebSocket type here just for a `send`/`readyState`
 *  call; index.ts's FocusWs already satisfies this structurally. */
interface FocusWsLike {
  readyState: number;
  send(data: string): void;
}

interface PersistentPty {
  pty: IPty;
  pid: number;
  cwd: string;
  lastActivity: number;
  /** Recent raw output, replayed to a client that attaches or reconnects. */
  buffer: RingBuffer;
  /** Structural single-writer guarantee — see AsyncLock. */
  writeLock: AsyncLock;
  /** WS connections currently attached to this session's live output. */
  subscribers: Set<FocusWsLike>;
}

/** Must drain the pty's output — ConPTY's buffer fills fast against a TUI's
 *  redraw spam and the whole process stalls, including our own writes —
 *  while also tracking the last time any output arrived, so callers can
 *  wait for it to actually go quiet instead of guessing a fixed delay.
 *  Returns a function reporting milliseconds since the last chunk. */
function drainAndTrack(p: IPty): () => number {
  let lastDataAt = Date.now();
  p.onData(() => {
    lastDataAt = Date.now();
  });
  return () => Date.now() - lastDataAt;
}

/** Wait until a spawned PTY's output has been quiet for READY_QUIET_MS —
 *  see that constant for why this replaced a fixed startup timer. */
async function waitForPtyQuiet(idleFor: () => number): Promise<void> {
  const deadline = Date.now() + READY_MAX_WAIT_MS;
  for (;;) {
    if (idleFor() >= READY_QUIET_MS) return;
    if (Date.now() > deadline) return; // give up waiting for quiet, proceed anyway
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Live, ready-for-input PTYs, one per session — the actual "terminal
 *  window" a send reuses instead of opening a fresh one each time. */
const readyPtys = new Map<string, PersistentPty>();
/** In-progress spawns, keyed by session id — de-dupes concurrent sends to a
 *  not-yet-open session so two rapid-fire messages don't each spawn their
 *  own process and fight over which one is "the" session PTY. */
const spawning = new Map<string, Promise<PersistentPty>>();
/** Normalized (lowercase, forward-slash) cwds an in-flight spawnSession()
 *  call currently owns a live PTY for, but hasn't yet registered under its
 *  real session id in `readyPtys` — see the matching wait loop in
 *  getOrSpawnPty. Keyed by cwd, known from the moment spawnSession's PTY is
 *  spawned, rather than by session id: confirmed the hard way that Claude
 *  Code creates a session's transcript file (and so reveals its session id
 *  to chokidar's watcher, and thus to any client that discovers and
 *  auto-attaches to it) at process startup, WELL BEFORE spawnSession's own
 *  quiet-wait + kickoff-typing + polling loop ever learns that id itself —
 *  a session-id-keyed ownership claim registers far too late to close that
 *  gap. A client attaching in that window can otherwise beat spawnSession
 *  to getOrSpawnPty, spawning a second, colliding `--resume` process for
 *  the exact same session (see isSessionLiveElsewhere's doc comment for
 *  what that collision looks like in practice). */
const spawnSessionOwnershipByCwd = new Set<string>();
/** How long getOrSpawnPty will wait for an in-flight spawnSession() to
 *  finish registering before giving up and spawning its own PTY — generous
 *  because it covers spawnSession's ENTIRE startup window (spawn, quiet
 *  wait, kickoff typing, polling for the session file), not just a short
 *  polling interval; see READY_MAX_WAIT_MS and FIND_NEW_SESSION_TIMEOUT_MS
 *  for why that can legitimately run to tens of seconds under load. */
const NEW_SESSION_REGISTRATION_GRACE_MS = 90_000;

function normCwdKey(cwd: string): string {
  return cwd.replace(/\\/g, '/').toLowerCase();
}

async function spawnPersistent(sessionId: string, cwd: string): Promise<PersistentPty> {
  // pty.spawn can throw synchronously (seen under heavy concurrent load —
  // several `claude` processes competing for resources at once). This
  // function's own async-ness turns that into a rejected promise instead of
  // an uncaught throw, which is what the caller (and its caller) needs to
  // hand back a clean onError rather than taking the daemon down with it.
  const p = pty.spawn(resolveClaudeExecutable(), ['--dangerously-skip-permissions', '--resume', sessionId], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd,
    env: cleanEnv(),
  });
  const buffer = new RingBuffer(RING_BUFFER_CAP_BYTES);
  const subscribers = new Set<FocusWsLike>();
  const idleFor = drainAndTrack(p);
  p.onData((chunk: string) => {
    buffer.push(Buffer.from(chunk, 'utf8'));
    for (const sub of subscribers) {
      if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'termOutput', sessionId, chunk }));
    }
  });
  p.onExit(() => {
    // Only remove if this exit is for the entry we think is current — a
    // stale onExit firing after eviction-and-respawn must not delete the
    // NEW live entry out from under it.
    if (readyPtys.get(sessionId)?.pid === p.pid) readyPtys.delete(sessionId);
  });
  await waitForPtyQuiet(idleFor);
  return { pty: p, pid: p.pid ?? -1, cwd, lastActivity: Date.now(), buffer, writeLock: new AsyncLock(), subscribers };
}

/** Reuse this session's live PTY if it has one; otherwise spawn and wait out
 *  the startup window — the ONLY place a send pays that cost, and only the
 *  first time (or after idle eviction), never on every message. */
async function getOrSpawnPty(sessionId: string, cwd: string): Promise<PersistentPty> {
  const ready = readyPtys.get(sessionId);
  if (ready) {
    ready.lastActivity = Date.now();
    return ready;
  }
  const already = spawning.get(sessionId);
  if (already) return already;

  // See spawnSessionOwnershipByCwd's doc comment — an in-flight
  // spawnSession() may already own a live PTY for this exact cwd and just
  // hasn't learned this session's id (or registered it here) yet. Wait for
  // it rather than spawning a colliding duplicate.
  const cwdKey = normCwdKey(cwd);
  if (spawnSessionOwnershipByCwd.has(cwdKey)) {
    for (let waited = 0; waited < NEW_SESSION_REGISTRATION_GRACE_MS; waited += 150) {
      await new Promise((r) => setTimeout(r, 150));
      const nowReady = readyPtys.get(sessionId);
      if (nowReady) {
        nowReady.lastActivity = Date.now();
        return nowReady;
      }
      if (!spawnSessionOwnershipByCwd.has(cwdKey)) break; // spawnSession gave up (or claimed a different session) — fall through
    }
  }

  const p = spawnPersistent(sessionId, cwd);
  spawning.set(sessionId, p);
  try {
    const entry = await p;
    readyPtys.set(sessionId, entry);
    return entry;
  } finally {
    spawning.delete(sessionId);
  }
}

/** Attach a WS connection to a session's live terminal output — ensures the
 *  PTY is live (spawning if needed), replays its ring buffer to `ws`
 *  immediately, then subscribes `ws` to future output. Returns 'error' with
 *  a message if the PTY couldn't be reached at all. */
export async function attachTerminal(
  sessionId: string,
  cwd: string,
  ws: FocusWsLike,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let entry: PersistentPty;
  try {
    entry = await getOrSpawnPty(sessionId, cwd);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  entry.subscribers.add(ws);
  entry.lastActivity = Date.now();
  const replay = entry.buffer.replay();
  if (replay.length && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'termOutput', sessionId, chunk: replay.toString('utf8') }));
  }
  return { ok: true };
}

/** Stop streaming this session's output to `ws` — the PTY itself is
 *  untouched, exactly like closing one terminal window onto a tmux session
 *  that keeps running. */
export function detachTerminal(sessionId: string, ws: FocusWsLike): void {
  readyPtys.get(sessionId)?.subscribers.delete(ws);
}

/** Write text (plus any pasted images, saved to temp files and noted the
 *  same way today's send path already does) to a session's PTY, serialized
 *  through its write lock so a second concurrent call can never interleave
 *  with this one. Defensively clears whatever's on the input line first —
 *  see the matching comment history on this exact sequence for why it isn't
 *  always empty (the CLI restores Escape-interrupted text into the input
 *  line for editing). */
export async function writeTermInput(
  sessionId: string,
  cwd: string,
  text: string,
  images: string[] | undefined,
): Promise<void> {
  const entry = await getOrSpawnPty(sessionId, cwd);
  entry.lastActivity = Date.now();
  const fullText = withImageNotes(text, sessionId, images);
  await entry.writeLock.run(() => typeLine(entry.pty, fullText));
}

/** Resize a session's PTY to match its terminal panel's actual size. */
export function resizeTerm(sessionId: string, cols: number, rows: number): void {
  const entry = readyPtys.get(sessionId);
  entry?.pty.resize(cols, rows);
}

/** Write a raw control sequence (e.g. Escape to interrupt generation, same
 *  as a person pressing it at a real keyboard) straight to a session's PTY —
 *  no line-clear, no trailing `\r`, none of writeTermInput's "compose a new
 *  line" behavior, since this is meant to act on whatever the CLI is doing
 *  RIGHT NOW rather than submit new text. Still serialized through the same
 *  write lock so it can never interleave with a concurrent writeTermInput
 *  call. Removing the old send/cancel machinery (see #13's design spec)
 *  dropped Escape-to-interrupt entirely along with it — the terminal view
 *  never wires xterm's own keyboard capture (it's output-only, TermComposer
 *  is the only place typed input goes), so without a dedicated path like
 *  this, Escape had nowhere left to go at all. */
export async function sendTerminalKey(sessionId: string, cwd: string, key: string): Promise<void> {
  const entry = await getOrSpawnPty(sessionId, cwd);
  entry.lastActivity = Date.now();
  await entry.writeLock.run(async () => {
    entry.pty.write(key);
  });
}

interface LiveAgentEntry {
  pid?: number;
  sessionId?: string;
  kind?: string;
}

/** `claude agents --json` is the CLI's own registry of every live process it
 *  knows about, each with the exact session id it's attached to — ground
 *  truth from the source, not inferred from hooks or transcript timing.
 *  Used to WARN, not block: a session with a live interactive process
 *  attached (a real terminal, or another relay) means a second `--resume`
 *  will collide with it (confirmed the hard way — both run, neither errors,
 *  their output just interleaves into the same transcript with no way to
 *  tell which turn is whose). Sending anyway is the user's call — this just
 *  lets the caller flag it rather than have it happen silently.
 *
 *  Excludes our OWN persistent PTY's pid — now that a session's PTY lives
 *  across sends, it genuinely shows up in this same registry as an
 *  interactive process, and without this exclusion every second-and-later
 *  send to a session we already hold would falsely warn about colliding
 *  with ourselves. Fails open — if the check itself fails for any reason,
 *  this reports "not live", same as a clean pre-flight; it's a courtesy
 *  heads-up, not a safety gate. */
async function isSessionLiveElsewhere(sessionId: string): Promise<boolean> {
  try {
    const { stdout } = await pexecFile(resolveClaudeExecutable(), ['agents', '--json'], { timeout: 10_000 });
    const agents = JSON.parse(stdout) as LiveAgentEntry[];
    const ourPid = readyPtys.get(sessionId)?.pid;
    return agents.some(
      (a) => a.sessionId === sessionId && a.kind === 'interactive' && typeof a.pid === 'number' && a.pid !== ourPid,
    );
  } catch {
    return false;
  }
}

/** Decode a pasted `data:image/png;base64,...` URI to a temp file and return
 *  its absolute path — there's no paste-an-image affordance over a PTY, but
 *  the agent's own Read tool can view an image given its path, so we type it
 *  a note instead. */
function saveImage(sessionId: string, dataUrl: string, index: number): string | null {
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  const dir = path.join(PASTE_DIR, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `paste-${Date.now()}-${index}.${m[1]}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

function withImageNotes(text: string, sessionId: string, images: string[] | undefined): string {
  const paths = (images ?? []).map((img, i) => saveImage(sessionId, img, i)).filter((p): p is string => !!p);
  const notes = paths.map((p, i) => `[Pasted image ${i + 1} — read this file to view it: ${p}]`).join('\n');
  return notes ? `${notes}\n\n${text}`.trim() : text;
}

export interface SendHandle {
  /** Type Escape into the PTY — the CLI's own interrupt handling, the most
   *  battle-tested code path it has. Now that this is the session's ONE live
   *  process (not a disposable stand-in racing a real terminal), Escape
   *  genuinely interrupts the thing that's actually generating. */
  cancel: () => void;
}

/** Ask the REPL to exit, give it a moment, escalate to Ctrl-C, and only kill
 *  outright as a last resort — a hard kill is exactly what orphaned the
 *  SDK-era processes and is worth avoiding here even though this transport
 *  has its own already-observed process lifetime independent of it (kept for
 *  safety, not because it's expected to fire). Only ever called on a PTY
 *  that's being retired (idle-evicted or the daemon shutting down) — a live
 *  session's PTY is never closed just because one send finished. */
async function gracefulClose(p: IPty): Promise<void> {
  let exited = false;
  p.onExit(() => {
    exited = true;
  });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    p.write('/exit\r');
  } catch {
    /* already dead */
  }
  await wait(GRACE_EXIT_MS);
  if (exited) return;
  try {
    p.write('\x03');
    await wait(400);
    p.write('\x03');
  } catch {
    /* already dead */
  }
  await wait(GRACE_EXIT_MS);
  if (exited) return;
  try {
    p.kill();
  } catch {
    /* already dead */
  }
}

/** Poll the SAME transcript+hook classification the daemon's own snapshot
 *  uses (all the staleness hardening included) until this turn is over —
 *  first waiting for it to genuinely start, then waiting for it to leave
 *  "working" for two consecutive polls in a row (not just one — a single
 *  transient misclassification mid-turn, caught the hard way: it briefly
 *  read non-working before the message had even finished being typed).
 *  Ground truth lives in the transcript either way; this just reads it
 *  instead of re-deriving it.
 *
 *  Only `spawnSession`'s new-session kickoff still uses this — the reply
 *  path (`writeTermInput`) no longer needs to confirm completion at all,
 *  since the caller is watching the live terminal stream directly. A brand
 *  new session has no live stream to watch until its session id is known,
 *  so this is still how the kickoff's own success gets confirmed.
 *
 *  Returns `'timeout'` — distinct from `'done'` — if it never once saw the
 *  turn start: under enough concurrent load a `--resume` can take well over
 *  a minute just to reach its input prompt (confirmed the hard way — 65s+
 *  observed with several sessions running at once), so this is genuinely
 *  ambiguous between "still starting" and "silently died." Either way, the
 *  caller must not treat it like a normal finish — but with a persistent
 *  PTY, a timeout no longer means the session itself is lost, only that
 *  this particular confirmation attempt was inconclusive.
 *
 *  `retype`, if given, is called once — halfway through the wait, and only
 *  if `working` has never once been observed — to re-send the same
 *  keystrokes. Confirmed the hard way this is needed even on a PTY that
 *  already went quiet and looked ready: resuming a session runs its own
 *  `SessionStart:resume` hook asynchronously, and output can go quiet while
 *  that hook is still gating real input — the quiet-window "ready" signal
 *  fires, Shepherd types into it, and the keystrokes land on a prompt that
 *  isn't actually listening yet, silently swallowed with no error. Gated on
 *  `!sawWorking` so it can only ever fire on a session with zero evidence
 *  the first attempt was ever read — the same safety condition
 *  `findNewSessionFile`'s retry already relies on. */
async function waitForTurnToFinish(
  file: string,
  sessionId: string,
  isCancelled: () => boolean,
  retype?: () => void,
): Promise<'done' | 'error' | 'cancelled' | 'timeout'> {
  const startDeadline = Date.now() + START_TIMEOUT_MS;
  const retypeAt = Date.now() + START_TIMEOUT_MS / 2;
  let sawWorking = false;
  let notWorkingStreak = 0;
  let retried = false;
  for (;;) {
    if (isCancelled()) return 'cancelled';
    await new Promise((r) => setTimeout(r, POLL_MS));
    const now = Date.now();
    const hooks = await readHookStates(now);
    const model = await parseSession(file, now, hooks.get(sessionId)).catch(() => null);
    if (!model) continue;
    if (model.state === 'working') {
      sawWorking = true;
      notWorkingStreak = 0;
      continue;
    }
    if (sawWorking) {
      notWorkingStreak += 1;
      if (notWorkingStreak >= 2) return model.state === 'error' ? 'error' : 'done';
      continue;
    }
    if (retype && !retried && now > retypeAt) {
      retried = true;
      retype();
      continue;
    }
    if (now > startDeadline) return 'timeout'; // never saw it start — don't hang forever
  }
}

/**
 * Start a brand-new session in `cwd` with a kickoff prompt (the "+ new
 * session" card) — fire-and-forget for the card itself: the daemon's own
 * transcript watch surfaces it independently of anything here. `onSessionId`
 * is best-effort (polls for the new transcript file Claude Code creates) and
 * only matters for making the kickoff itself cancellable before it finishes.
 * Once the new session is identified, its PTY is registered as that
 * session's live one — every later send reuses it, same as any other.
 */
export function spawnSession(
  cwd: string,
  kickoffText: string,
  onSessionId: (sessionId: string) => void,
  onDone: () => void,
  onError: (msg: string) => void,
  onCancelled: () => void,
): SendHandle {
  let cancelled = false;
  let ptyRef: IPty | null = null;
  const handle: SendHandle = {
    cancel: () => {
      cancelled = true;
      try {
        ptyRef?.write('\x1b');
      } catch {
        /* not spawned yet, or already dead — nothing to interrupt either way */
      }
    },
  };

  void (async () => {
    let p: IPty;
    try {
      // Same reasoning as spawnPersistent's spawn: this can throw
      // synchronously under heavy load, and being inside this async IIFE
      // turns that into a clean rejected-path onError instead of an
      // uncaught throw that would take the whole daemon down.
      p = pty.spawn(resolveClaudeExecutable(), ['--dangerously-skip-permissions'], {
        name: 'xterm-color',
        cols: 120,
        rows: 40,
        cwd,
        env: cleanEnv(),
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
      return;
    }
    ptyRef = p;
    // Claimed the instant the process exists, NOT once its session id is
    // known — see spawnSessionOwnershipByCwd's doc comment for why the
    // session id alone is too late to close the race this guards against.
    // Cleared in the finally below on every exit path.
    const cwdKey = normCwdKey(cwd);
    spawnSessionOwnershipByCwd.add(cwdKey);
    try {
      const idleFor = drainAndTrack(p);
      if (cancelled) {
        onCancelled();
        try {
          p.kill();
        } catch {
          /* already dead */
        }
        return;
      }

      const before = new Set<string>();
      try {
        const projectDir = path.join(PROJECTS_DIR, cwd.replace(/[:\\/]/g, '-'));
        for (const name of await readdir(projectDir)) {
          if (name.endsWith('.jsonl')) before.add(path.join(projectDir, name));
        }
      } catch {
        /* project directory doesn't exist yet — fine, every .jsonl found later is new */
      }

      await waitForPtyQuiet(idleFor);
      // Clear the input line first — see the matching comment on writeTermInput
      // for why it isn't always empty; a harmless no-op on this first attempt.
      try {
        await typeLine(p, kickoffText);
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        return;
      }
      // Later retries (see KICKOFF_RETRY_MS) are best-effort — if the PTY has
      // since died, findNewSessionFile's own timeout reports that, so a
      // failed retry write just needs to not throw uncaught here.
      const retype = async () => {
        try {
          await typeLine(p, kickoffText);
        } catch {
          /* already dead — findNewSessionFile's own polling will time out */
        }
      };

      const found = await findNewSessionFile(cwd, before, () => cancelled, retype);
      if (found) onSessionId(found.sessionId);

      if (!found) {
        // Couldn't identify the new session's file within the deadline — we
        // have zero confirmation the kickoff was ever actually submitted, so
        // typing `/exit` here is unsafe: found the hard way that doing this
        // blindly landed graceful-exit keystrokes in a still-open input box
        // and merged them with the original text. With no known-good state to
        // exit gracefully from, killing outright is the safer failure mode —
        // the card itself still appears independently via the daemon's own
        // transcript watch if the session did eventually get created.
        try {
          p.kill();
        } catch {
          /* already dead */
        }
        onError('could not confirm the new session was created within the deadline');
        return;
      }

      // From here on, this IS the session's live PTY — register it so every
      // future send reuses this same process instead of spawning a fresh one,
      // exactly like staying in the terminal window you just opened.
      const buffer = new RingBuffer(RING_BUFFER_CAP_BYTES);
      const subscribers = new Set<FocusWsLike>();
      p.onData((chunk: string) => {
        buffer.push(Buffer.from(chunk, 'utf8'));
        for (const sub of subscribers) {
          if (sub.readyState === 1) sub.send(JSON.stringify({ type: 'termOutput', sessionId: found.sessionId, chunk }));
        }
      });
      p.onExit(() => {
        if (readyPtys.get(found.sessionId)?.pid === p.pid) readyPtys.delete(found.sessionId);
      });
      readyPtys.set(found.sessionId, {
        pty: p,
        pid: p.pid ?? -1,
        cwd,
        lastActivity: Date.now(),
        buffer,
        writeLock: new AsyncLock(),
        subscribers,
      });
      // Registered under its real session id now — safe to drop the cwd
      // claim early instead of waiting for the whole finally block below,
      // which won't run until waitForTurnToFinish's own (potentially
      // minutes-long) wait completes.
      spawnSessionOwnershipByCwd.delete(cwdKey);

      const outcome = await waitForTurnToFinish(found.file, found.sessionId, () => cancelled, retype);
      if (outcome === 'timeout') {
        onError('session did not respond in time — it may be slow to start, or under heavy load');
        return;
      }
      if (outcome === 'cancelled') {
        onCancelled();
        return;
      }
      if (outcome === 'error') onError('session reported an error');
      else onDone();
    } finally {
      spawnSessionOwnershipByCwd.delete(cwdKey);
    }
  })();

  return handle;
}

/** How often, while waiting for the new session's file to appear, to retype
 *  the kickoff — a fresh (non-`--resume`) launch goes through a startup
 *  sequence `--resume` skips (MCP server connection attempts, an
 *  auth-needed banner, etc.), and confirmed the hard way: even after the
 *  terminal's OUTPUT goes quiet, Enter can land while that sequence is
 *  still gating real input, clearing the input line (so it LOOKS accepted)
 *  without ever actually submitting anything to the model — nothing a
 *  fixed startup delay can wait out, since it's bounded by those external
 *  connections' own timing, not the CLI's rendering. A human hitting Enter
 *  and seeing nothing happen would just try again; this does the same.
 *
 *  Deliberately long — a legitimate first attempt has taken 60-90s under
 *  real concurrent load in this exact environment (several MCP servers,
 *  several `claude` processes competing at once). Retyping too eagerly
 *  risks the opposite failure: the first attempt WAS accepted and is just
 *  slow, and a premature retry submits a second, duplicate kickoff into a
 *  session that's already mid-turn. This only fires once genuinely more
 *  than half the total budget has passed with no sign of success. */
const KICKOFF_RETRY_MS = 45_000;

/** Poll for a transcript file that didn't exist before this spawn and whose
 *  own `cwd` line matches — Claude Code assigns the new session's id itself,
 *  there's no structured event to read it from over a PTY, so this is how
 *  we find out which file/id it picked.
 *
 *  Scoped to the ONE project directory Claude Code would use for this cwd
 *  (its own naming convention: every `:`, `\`, `/` becomes `-`) rather than
 *  `listSessionFiles()`'s full walk of every project directory — found the
 *  hard way that re-scanning ~2000+ files across 100+ directories on every
 *  500ms tick was slow enough to blow past this function's own 15s deadline,
 *  which fed a false "never found it" into the caller and triggered a fixed
 *  20s-then-close fallback that closed the lease well before the kickoff had
 *  even been typed in — the graceful-exit keystrokes landed in a still-open
 *  input box and merged with the original text.
 *
 *  `retype` re-sends the kickoff (clearing the input line first) every
 *  KICKOFF_RETRY_MS while still waiting — see KICKOFF_RETRY_MS for why the
 *  first attempt alone isn't reliable enough on a fresh launch. */
async function findNewSessionFile(
  cwd: string,
  before: Set<string>,
  isCancelled: () => boolean,
  retype: () => Promise<void>,
): Promise<{ file: string; sessionId: string } | null> {
  const deadline = Date.now() + FIND_NEW_SESSION_TIMEOUT_MS;
  const normCwd = cwd.replace(/\\/g, '/').toLowerCase();
  const projectDir = path.join(PROJECTS_DIR, cwd.replace(/[:\\/]/g, '-'));
  let lastRetypeAt = Date.now();
  while (Date.now() < deadline) {
    if (isCancelled()) return null;
    await new Promise((r) => setTimeout(r, 500));
    if (Date.now() - lastRetypeAt > KICKOFF_RETRY_MS) {
      lastRetypeAt = Date.now();
      await retype();
    }
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      continue; // directory doesn't exist yet — first write hasn't landed
    }
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const f = path.join(projectDir, name);
      if (before.has(f)) continue;
      try {
        const head = await readFileAsync(f, 'utf8');
        const firstLine = head.slice(0, 2000).split('\n')[0];
        const parsed = JSON.parse(firstLine) as { cwd?: string; sessionId?: string };
        if (parsed.sessionId && parsed.cwd && parsed.cwd.replace(/\\/g, '/').toLowerCase() === normCwd) {
          return { file: f, sessionId: parsed.sessionId };
        }
      } catch {
        continue; // file mid-write or first line isn't the cwd-bearing one — try again next poll
      }
    }
  }
  return null;
}

/** Close any session PTY that's sat idle (no send through Shepherd) longer
 *  than IDLE_EVICT_MS — the terminal-window equivalent of closing a window
 *  you haven't touched in a while. Call once at daemon startup to start the
 *  recurring sweep. */
export function startIdleEvictionSweep(): void {
  setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of readyPtys) {
      if (now - entry.lastActivity > IDLE_EVICT_MS) {
        readyPtys.delete(sessionId);
        void gracefulClose(entry.pty);
      }
    }
  }, EVICT_SWEEP_MS);
}

/** Gracefully close every session's live PTY — called on daemon shutdown so
 *  restarting it (including the supervisor's own auto-restart-on-crash)
 *  doesn't leave orphaned `claude` processes behind. */
export async function shutdownAllSessions(): Promise<void> {
  const entries = [...readyPtys.values()];
  readyPtys.clear();
  await Promise.all(entries.map((e) => gracefulClose(e.pty)));
}

import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import pty, { type IPty } from 'node-pty';
// @xterm/headless's CJS bundle assigns its exports via a runtime loop, not
// static `exports.Terminal = ...`, so Node's CJS/ESM interop can't detect
// Terminal as a named export — the default import (the whole module.exports
// object) is the only reliable way to reach the real constructor at runtime.
import xtermHeadless from '@xterm/headless';
import type { Terminal } from '@xterm/headless';
import { resolveClaudeExecutable, cleanEnv } from './sender.js';
import { PROJECTS_DIR, USAGE_PROBE_CWD } from './scan.js';

const { Terminal: HeadlessTerminal } = xtermHeadless;

export interface LimitBar {
  /** 0-100, the account's real enforced percentage — straight from Claude
   *  Code's own /usage panel, not a local guess. */
  percent: number;
  /** ms until this window resets. */
  resetMs: number;
}

export interface Limits {
  session: LimitBar | null;
  weekly: LimitBar | null;
}

const PROBE_COLS = 140;
const PROBE_ROWS = 45;
/** How long output must sit quiet before the freshly-spawned probe is
 *  considered ready to type into — same reasoning as sender.ts's
 *  READY_QUIET_MS. */
const PROBE_QUIET_MS = 900;
/** Absolute cap on waiting for that quiet window. */
const PROBE_MAX_WAIT_MS = 60_000;
/** Whole-probe budget: spawn + wait-quiet + type + wait for the /usage
 *  panel to render both bars. Generous for the same reason every other
 *  spawn timeout in this codebase is — a `claude` launch can take well
 *  over a minute under real concurrent load. */
const PROBE_TOTAL_TIMEOUT_MS = 90_000;
/** How long to wait for a killed probe to actually be reaped before giving up
 *  on it. Generous next to the milliseconds a signalled process normally
 *  takes, because the cost of waiting is one delayed refresh whereas the cost
 *  of giving up too early is the leaked handle this wait exists to prevent. */
const PROBE_EXIT_TIMEOUT_MS = 5_000;

/** Renders whatever's currently on the probe's virtual screen as plain
 *  text, one line per row. Feeding the raw PTY bytes through a REAL
 *  terminal emulator (the same one the browser's terminal view uses,
 *  headless here) rather than regex-stripping ANSI codes ourselves is
 *  deliberate — confirmed the hard way that naive stripping breaks on
 *  cursor-positioning sequences (`\x1b[NC`, `\x1b[row;colH`) used instead
 *  of literal spaces/newlines: "Current session" comes through as
 *  "Currentsession" with the words fused together, since deleting the
 *  escape code deletes the only thing standing in for that whitespace.
 *  xterm.js already solves this correctly (it's rendering the exact same
 *  bytes into a grid); a headless instance gets the same correct text
 *  without a browser. */
function renderScreenText(term: Terminal): string {
  const lines: string[] = [];
  for (let y = 0; y < term.rows; y++) {
    const line = term.buffer.active.getLine(y);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n');
}

function parseClockTime(text: string): { hour: number; minute: number } | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  return { hour, minute: m[2] ? parseInt(m[2], 10) : 0 };
}

/** The session bar's reset ("Resets 7:50am") is a bare clock time — always
 *  the next occurrence of that time, today or tomorrow. */
function nextDailyReset(text: string, now: Date): number | null {
  const clock = parseClockTime(text);
  if (!clock) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), clock.hour, clock.minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime() - now.getTime();
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The weekly bar's reset ("Resets Jul 23, 3am") is a full date — assumed
 *  this year, rolled to next year only if that's already past (a Dec reset
 *  read in early January, say). */
function nextDatedReset(text: string, now: Date): number | null {
  const m = /([A-Za-z]{3,9})\s+(\d{1,2})/.exec(text);
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const clock = parseClockTime(text) ?? { hour: 0, minute: 0 };
  const d = new Date(now.getFullYear(), mi, parseInt(m[2], 10), clock.hour, clock.minute, 0, 0);
  if (d.getTime() <= now.getTime()) d.setFullYear(d.getFullYear() + 1);
  return d.getTime() - now.getTime();
}

/** Both bars render as one row each — "<label> ... N% used" then, on the
 *  next row, "Resets <time>" — in /usage's own layout. `labelPattern`
 *  finds the bar's own line; the percent and reset are read from the few
 *  lines right after it. */
function parseBar(
  screenText: string,
  labelPattern: RegExp,
  resetParser: (text: string, now: Date) => number | null,
  now: Date,
): LimitBar | null {
  const labelMatch = labelPattern.exec(screenText);
  if (!labelMatch) return null;
  const window = screenText.slice(labelMatch.index, labelMatch.index + 200);
  const pctMatch = /(\d+)%\s*used/.exec(window);
  const resetMatch = /Resets\s+([^\n]+)/.exec(window);
  if (!pctMatch || !resetMatch) return null;
  const resetMs = resetParser(resetMatch[1], now);
  if (resetMs === null) return null;
  return { percent: Math.min(100, parseInt(pctMatch[1], 10)), resetMs: Math.max(0, resetMs) };
}

function tryParse(screenText: string): Limits | null {
  if (!/%\s*used/i.test(screenText)) return null; // the /usage panel hasn't rendered its bars yet
  const now = new Date();
  return {
    session: parseBar(screenText, /Current session/i, nextDailyReset, now),
    weekly: parseBar(screenText, /Current week/i, nextDatedReset, now),
  };
}

/** Best-effort — the probe's own transcripts are already excluded from
 *  every snapshot (see USAGE_PROBE_CWD), this just keeps them from piling
 *  up on disk across repeated refreshes. */
function cleanupProbeFiles(): void {
  try {
    const dir = path.join(PROJECTS_DIR, USAGE_PROBE_CWD.replace(/[:\\/]/g, '-'));
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        unlinkSync(path.join(dir, f));
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* project directory doesn't exist yet — nothing to clean */
  }
}

/** Spawn a throwaway, genuinely interactive session and read its own
 *  /usage panel — the only source of the ACTUAL account-enforced
 *  percentages. A local (ccusage-style) estimate has no way to know the
 *  real cap; only Anthropic's account API does, and /usage is exactly what
 *  queries it. There's no --json/--print equivalent (confirmed: `claude -p
 *  "/usage"` returns a totally different "what's contributing to your
 *  usage" behavioral summary, no percentages at all), so this drives the
 *  real interactive panel a human would read. */
async function scrapeUsage(): Promise<Limits> {
  mkdirSync(USAGE_PROBE_CWD, { recursive: true });

  let p: IPty;
  try {
    p = pty.spawn(resolveClaudeExecutable(), ['--dangerously-skip-permissions'], {
      name: 'xterm-color',
      cols: PROBE_COLS,
      rows: PROBE_ROWS,
      cwd: USAGE_PROBE_CWD,
      env: cleanEnv(),
    });
  } catch {
    return { session: null, weekly: null };
  }

  // The probe's process must die on EVERY path out of here, which is why the
  // kill lives in a finally rather than as the last statement of the happy
  // path. It used to be the latter, so any throw in between — a terminal
  // write, a parse of a half-rendered panel — left a full `claude` process
  // alive with nothing referencing it. computeLimits' caller logs and
  // swallows that throw, so the leak was silent, and this probe runs every
  // five minutes: exactly the shape of the multi-day-old orphans found
  // holding hundreds of MB each.
  try {
    return await readUsagePanel(p);
  } finally {
    await closeProbe(p);
    cleanupProbeFiles();
  }
}

/** Kill the probe and wait for its exit to actually be delivered.
 *
 *  `p.kill()` only sends the signal. node-pty releases the handle backing the
 *  pty when it reaps the child and fires `onExit`, so returning before that
 *  abandons the handle — and since this probe runs every five minutes, the
 *  daemon accrues one leaked socket per refresh for as long as it lives.
 *
 *  That is exactly what index.ts's temporary `_getActiveHandles()` diagnostic
 *  was left in to chase, and it caught it: across one ~4h48m run `Socket`
 *  climbed 2 -> 59 monotonically, 1:1 with elapsed probes (57 probes, 57
 *  sockets), while every other handle class stayed flat. Distinct from #92,
 *  which was FSWatcher handles and explicitly not this.
 *
 *  The listener is registered BEFORE the kill, not after: a process that dies
 *  the moment it is signalled would otherwise fire its exit into a handler
 *  that does not exist yet, and this would then wait out the full timeout for
 *  an event already gone by.
 *
 *  Unlike a live session's pty (sender.ts's gracefulClose, which types
 *  `/exit` and escalates), the probe gets no graceful shutdown: nothing is
 *  attached to it, its transcripts are deleted immediately after, and it has
 *  already been driven through a `/usage` panel it was never meant to return
 *  from. Killing outright stays correct — the bug was never the signal, only
 *  the missing reap. */
async function closeProbe(p: IPty): Promise<void> {
  const reaped = new Promise<void>((resolve) => {
    p.onExit(() => {
      resolve();
    });
    try {
      p.kill();
    } catch {
      resolve(); // already dead — no exit event is coming
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounded so a probe that somehow refuses to die cannot wedge the
    // five-minute refresh loop. A missed reap is the leak this exists to fix,
    // but blocking forever on one would be strictly worse.
    await Promise.race([
      reaped,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PROBE_EXIT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    // Otherwise the loser of that race keeps a live timer for its full
    // duration — a smaller leak, but the same kind, in the same function.
    if (timer) clearTimeout(timer);
  }
}

/** Drive the freshly-spawned probe to its `/usage` panel and read the bars off
 *  it. Owns only the virtual screen; the caller owns the process. */
async function readUsagePanel(p: IPty): Promise<Limits> {
  // allowProposedApi is required at runtime to use `.buffer` at all — despite
  // the name, reading rendered line text is the whole reason to use this
  // package here, not an edge case.
  const term = new HeadlessTerminal({ cols: PROBE_COLS, rows: PROBE_ROWS, scrollback: 0, allowProposedApi: true });
  try {
    let lastDataAt = Date.now();
    p.onData((chunk) => {
      term.write(chunk);
      lastDataAt = Date.now();
    });

    const quietDeadline = Date.now() + PROBE_MAX_WAIT_MS;
    while (Date.now() - lastDataAt < PROBE_QUIET_MS) {
      if (Date.now() > quietDeadline) break; // give up waiting for quiet, try typing anyway
      await new Promise((r) => setTimeout(r, 150));
    }

    try {
      p.write('\x01\x0b'); // clear whatever's on the input line first
      await new Promise((r) => setTimeout(r, 100));
      p.write('/usage');
      await new Promise((r) => setTimeout(r, 100));
      p.write('\r');
    } catch {
      /* already dead */
    }

    const overallDeadline = Date.now() + PROBE_TOTAL_TIMEOUT_MS;
    let result: Limits = { session: null, weekly: null };
    while (Date.now() < overallDeadline) {
      await new Promise((r) => setTimeout(r, 400));
      const parsed = tryParse(renderScreenText(term));
      if (parsed) {
        result = parsed;
        if (parsed.session && parsed.weekly) break; // got both bars — no need to wait out the rest of the panel
      }
    }
    return result;
  } finally {
    term.dispose();
  }
}

export async function computeLimits(): Promise<Limits> {
  return scrapeUsage();
}

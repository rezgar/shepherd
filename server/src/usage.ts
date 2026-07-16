import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const require = createRequire(import.meta.url);

// Invoked as `node <cli.js>` (not by binary name) so it works regardless of
// PATH/shell-shim quirks — ccusage is a direct dependency, so its entry file
// is always resolvable from here.
const CCUSAGE_CLI = require.resolve('ccusage/src/cli.js');

export interface LimitBar {
  /** 0-100, estimated from local transcripts (not the account's real
   *  enforced percentage — ccusage has no way to know that, only Anthropic's
   *  account API does, and Shepherd never calls that directly). */
  percent: number;
  /** ms until this window resets. */
  resetMs: number;
}

export interface Limits {
  session: LimitBar | null;
  weekly: LimitBar | null;
}

interface CcusageBlock {
  isActive?: boolean;
  isGap?: boolean;
  totalTokens?: number;
  endTime?: string;
  projection?: { remainingMinutes?: number };
}

async function ccusageJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await pexec(process.execPath, [CCUSAGE_CLI, ...args, '--json'], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

/** Percent = active block's tokens against the highest token count any past
 *  block has hit — a local, best-effort stand-in for "% of plan limit" since
 *  Shepherd has no access to the account's real enforced cap. */
function computeSessionBar(blocks: CcusageBlock[]): LimitBar | null {
  const active = blocks.find((b) => b.isActive);
  if (!active) return null;
  const pastMax = blocks
    .filter((b) => b !== active && !b.isGap)
    .reduce((mx, b) => Math.max(mx, b.totalTokens ?? 0), 0);
  const limit = Math.max(pastMax, active.totalTokens ?? 0, 1);
  const percent = Math.min(100, Math.round(((active.totalTokens ?? 0) / limit) * 100));
  const resetMs =
    typeof active.projection?.remainingMinutes === 'number'
      ? active.projection.remainingMinutes * 60_000
      : active.endTime
        ? Date.parse(active.endTime) - Date.now()
        : 0;
  return { percent, resetMs: Math.max(0, resetMs) };
}

interface CcusageWeek {
  /** Monday of that ISO week, "YYYY-MM-DD", in the local timezone. */
  period: string;
  totalTokens?: number;
}

/** Percent = the current (possibly partial) calendar week's tokens against
 *  the highest total any past *complete* week has hit. Deliberately calendar
 *  weeks (via `ccusage weekly`), not a fixed 168h block (via `ccusage blocks
 *  --session-length 168`) — a block's boundary is just wherever local usage
 *  happened to start counting, unrelated to the account's real weekly reset
 *  schedule, and with only a handful of blocks ever completed it's noisy.
 *  Calendar weeks give a stable, sensible "this week vs past weeks" compare
 *  and a "reset" that means something (next Monday). */
function computeWeeklyBar(weeks: CcusageWeek[]): LimitBar | null {
  if (!weeks.length) return null;
  const current = weeks[weeks.length - 1];
  const pastMax = weeks
    .slice(0, -1)
    .reduce((mx, w) => Math.max(mx, w.totalTokens ?? 0), 0);
  const limit = Math.max(pastMax, current.totalTokens ?? 0, 1);
  const percent = Math.min(100, Math.round(((current.totalTokens ?? 0) / limit) * 100));
  const weekStart = Date.parse(`${current.period}T00:00:00`);
  const resetMs = Number.isFinite(weekStart) ? weekStart + 7 * 24 * 3_600_000 - Date.now() : 0;
  return { percent, resetMs: Math.max(0, resetMs) };
}

/** 5h rolling session usage + this calendar week's usage, both estimated
 *  from local ~/.claude/projects transcripts via ccusage — same data
 *  Shepherd already watches, no extra auth or direct API calls. */
export async function computeLimits(): Promise<Limits> {
  const [sessionData, weeklyData] = await Promise.all([
    ccusageJson<{ blocks: CcusageBlock[] }>(['blocks']),
    ccusageJson<{ weekly: CcusageWeek[] }>(['weekly']),
  ]);
  return {
    session: computeSessionBar(sessionData?.blocks ?? []),
    weekly: computeWeeklyBar(weeklyData?.weekly ?? []),
  };
}

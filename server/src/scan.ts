import os from 'node:os';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifySession, type RawSession } from './parse.js';
import { parseRawInWorker } from './rawParsePool.js';
import { readHookStates } from './hookState.js';
import type { AgentModel } from './types.js';

const pexec = promisify(execFile);

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Server keeps a generous window; the UI narrows it live. Tunable via env. */
const WINDOW_HOURS = Number(process.env.SHEPHERD_WINDOW_HOURS ?? 24);
export const RECENT_WINDOW_MS = (Number.isFinite(WINDOW_HOURS) ? WINDOW_HOURS : 24) * 3_600_000;

/** Dedicated, never-a-real-project cwd the periodic /usage probe (usage.ts)
 *  spawns its throwaway sessions in — there's no --json/--print equivalent
 *  for /usage, so reading the real numbers means launching an actual
 *  interactive session and scraping its rendered panel, which (confirmed
 *  the hard way) writes a genuine transcript file just like any other
 *  session. Excluded here by directory name so those probes never show up
 *  as bogus agent cards. */
export const USAGE_PROBE_CWD = path.join(os.tmpdir(), 'agent-shepherd-usage-probe');
const USAGE_PROBE_DIR_NAME = USAGE_PROBE_CWD.replace(/[:\\/]/g, '-');

/** All session transcript paths under ~/.claude/projects. */
export async function listSessionFiles(): Promise<string[]> {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(PROJECTS_DIR);
  } catch {
    return out;
  }
  for (const d of dirs) {
    if (d === USAGE_PROBE_DIR_NAME) continue;
    const full = path.join(PROJECTS_DIR, d);
    let files: string[];
    try {
      files = await readdir(full);
    } catch {
      continue;
    }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(full, f));
  }
  return out;
}

// --- issue-title enrichment -------------------------------------------------
// Resolve a human name for issue-worktree sessions from the GitHub issue title.
// Cached hard: repo slug per repo path, title per repo#issue. Fail-soft — any
// error just leaves the session's ai-title / branch label in place.

const repoCache = new Map<string, string | null>();
const titleCache = new Map<string, string | null>();

function issueNumber(label: string, branch: string | null): string | null {
  const m1 = /issue[-_]?(\d+)/i.exec(label);
  if (m1) return m1[1];
  const m2 = /(?:^|\/)(\d+)-/.exec(branch ?? '');
  if (m2) return m2[1];
  return null;
}

async function repoSlug(repoPath: string): Promise<string | null> {
  if (repoCache.has(repoPath)) return repoCache.get(repoPath)!;
  let slug: string | null = null;
  try {
    const { stdout } = await pexec('git', ['-C', repoPath, 'remote', 'get-url', 'origin']);
    const m = /github\.com[:/]([^/]+\/[^/.\s]+)/.exec(stdout.trim());
    slug = m ? m[1] : null;
  } catch {
    slug = null;
  }
  repoCache.set(repoPath, slug);
  return slug;
}

async function issueTitle(repoPath: string, n: string): Promise<string | null> {
  const repo = await repoSlug(repoPath);
  if (!repo) return null;
  const key = `${repo}#${n}`;
  if (titleCache.has(key)) return titleCache.get(key)!;
  let title: string | null = null;
  try {
    const { stdout } = await pexec(
      'gh',
      ['issue', 'view', n, '--repo', repo, '--json', 'title', '-q', '.title'],
      { timeout: 8000 },
    );
    title = stdout.trim() || null;
  } catch {
    title = null;
  }
  titleCache.set(key, title);
  return title;
}

/** Overlay GitHub issue titles onto issue-worktree sessions (best effort).
 *  Names are sent in full — the UI truncates for display and reveals the rest on hover. */
async function enrich(models: AgentModel[]): Promise<void> {
  await Promise.all(
    models.map(async (m) => {
      const n = issueNumber(m.label, m.branch);
      if (!n) return;
      const t = await issueTitle(m.repoPath, n);
      if (t) m.name = t.trim();
    }),
  );
}

async function mtimeMs(file: string): Promise<number> {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return 0;
  }
}

/** The expensive half of parsing (read + line-by-line JSON.parse of a
 *  possibly multi-MB transcript) keyed by file path, alongside the mtime it
 *  was computed at — see getRaw for why this is safe to reuse across scans.
 *  Point-in-time classification is deliberately NOT cached here (see
 *  classifySession's own doc comment): only parseSessionRaw's file-derived
 *  facts are. */
const rawCache = new Map<string, { mtimeMs: number; raw: RawSession | null }>();

/** parseSessionRaw(file) is a pure function of file content — same file at
 *  the same mtime always returns the same RawSession — so a scan that finds
 *  a file's mtime unchanged since the last scan can reuse the previous parse
 *  instead of re-reading and re-parsing it. Confirmed the hard way (#71)
 *  that skipping this caused every rescan to fully re-parse every session in
 *  the recent window (measured ~136MB across ~36 files on a normal working
 *  set) even though most of those files hadn't changed a single byte since
 *  the last rescan 15s (or less) earlier — real CPU work competing with the
 *  daemon's PTY handling for the same event loop. */
export async function getRaw(file: string, mtime: number): Promise<RawSession | null> {
  const cached = rawCache.get(file);
  if (cached && cached.mtimeMs === mtime) return cached.raw;
  // Off the main thread (#71, rawParsePool) — only reached on a cache miss,
  // i.e. a file that's new or changed since the last scan.
  const raw = await parseRawInWorker(file).catch(() => null);
  rawCache.set(file, { mtimeMs: mtime, raw });
  return raw;
}

/** Parse every session into a model, keep the recent ones, resolve names.
 *
 *  A user's `~/.claude/projects` accumulates one session file per worktree
 *  ever created — thousands over time — and fully parsing all of them on
 *  every rescan (the naive approach) blocks the single-threaded daemon for
 *  seconds. A file's mtime is exactly its last-write instant, i.e. its last
 *  activity, so stat-filtering to the recent window first (cheap) lets us
 *  skip the expensive read+parse for everything outside it. Among what's
 *  left, getRaw further skips the read+parse itself for any file whose
 *  mtime hasn't moved since the previous scan — classification (which DOES
 *  need to run fresh every time; see classifySession) is cheap by
 *  comparison. */
export async function scanAll(now: number): Promise<AgentModel[]> {
  const [files, hooks] = await Promise.all([listSessionFiles(), readHookStates(now)]);
  const mtimes = await Promise.all(files.map(mtimeMs));
  const candidates = files
    .map((f, i) => ({ file: f, mtime: mtimes[i] }))
    .filter(({ mtime }) => now - mtime <= RECENT_WINDOW_MS);

  // Keep the cache bounded to the current recent-window file set — otherwise
  // an entry for a file that ages out of the window (or is deleted) lingers
  // forever across a long-running daemon.
  const candidateFiles = new Set(candidates.map((c) => c.file));
  for (const key of rawCache.keys()) {
    if (!candidateFiles.has(key)) rawCache.delete(key);
  }

  const models = await Promise.all(
    candidates.map(async ({ file, mtime }) => {
      const raw = await getRaw(file, mtime);
      if (!raw) return null;
      return classifySession(raw, now, hooks.get(path.basename(file, '.jsonl')));
    }),
  );
  const recent = models.filter(
    (m): m is AgentModel => m !== null && now - m.lastActivity <= RECENT_WINDOW_MS,
  );
  await enrich(recent);
  return recent;
}

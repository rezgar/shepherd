import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSession } from './parse.js';
import type { AgentModel } from './types.js';

const pexec = promisify(execFile);

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Server keeps a generous window; the UI narrows it live. Tunable via env. */
const WINDOW_HOURS = Number(process.env.SHEPHERD_WINDOW_HOURS ?? 24);
export const RECENT_WINDOW_MS = (Number.isFinite(WINDOW_HOURS) ? WINDOW_HOURS : 24) * 3_600_000;

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

/** Parse every session into a model, keep the recent ones, resolve names. */
export async function scanAll(now: number): Promise<AgentModel[]> {
  const files = await listSessionFiles();
  const models = await Promise.all(files.map((f) => parseSession(f, now).catch(() => null)));
  const recent = models.filter(
    (m): m is AgentModel => m !== null && now - m.lastActivity <= RECENT_WINDOW_MS,
  );
  await enrich(recent);
  return recent;
}

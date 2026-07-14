import os from 'node:os';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { parseSession } from './parse.js';
import type { AgentModel } from './types.js';

export const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/** Only surface sessions active within this window — the cockpit is your current
 *  working set, not your whole history. Tunable via SHEPHERD_WINDOW_HOURS. */
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

/** Parse every session into a model, dropping the ones with no working context. */
export async function scanAll(now: number): Promise<AgentModel[]> {
  const files = await listSessionFiles();
  const models = await Promise.all(files.map((f) => parseSession(f, now).catch(() => null)));
  return models.filter(
    (m): m is AgentModel => m !== null && now - m.lastActivity <= RECENT_WINDOW_MS,
  );
}

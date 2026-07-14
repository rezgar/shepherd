import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentState } from './types.js';

/** Where the hook handler writes per-session state. */
export const HOOK_DIR = path.join(os.homedir(), '.claude', 'shepherd-state');

/** Ignore hook state older than this — a stale file shouldn't pin a dead session. */
const FRESH_MS = 15 * 60_000;

export interface HookState {
  state: AgentState;
  event: string;
  tool: string | null;
  /** Set when event is StopFailure — why the session terminated. */
  errorType: string | null;
  ts: number;
}

/** Read the fresh per-session hook states, keyed by session id. Empty if hooks
 *  aren't installed. */
export async function readHookStates(now: number): Promise<Map<string, HookState>> {
  const out = new Map<string, HookState>();
  let files: string[];
  try {
    files = await readdir(HOOK_DIR);
  } catch {
    return out;
  }
  await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map(async (f) => {
        try {
          const h = JSON.parse(await readFile(path.join(HOOK_DIR, f), 'utf8')) as HookState;
          if (h?.ts && h.state && now - h.ts <= FRESH_MS) out.set(path.basename(f, '.json'), h);
        } catch {
          /* ignore an unreadable/partial state file */
        }
      }),
  );
  return out;
}

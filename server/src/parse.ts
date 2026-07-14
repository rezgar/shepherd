import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { AgentModel, ActionKind, AgentState, Stage } from './types.js';

/** Recent activity within this window ⇒ the agent is actively working. */
const ACTIVE_WINDOW_MS = 60_000;
/** Past this, even an unfinished turn is treated as parked (agent likely gone). */
const STALE_MS = 10 * 60_000;

/** Strip a worktree suffix to find the owning repo. */
export function deriveProduct(cwd: string): { product: string; repoPath: string; label: string } {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const wtIdx = parts.findIndex((p) => p === '.worktrees' || p === '.claude');
  const repoParts = wtIdx >= 0 ? parts.slice(0, wtIdx) : parts;
  const product = repoParts[repoParts.length - 1] ?? cwd;
  const label = wtIdx >= 0 && parts[wtIdx + 1] ? parts[wtIdx + 1] : product;
  return { product, repoPath: repoParts.join('/'), label };
}

function gist(text: string, max = 84): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c as any).type === 'text')
      .map((c) => (c as any).text)
      .join(' ');
  }
  return '';
}

/** A specific description of a single tool call, from its inputs. */
function toolDetail(name: string, input: Record<string, unknown>): string {
  const n = name.toLowerCase();
  const base = (p: unknown) =>
    typeof p === 'string' ? (p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '') : '';
  if (/edit|write|notebook/.test(n) && input.file_path) return `editing ${base(input.file_path)}`;
  if (n.includes('read') && input.file_path) return `reading ${base(input.file_path)}`;
  if (n.includes('grep') && input.pattern) return `grep "${gist(String(input.pattern), 40)}"`;
  if (n.includes('glob') && input.pattern) return `find ${gist(String(input.pattern), 40)}`;
  if ((n.includes('bash') || n.includes('powershell')) && input.command)
    return gist(String(input.command), 90);
  if ((n.includes('task') || n.includes('agent')) && (input.description || input.subagent_type))
    return `subagent: ${String(input.description ?? input.subagent_type)}`;
  return '';
}

/** What a working agent is meaningfully doing now: the tool's own description
 *  (active-voice, human) → the agent's latest narration → a specific tool detail. */
function workingStatus(name: string, input: Record<string, unknown>, narration: string): string {
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  if (desc) return gist(desc, 200);
  if (narration) return gist(narration, 200);
  return toolDetail(name, input) || 'working…';
}

/** The stage is whatever the agent was most recently doing. */
function pickStage(signals: Stage[]): Stage {
  return signals.at(-1) ?? 'unknown';
}

/**
 * Parse one session transcript into an AgentModel.
 * Returns null for transcripts with no real working context (no cwd).
 */
export async function parseSession(file: string, now: number): Promise<AgentModel | null> {
  let cwd: string | null = null;
  let branch: string | null = null;
  let sessionId = path.basename(file, '.jsonl');
  let title: string | null = null;
  let permissionMode = 'default';
  let lastTs = 0;
  let queued = 0;

  let lastAssistantText = '';
  let lastAssistantStop: string | null = null;
  let lastToolName = '';
  let lastToolInput: Record<string, unknown> = {};
  let lastUserText = '';
  let lastEventKind = '';
  const stageSignals: Stage[] = [];

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.cwd) cwd = o.cwd;
    if (o.gitBranch) branch = o.gitBranch;
    if (o.sessionId) sessionId = o.sessionId;
    if (o.permissionMode) permissionMode = o.permissionMode;
    if (typeof o.timestamp === 'string') {
      const ts = Date.parse(o.timestamp);
      if (ts && ts > lastTs) lastTs = ts;
    }

    switch (o.type) {
      case 'ai-title':
        title = o.title ?? o.aiTitle ?? o.content ?? title;
        break;
      case 'permission-mode':
        if (o.permissionMode) permissionMode = o.permissionMode;
        break;
      case 'queue-operation':
        if (o.operation === 'enqueue') queued++;
        else queued = Math.max(0, queued - 1);
        break;
      case 'user': {
        const content = o.message?.content;
        const hasToolResult =
          Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result');
        const txt = textOf(content);
        if (hasToolResult) {
          lastEventKind = 'tool_result';
        } else if (txt.trim()) {
          lastUserText = txt.trim();
          lastEventKind = 'user';
        }
        const low = txt.toLowerCase();
        if (low.includes('/define') || low.includes('criteria of done')) stageSignals.push('definition');
        if (low.includes('/plan')) stageSignals.push('planning');
        if (low.includes('/implement')) stageSignals.push('implementation');
        if (low.includes('/tdd') || low.includes('/verify') || low.includes(' test')) stageSignals.push('testing');
        if (low.includes('error') || low.includes('failing') || low.includes('debug')) stageSignals.push('debugging');
        break;
      }
      case 'assistant': {
        const m = o.message ?? {};
        lastAssistantStop = m.stop_reason ?? null;
        lastEventKind = 'assistant';
        const txt = textOf(m.content);
        if (txt.trim()) lastAssistantText = txt.trim();
        const tools = Array.isArray(m.content)
          ? m.content.filter((c: any) => c?.type === 'tool_use')
          : [];
        if (tools.length) {
          const last = tools[tools.length - 1];
          lastToolName = String(last.name ?? '');
          lastToolInput = (last.input ?? {}) as Record<string, unknown>;
          for (const c of tools) {
            const name = String(c.name ?? '');
            const input = JSON.stringify(c.input ?? {}).toLowerCase();
            if (/edit|write/i.test(name)) stageSignals.push('implementation');
            else if (/read|grep|glob/i.test(name)) stageSignals.push('planning');
            if (input.includes('test') || input.includes('playwright') || input.includes('vitest'))
              stageSignals.push('testing');
          }
        }
        break;
      }
    }
  }

  if (!cwd) return null;

  const { product, repoPath, label: worktreeLabel } = deriveProduct(cwd);
  // A worktree names the card; otherwise fall back to the branch (e.g. "main"),
  // never repeat the product name that already heads the lane.
  const label = worktreeLabel !== product ? worktreeLabel : (branch ?? product);
  const idleMs = lastTs > 0 ? now - lastTs : Number.MAX_SAFE_INTEGER;
  const stage = pickStage(stageSignals);
  const autoRuns = permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits';

  let state: AgentState;
  let action: ActionKind | null = null;
  let status: string;

  const activelyRunning = idleMs < ACTIVE_WINDOW_MS;
  const finishedTurn = lastEventKind === 'assistant' && lastAssistantStop !== 'tool_use';
  const wantsTool = lastEventKind === 'assistant' && lastAssistantStop === 'tool_use';
  const endsWithQuestion = /\?["')\]]*\s*$/.test(lastAssistantText);

  if (wantsTool && !autoRuns && idleMs > 2_000 && idleMs < STALE_MS) {
    // paused on a tool call in an ask-for-permission mode → blocked on you
    state = 'needs-you';
    action = 'approve';
    const desc = typeof lastToolInput.description === 'string' ? lastToolInput.description.trim() : '';
    status = `wants: ${desc ? gist(desc, 160) : toolDetail(lastToolName, lastToolInput) || 'to run a tool'}`;
  } else if (finishedTurn && endsWithQuestion && idleMs < STALE_MS) {
    state = 'needs-you';
    action = 'question';
    status = gist(lastAssistantText, 200);
  } else if (activelyRunning && lastEventKind !== 'user') {
    state = 'working';
    status = workingStatus(lastToolName, lastToolInput, lastAssistantText);
  } else if (activelyRunning && lastEventKind === 'user') {
    state = 'working';
    status = 'thinking…';
  } else {
    state = 'idle';
    status = gist(lastAssistantText, 200) || gist(lastUserText, 200) || 'idle';
  }

  return {
    sessionId,
    product,
    repoPath,
    cwd,
    branch,
    label,
    name: title ?? label,
    title,
    state,
    stage,
    status,
    action,
    lastActivity: lastTs,
    queued,
    file,
  };
}

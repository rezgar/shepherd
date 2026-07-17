import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentModel, ActionKind, AgentState, Stage, TaskLine } from './types.js';
import type { HookState } from './hookState.js';

/** Recent activity within this window ⇒ the agent is actively working. */
const ACTIVE_WINDOW_MS = 60_000;
/** Past this, even an unfinished turn is treated as parked (agent likely gone). */
const STALE_MS = 10 * 60_000;
/** How long a hook-reported "working" is trusted without a follow-up hook
 *  event (PreToolUse/PostToolUse tick it forward during real work; Stop
 *  clears it on a normal finish). A user-interrupted turn doesn't reliably
 *  fire Stop, so without this the card would show "working" — wrongly — for
 *  the full 15-minute hook-state retention window. Real single-tool calls
 *  essentially never run this long between hook events, so this is safe to
 *  keep much tighter than that outer retention window. */
const WORKING_HOOK_TRUST_MS = 3 * 60_000;
/** Grace period after the transcript's own last event is already a
 *  *complete* assistant turn (no pending tool_use) before a hook-reported
 *  "working" gets overridden — covers the CLI's brief "running stop hooks"
 *  cleanup phase right after the visible response finishes generating.
 *  Much shorter than WORKING_HOOK_TRUST_MS because this isn't a timeout
 *  guess: a finished turn in the transcript is direct, unambiguous proof
 *  the turn is over, independent of whether Stop ever fires at all. */
const STOP_HOOK_GRACE_MS = 12_000;
/** How long a still-pending tool call in an auto-approving mode is assumed
 *  to still be running, absent any hook confirming it. PreToolUse only fires
 *  once at the start of a tool call — there's no heartbeat while it runs —
 *  so a genuinely long-running tool and a process that died mid-call look
 *  identical from here. This caps the benefit of the doubt well under the
 *  10-minute STALE_MS used elsewhere, matching the common explicit Bash-tool
 *  timeout (5m) seen in practice. */
const PENDING_TOOL_STALE_MS = 5 * 60_000;

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

/** The first question's own text, for a status line that reads better than a
 *  generic "wants: to run a tool". */
function askUserQuestionSummary(input: Record<string, unknown>): string {
  const questions = (input as any).questions;
  const first = Array.isArray(questions) ? questions[0] : undefined;
  const text = typeof first?.question === 'string' ? first.question : '';
  return text ? gist(text, 200) : 'has a question for you';
}

function isSubagentDispatch(name: string): boolean {
  return /task|agent/i.test(name);
}

// --- task/todo tracking -------------------------------------------------
// Sessions track their own checklist via one of two tool families, depending
// on Claude Code version: the classic `TodoWrite` (whole list replaced each
// call) or the newer `TaskCreate`/`TaskUpdate` (tasks created in bulk, then
// patched one at a time by a 1-based `taskId` matching creation order — the
// id isn't in the tool_use input, only in its tool_result text, so we infer
// it positionally instead of parsing that text).

export interface TaskItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function normalizeTaskStatus(s: unknown): TaskItem['status'] {
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}

function applyTaskTool(name: string, input: Record<string, unknown>, items: TaskItem[]): TaskItem[] {
  if (name === 'TodoWrite') {
    const todos = (input as any).todos;
    if (!Array.isArray(todos)) return items;
    return todos
      .filter((t: any) => t && typeof t.content === 'string')
      .map((t: any) => ({ content: t.content, status: normalizeTaskStatus(t.status) }));
  }
  if (name === 'TaskCreate') {
    const raw = (input as any).tasks;
    let created: any[] = [];
    if (typeof raw === 'string') {
      try {
        created = JSON.parse(raw);
      } catch {
        created = [];
      }
    } else if (Array.isArray(raw)) {
      created = raw;
    } else if (typeof (input as any).subject === 'string') {
      created = [{ content: (input as any).subject, status: 'pending' }];
    }
    if (!created.length) return items;
    const next = [...items];
    for (const t of created) {
      const content = typeof t?.content === 'string' ? t.content : typeof t?.subject === 'string' ? t.subject : null;
      if (!content) continue;
      next.push({ content, status: normalizeTaskStatus(t?.status) });
    }
    return next;
  }
  if (name === 'TaskUpdate') {
    const idx = Number((input as any).taskId) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) return items;
    const next = [...items];
    const cur = { ...next[idx] };
    if (typeof (input as any).subject === 'string') cur.content = (input as any).subject;
    if (typeof (input as any).status === 'string') cur.status = normalizeTaskStatus((input as any).status);
    next[idx] = cur;
    return next;
  }
  return items;
}

/** The in-progress task + every still-pending one after it, in order — the
 *  compact "current/upcoming" line shown on cards and in focus. Completed
 *  items carry no forward-looking information, so they're dropped entirely. */
function computeTaskLine(items: TaskItem[]): TaskLine | undefined {
  if (!items.length) return undefined;
  const currentIdx = items.findIndex((t) => t.status === 'in_progress');
  const current = currentIdx >= 0 ? items[currentIdx].content : null;
  const searchFrom = currentIdx >= 0 ? currentIdx + 1 : 0;
  const upcoming = items.slice(searchFrom).filter((t) => t.status === 'pending').map((t) => t.content);
  return { current, upcoming };
}

const CONTINUATION_WORDS = new Set([
  'ok', 'okay', 'k', 'yes', 'yep', 'yeah', 'yup', 'sure', 'go', 'go on', 'go ahead', 'next',
  'continue', 'resume', 'proceed', 'do it', 'please', 'thanks', 'thank you', 'ty', 'y', 'n', 'no',
  'done', 'good', 'nice', 'cool', 'merge', 'merge it', 'ship it',
]);

/** Is this user message a real instruction (worth showing as the card's high-
 *  level task) rather than a terse steer like "ok" / "continue" / "resume" that
 *  shouldn't overwrite the goal — or a system-injected user turn (a compaction
 *  summary, a slash-command caveat) that isn't the user talking at all. */
function isTaskLike(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  const bare = t.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  if (CONTINUATION_WORDS.has(bare)) return false;
  if (/^this session is being continued/i.test(t)) return false;
  if (/^<(local-command|command-)/i.test(t)) return false;
  return true;
}

/** What a working agent is meaningfully doing right now: the tool's own
 *  description (active-voice, human) → a specific detail pulled from its
 *  inputs → a generic placeholder. Never the agent's last spoken sentence —
 *  that's what it already said, not what it's doing this instant.
 *
 *  A subagent's own description is deliberately never shown here — active
 *  subagents get their own chips near the bottom-of-chat indicator instead,
 *  so the card just says the parent is waiting on them. */
function workingStatus(name: string, input: Record<string, unknown>): string {
  if (isSubagentDispatch(name)) return 'waiting on subagents…';
  const desc = typeof input.description === 'string' ? input.description.trim() : '';
  if (desc) return gist(desc, 200);
  return toolDetail(name, input) || 'thinking…';
}

/** The stage is whatever the agent was most recently doing. */
function pickStage(signals: Stage[]): Stage {
  return signals.at(-1) ?? 'unknown';
}

const ERROR_LABELS: Record<string, string> = {
  rate_limit: 'hit a rate limit',
  overloaded: 'API overloaded',
  server_error: 'API server error',
  billing_error: 'billing issue',
  max_output_tokens: 'hit max output length',
  authentication_failed: 'authentication failed',
  oauth_org_not_allowed: 'OAuth org not allowed',
  invalid_request: 'invalid request',
  model_not_found: 'model not found',
};

function errorStatus(errorType: string | null): string {
  if (!errorType) return 'session stopped on an error';
  return ERROR_LABELS[errorType] ?? `error: ${errorType}`;
}

/** Everything parseSessionRaw extracts from a transcript file — pure facts
 *  derived only from its content, nothing that depends on "now" or hook
 *  state. See parseSessionRaw's own doc comment for why this split exists:
 *  this half is safe to cache by (file, mtime), the classifySession half
 *  never is. */
export interface RawSession {
  file: string;
  sessionId: string;
  cwd: string;
  branch: string | null;
  title: string | null;
  permissionMode: string;
  lastTs: number;
  firstTs: number;
  queued: number;
  lastAssistantText: string;
  lastAssistantStop: string | null;
  lastToolName: string;
  lastToolInput: Record<string, unknown>;
  lastUserText: string;
  lastTaskText: string;
  lastEventKind: string;
  taskItems: TaskItem[];
  product: string;
  repoPath: string;
  label: string;
  stage: Stage;
}

/**
 * Read and parse one session transcript into its raw, file-derived facts —
 * the expensive half of what was previously one `parseSession` function,
 * split out (#71) because it's the ONLY half that's a pure function of file
 * content: given the same file at the same mtime, it always returns the same
 * result, so scanAll can safely cache it and skip re-reading/re-parsing a
 * multi-MB transcript on every rescan when nothing in it has actually
 * changed. Point-in-time classification (state/status/activity, which also
 * depend on `now` and live hook state) is deliberately NOT done here — see
 * classifySession. Returns null for transcripts with no real working context
 * (no cwd).
 */
export async function parseSessionRaw(file: string): Promise<RawSession | null> {
  let cwd: string | null = null;
  let branch: string | null = null;
  let sessionId = path.basename(file, '.jsonl');
  let title: string | null = null;
  let permissionMode = 'default';
  let lastTs = 0;
  let firstTs = 0;
  let queued = 0;

  let lastAssistantText = '';
  let lastAssistantStop: string | null = null;
  let lastToolName = '';
  let lastToolInput: Record<string, unknown> = {};
  let lastUserText = '';
  let lastTaskText = '';
  let lastEventKind = '';
  const stageSignals: Stage[] = [];
  let taskItems: TaskItem[] = [];

  // Snapshot read (not a streaming follow) so a live, growing transcript can't
  // stall the scan.
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }

  for (const line of raw.split('\n')) {
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
      if (ts) {
        if (ts > lastTs) lastTs = ts;
        if (firstTs === 0 || ts < firstTs) firstTs = ts;
      }
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
        // A subagent's completion notice, delivered as a "user" event — not
        // something the person said, never a task/status source. Same check
        // transcript.ts uses to keep it out of the rendered chat.
        if (o.origin?.kind === 'task-notification') break;
        const content = o.message?.content;
        const hasToolResult =
          Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result');
        const txt = textOf(content);
        const trimmed = txt.trim();
        // Claude Code's own synthetic notice when a tool call was interrupted
        // mid-flight, or the slash-command echo Shepherd's PTY driver types to
        // close out a turn (and its "Goodbye!" reply) — neither is something
        // the person said, never a task/status source.
        if (/^\[Request interrupted/i.test(trimmed) || /^<(local-command|command-)/i.test(trimmed)) break;
        if (hasToolResult) {
          lastEventKind = 'tool_result';
        } else if (txt.trim()) {
          lastUserText = txt.trim();
          if (isTaskLike(txt)) lastTaskText = txt.trim();
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
            if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') {
              taskItems = applyTaskTool(name, (c.input ?? {}) as Record<string, unknown>, taskItems);
            }
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
  const stage = pickStage(stageSignals);

  return {
    file,
    sessionId,
    cwd,
    branch,
    title,
    permissionMode,
    lastTs,
    firstTs,
    queued,
    lastAssistantText,
    lastAssistantStop,
    lastToolName,
    lastToolInput,
    lastUserText,
    lastTaskText,
    lastEventKind,
    taskItems,
    product,
    repoPath,
    label,
    stage,
  };
}

/**
 * Turn one session's raw, file-derived facts (see parseSessionRaw) into the
 * point-in-time AgentModel a client sees. Unlike parseSessionRaw, this is
 * NOT safe to cache — every branch below depends on `now` (idleMs, staleness
 * windows) and/or live hook state, so the same RawSession legitimately
 * classifies differently from one call to the next (e.g. ticking from
 * "working" to "idle" purely because time passed, with no new transcript
 * line at all). Always run this fresh.
 */
export function classifySession(raw: RawSession, now: number, hook?: HookState): AgentModel {
  const {
    file,
    sessionId,
    cwd,
    branch,
    title,
    permissionMode,
    lastTs,
    firstTs,
    queued,
    lastAssistantText,
    lastAssistantStop,
    lastToolName,
    lastToolInput,
    lastUserText,
    lastTaskText,
    lastEventKind,
    taskItems,
    product,
    repoPath,
    label,
    stage,
  } = raw;

  const idleMs = lastTs > 0 ? now - lastTs : Number.MAX_SAFE_INTEGER;
  const autoRuns = permissionMode === 'bypassPermissions' || permissionMode === 'acceptEdits';

  let state: AgentState;
  let action: ActionKind | null = null;
  let status: string;
  // Granular "what it's doing this instant" — surfaced in the focus view's ✽
  // indicator. The card's `status` stays at the higher task altitude while
  // working; `activity` carries the momentary detail so no granularity is lost.
  let activity = '';

  const activelyRunning = idleMs < ACTIVE_WINDOW_MS;
  const finishedTurn = lastEventKind === 'assistant' && lastAssistantStop !== 'tool_use';
  const wantsTool = lastEventKind === 'assistant' && lastAssistantStop === 'tool_use';
  const endsWithQuestion = /\?["')\]]*\s*$/.test(lastAssistantText);
  // AskUserQuestion always genuinely blocks on a human, in EVERY permission
  // mode — unlike every other tool, `--dangerously-skip-permissions` doesn't
  // (can't) auto-answer it. Confirmed the hard way: under bypass permissions
  // the generic "pending tool call" branches below classify a stuck question
  // as ordinary auto-approved "working" activity, so the card just reads
  // "thinking…" — nothing ever flags that it's actually waiting on you,
  // indistinguishable from genuinely idle unless you go check the terminal.
  const pendingQuestion = wantsTool && lastToolName === 'AskUserQuestion';

  // The card's status while working: the task you gave it (the last substantive
  // instruction), gisted — one altitude below `stage`. Falls back to narration
  // then a placeholder. Granular tool activity goes to `activity` instead.
  const taskStatus = gist(lastTaskText || lastUserText, 200) || gist(lastAssistantText, 200) || 'working…';

  // A hook-reported "working" is overridden in three cases: (1) it's simply
  // stale with no follow-up event (Stop doesn't reliably fire on interrupt),
  // (2) — the precise, non-timeout-guess case — the transcript's own last
  // event is ALREADY a complete assistant turn (Claude Code always writes
  // that reliably even when the Stop hook itself lags or never fires at
  // all), or (3) the transcript shows a pending AskUserQuestion — the CLI
  // cannot simultaneously be "working" and blocked on a question, so a
  // "working" hook here is definitely stale, not just possibly so.
  const hookStale = !!hook && now - hook.ts > WORKING_HOOK_TRUST_MS;
  const transcriptAlreadyFinished = finishedTurn && idleMs > STOP_HOOK_GRACE_MS;
  const trustedHook =
    hook?.state === 'working' && (hookStale || transcriptAlreadyFinished || pendingQuestion) ? undefined : hook;

  if (pendingQuestion) {
    // Ground truth from the transcript itself, ahead of every hook-based
    // branch below: a complete assistant turn ending in an AskUserQuestion
    // tool_use is unambiguous proof it's blocked waiting on you, in any
    // permission mode, hook or no hook.
    state = 'needs-you';
    action = 'question';
    status = askUserQuestionSummary(lastToolInput);
  } else if (trustedHook?.state === 'error') {
    // exact: StopFailure fired — the session terminated on a rate limit / API / billing error
    state = 'error';
    status = errorStatus(trustedHook.errorType);
  } else if (trustedHook?.state === 'working') {
    // exact: Claude Code told us it's running (incl. while subagents work)
    state = 'working';
    activity = lastToolName
      ? workingStatus(lastToolName, lastToolInput)
      : trustedHook.tool
        ? `running ${trustedHook.tool}`
        : gist(lastAssistantText, 200) || 'thinking…';
    status = taskStatus;
  } else if (trustedHook?.state === 'needs-you') {
    // exact: a Notification fired — it wants your attention
    state = 'needs-you';
    if (endsWithQuestion) {
      action = 'question';
      status = gist(lastAssistantText, 200);
    } else {
      action = 'approve';
      const d = typeof lastToolInput.description === 'string' ? lastToolInput.description.trim() : '';
      status = wantsTool
        ? `wants: ${d ? gist(d, 160) : toolDetail(lastToolName, lastToolInput) || 'to run a tool'}`
        : 'needs your attention';
    }
  } else if (trustedHook?.state === 'idle') {
    // exact: the turn stopped — but a trailing question still needs you
    if (endsWithQuestion && idleMs < STALE_MS) {
      state = 'needs-you';
      action = 'question';
      status = gist(lastAssistantText, 200);
    } else {
      state = 'idle';
      status = gist(lastAssistantText, 200) || gist(lastUserText, 200) || 'idle';
    }
  } else if (wantsTool && !autoRuns && idleMs > 2_000 && idleMs < STALE_MS) {
    // paused on a tool call in an ask-for-permission mode → blocked on you
    state = 'needs-you';
    action = 'approve';
    const desc = typeof lastToolInput.description === 'string' ? lastToolInput.description.trim() : '';
    status = `wants: ${desc ? gist(desc, 160) : toolDetail(lastToolName, lastToolInput) || 'to run a tool'}`;
  } else if (finishedTurn && endsWithQuestion && idleMs < STALE_MS) {
    state = 'needs-you';
    action = 'question';
    status = gist(lastAssistantText, 200);
  } else if (wantsTool && autoRuns && idleMs < PENDING_TOOL_STALE_MS) {
    // executing a tool (including a subagent) in an auto-approving mode — the
    // session is still running even if it hasn't written for a while.
    state = 'working';
    activity = workingStatus(lastToolName, lastToolInput);
    status = taskStatus;
  } else if (activelyRunning && lastEventKind !== 'user' && !finishedTurn) {
    // Recent assistant/tool activity that ISN'T a completed turn — e.g.
    // between a tool dispatch and its result. A *finished* turn (full text,
    // stop_reason already written) is excluded here even if it just
    // happened: Claude Code only writes a complete message object, never a
    // partial one, so seeing `stop_reason` at all means there's nothing left
    // to stream — recency alone doesn't make a finished turn "working".
    state = 'working';
    activity = workingStatus(lastToolName, lastToolInput);
    status = taskStatus;
  } else if (activelyRunning && lastEventKind === 'user') {
    state = 'working';
    activity = 'thinking…';
    status = taskStatus;
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
    activity,
    action,
    lastActivity: lastTs,
    createdAt: firstTs || lastTs,
    queued,
    file,
    taskLine: computeTaskLine(taskItems),
  };
}

/**
 * Parse one session transcript into an AgentModel — convenience wrapper
 * combining parseSessionRaw + classifySession for callers that don't need
 * the raw/classify split's caching benefit (a one-off read, not a scan over
 * many files on a recurring interval). scanAll uses the two halves directly
 * instead, to cache the raw half by (file, mtime).
 * Returns null for transcripts with no real working context (no cwd).
 */
export async function parseSession(
  file: string,
  now: number,
  hook?: HookState,
): Promise<AgentModel | null> {
  const raw = await parseSessionRaw(file);
  if (!raw) return null;
  return classifySession(raw, now, hook);
}

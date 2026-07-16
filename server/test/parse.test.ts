import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSession, deriveProduct } from '../src/parse.js';

const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: object[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

const NOW = Date.parse('2026-07-14T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('deriveProduct', () => {
  it('uses the repo folder name', () => {
    expect(deriveProduct('C:\\Code\\totem\\wikifix').product).toBe('wikifix');
  });
  it('strips a worktree suffix and labels by worktree', () => {
    const d = deriveProduct('C:/Code/totem/wikifix/.worktrees/issue-397');
    expect(d.product).toBe('wikifix');
    expect(d.label).toBe('issue-397');
  });
});

describe('parseSession state classification', () => {
  it('returns null when there is no working context', async () => {
    const f = write('meta.jsonl', [{ type: 'mode', mode: 'normal', sessionId: 'x' }]);
    expect(await parseSession(f, NOW)).toBeNull();
  });

  it('flags a stale question as needs-you/question', async () => {
    const f = write('q.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: ago(300_000), message: { role: 'user', content: 'go' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(200_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which auth model should we use?' }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('needs-you');
    expect(m.action).toBe('question');
    expect(m.product).toBe('wikifix');
  });

  it('flags a paused tool call in ask-mode as needs-you/approve', async () => {
    const f = write('approve.jsonl', [
      { type: 'permission-mode', permissionMode: 'default', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/skills-for-jira-cloud', timestamp: ago(120_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('needs-you');
    expect(m.action).toBe('approve');
  });

  it('treats a paused tool call as working when permissions are bypassed', async () => {
    const f = write('bypass.jsonl', [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(5_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: { path: 'a.ts' } }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('working');
    expect(m.stage).toBe('implementation');
  });

  it('a pending AskUserQuestion is needs-you/question even under bypass permissions — it always genuinely blocks on a human', async () => {
    const f = write('bypass-question.jsonl', [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      {
        type: 'assistant',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(1_000),
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Quick check before I proceed:' },
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: { questions: [{ question: 'Pick a fruit', options: [{ label: 'Apple' }, { label: 'Banana' }] }] },
            },
          ],
        },
      },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('needs-you');
    expect(m.action).toBe('question');
    expect(m.status).toBe('Pick a fruit');
  });

  it('a pending AskUserQuestion overrides a stale "working" hook — the CLI cannot be working AND blocked on a question', async () => {
    const f = write('bypass-question-hook.jsonl', [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'q1' },
      {
        type: 'assistant',
        cwd: 'C:/Code/totem/wikifix',
        sessionId: 'q1',
        timestamp: ago(1_000),
        message: {
          role: 'assistant',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Continue?', options: [] }] } }],
        },
      },
    ]);
    const hook = { state: 'working' as const, event: 'PreToolUse', tool: 'AskUserQuestion', errorType: null, ts: NOW };
    const m = (await parseSession(f, NOW, hook))!;
    expect(m.state).toBe('needs-you');
    expect(m.action).toBe('question');
  });

  it('a pending tool call in bypass mode with no activity for 6+ minutes is no longer assumed to be working', async () => {
    const f = write('bypass-stale.jsonl', [
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(6 * 60_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npx vitest run' } }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).not.toBe('working');
  });

  it('marks an old finished session as idle', async () => {
    const f = write('idle.jsonl', [
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(3 * 3600_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, opened the PR.' }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('idle');
  });

  it('while working, the card status shows the task and activity carries the granular detail', async () => {
    const f = write('task.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', gitBranch: 'main', timestamp: ago(20_000), message: { role: 'user', content: 'make the status message use a more general description' } },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(5_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'parse.ts', description: 'Split status into task + activity' } }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('working');
    expect(m.status).toBe('make the status message use a more general description');
    expect(m.activity).toBe('Split status into task + activity');
  });

  it('a terse follow-up (continue) does not overwrite the task on the card', async () => {
    const f = write('followup.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(60_000), message: { role: 'user', content: 'refactor the finder pipeline to stream results' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(50_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(10_000), message: { role: 'user', content: 'continue' } },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(5_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'Run the suite' } }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('working');
    expect(m.status).toBe('refactor the finder pipeline to stream results');
  });
});

describe('parseSession ignores synthetic interruption notices', () => {
  it('never uses "[Request interrupted by user]" as the idle status', async () => {
    const f = write('interrupted-status.jsonl', [
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(20_000), message: { role: 'assistant', content: [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } }] } },
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(10_000), message: { role: 'user', content: '[Request interrupted by user]' } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.status).not.toContain('Request interrupted');
  });

  it('never uses a subagent\'s <task-notification> XML as the card status while its dispatch is still pending', async () => {
    const f = write('task-notification-status.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(60_000), message: { role: 'user', content: 'audit the scan pipeline for slow queries' } },
      { type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(55_000), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Agent', input: { description: 'Audit scan pipeline' } }] } },
      {
        type: 'user',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(5_000),
        origin: { kind: 'task-notification' },
        message: { role: 'user', content: '<task-notification>\n<task-id>bdwgikkpu</task-id>\n<tool-use-id>toolu_01</tool-use-id>\n<output-file>C:\\tmp\\bdwgikkpu.output</output-file>\n<status>completed</status>\n<summary>done</summary>' },
      },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('working');
    expect(m.status).not.toContain('task-notification');
    expect(m.status).toBe('audit the scan pipeline for slow queries');
    expect(m.activity).toBe('waiting on subagents…');
  });

  it('the "/exit" command echo used to close a PTY-driven send does not flip a finished turn back to "working"', async () => {
    const f = write('exit-noise-status.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(60_000), message: { role: 'user', content: 'fix the flaky retry test' } },
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(50_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — the fix is in place.' }] } },
      {
        type: 'user',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(4_000),
        message: { role: 'user', content: '<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>' },
      },
      {
        type: 'user',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(3_000),
        message: { role: 'user', content: '<local-command-stdout>Goodbye!</local-command-stdout>' },
      },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('idle');
    expect(m.status).toBe('Done — the fix is in place.');
  });
});

describe('parseSession taskLine', () => {
  it('is undefined when the session never used a task-tracking tool', async () => {
    const f = write('no-tasks.jsonl', [
      { type: 'user', cwd: 'C:/Code/totem/wikifix', timestamp: ago(5_000), message: { role: 'user', content: 'hi' } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.taskLine).toBeUndefined();
  });

  it('derives current + all upcoming from TodoWrite, replacing the list on each call', async () => {
    const f = write('todowrite.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(20_000),
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'Read the code', status: 'in_progress' },
          { content: 'Write the fix', status: 'pending' },
        ] } }] },
      },
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(5_000),
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
          { content: 'Read the code', status: 'completed' },
          { content: 'Write the fix', status: 'in_progress' },
          { content: 'Run tests', status: 'pending' },
          { content: 'Open PR', status: 'pending' },
        ] } }] },
      },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.taskLine).toEqual({ current: 'Write the fix', upcoming: ['Run tests', 'Open PR'] });
  });

  it('derives current + all upcoming from TaskCreate + positional TaskUpdate', async () => {
    const f = write('taskcreate.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(30_000),
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskCreate', input: {
          tasks: JSON.stringify([
            { content: 'Explore', status: 'pending' },
            { content: 'Implement', status: 'pending' },
            { content: 'Verify', status: 'pending' },
            { content: 'Ship', status: 'pending' },
          ]),
        } }] },
      },
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(20_000),
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }] },
      },
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(10_000),
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } }] },
      },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.taskLine).toEqual({ current: 'Implement', upcoming: ['Verify', 'Ship'] });
  });
});

describe('hook state overrides the heuristic', () => {
  const pending = (name: string) =>
    write(name, [
      {
        type: 'assistant',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(5 * 60_000),
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Task', input: { subagent_type: 'Explore' } }] },
      },
    ]);

  it('working hook → working (subagent running) even when the heuristic would say needs-you', async () => {
    const m = (await parseSession(pending('hookw.jsonl'), NOW, { state: 'working', event: 'SubagentStop', tool: 'Task', errorType: null, ts: NOW }))!;
    expect(m.state).toBe('working');
  });

  it('Notification hook → needs-you', async () => {
    const m = (await parseSession(pending('hookn.jsonl'), NOW, { state: 'needs-you', event: 'Notification', tool: null, errorType: null, ts: NOW }))!;
    expect(m.state).toBe('needs-you');
  });

  it('Stop hook with a trailing question still needs you', async () => {
    const f = write('hookq.jsonl', [
      {
        type: 'assistant',
        cwd: 'C:/Code/totem/wikifix',
        timestamp: ago(60_000),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Which option do you prefer?' }] },
      },
    ]);
    const m = (await parseSession(f, NOW, { state: 'idle', event: 'Stop', tool: null, errorType: null, ts: NOW }))!;
    expect(m.state).toBe('needs-you');
    expect(m.action).toBe('question');
  });

  it('a stale "working" hook with no follow-up event falls back to the transcript heuristic instead of staying stuck', async () => {
    const f = write('hook-stale-working.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(4 * 60_000),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, opened the PR.' }] },
      },
    ]);
    // UserPromptSubmit wrote "working" 4 minutes ago; nothing (no PreToolUse/
    // PostToolUse/Stop) has refreshed it since — e.g. an interrupted turn,
    // which doesn't reliably fire Stop.
    const m = (await parseSession(f, NOW, { state: 'working', event: 'UserPromptSubmit', tool: null, errorType: null, ts: NOW - 4 * 60_000 }))!;
    expect(m.state).not.toBe('working');
  });

  it('a fresh "working" hook (well within the trust window) is still honored', async () => {
    const f = write('hook-fresh-working.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(30_000),
        message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm test' } }] },
      },
    ]);
    const m = (await parseSession(f, NOW, { state: 'working', event: 'PreToolUse', tool: 'Bash', errorType: null, ts: NOW - 30_000 }))!;
    expect(m.state).toBe('working');
  });

  it('a "working" hook is overridden the moment the transcript itself shows a finished turn, without waiting out the full trust window', async () => {
    // The exact bug this guards against: the visible response is already
    // fully written (a complete, non-tool-use assistant turn) — Claude Code
    // wrote that reliably — but the Stop hook lagged or never fired, so the
    // hook file is still "working" from an earlier PreToolUse, well inside
    // the 3-minute trust window. The transcript's own shape is stronger
    // evidence than that timer.
    const f = write('hook-finished-turn.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(20_000),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, opened the PR.' }] },
      },
    ]);
    const m = (await parseSession(f, NOW, { state: 'working', event: 'PreToolUse', tool: 'Bash', errorType: null, ts: NOW - 20_000 }))!;
    expect(m.state).not.toBe('working');
  });

  it('a "working" hook right after a finished turn is still honored during the brief stop-hooks grace window', async () => {
    const f = write('hook-finished-turn-grace.jsonl', [
      {
        type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(3_000),
        message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, opened the PR.' }] },
      },
    ]);
    const m = (await parseSession(f, NOW, { state: 'working', event: 'PreToolUse', tool: 'Bash', errorType: null, ts: NOW - 3_000 }))!;
    expect(m.state).toBe('working');
  });

  it('StopFailure hook → error, with a human status for the error_type', async () => {
    const m = (await parseSession(pending('hooke.jsonl'), NOW, {
      state: 'error',
      event: 'StopFailure',
      tool: null,
      errorType: 'rate_limit',
      ts: NOW,
    }))!;
    expect(m.state).toBe('error');
    expect(m.status).toBe('hit a rate limit');
  });

  it('StopFailure hook with an unrecognized error_type still surfaces it', async () => {
    const m = (await parseSession(pending('hooke2.jsonl'), NOW, {
      state: 'error',
      event: 'StopFailure',
      tool: null,
      errorType: 'weird_new_error',
      ts: NOW,
    }))!;
    expect(m.state).toBe('error');
    expect(m.status).toBe('error: weird_new_error');
  });
});

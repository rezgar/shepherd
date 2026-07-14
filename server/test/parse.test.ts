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

  it('marks an old finished session as idle', async () => {
    const f = write('idle.jsonl', [
      { type: 'assistant', cwd: 'C:/Code/totem/wikifix', timestamp: ago(3 * 3600_000), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done, opened the PR.' }] } },
    ]);
    const m = (await parseSession(f, NOW))!;
    expect(m.state).toBe('idle');
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

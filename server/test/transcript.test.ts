import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseTranscript } from '../src/transcript.js';

const dir = mkdtempSync(path.join(tmpdir(), 'shepherd-transcript-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: object[]): string {
  const p = path.join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n'));
  return p;
}

const dispatch = (toolUseId: string, description: string, ts: string) => ({
  type: 'assistant',
  timestamp: ts,
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description } }],
  },
});

const launchResult = (toolUseId: string, agentId: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'launched' }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId },
});

const taskNotification = (taskId: string, status: string, ts: string) => ({
  type: 'user',
  timestamp: ts,
  origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`,
  },
});

// The notification is written here the instant a subagent finishes, whether
// or not it's ever also promoted to a "user" turn — some never are (real bug
// found live: a completed research agent stayed "active" forever because its
// notification only ever existed as this event, never promoted).
const queuedNotification = (taskId: string, status: string, ts: string) => ({
  type: 'queue-operation',
  timestamp: ts,
  content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n</task-notification>`,
});

describe('parseTranscript: active subagents', () => {
  it('reports a dispatched subagent as active once its launch tool_result names it', async () => {
    const f = write('active.jsonl', [
      dispatch('toolu_1', 'Audit scan pipeline', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_1', 'agent-abc123', '2026-07-14T12:00:00.100Z'),
    ]);
    const { activeSubagents } = await parseTranscript(f, 'parent1');
    expect(activeSubagents).toEqual([
      { agentId: 'agent-abc123', description: 'Audit scan pipeline', dispatchedAt: Date.parse('2026-07-14T12:00:00.000Z') },
    ]);
  });

  it('drops a subagent once its task-notification reports a terminal status', async () => {
    const f = write('done.jsonl', [
      dispatch('toolu_2', 'Audit scan pipeline', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_2', 'agent-def456', '2026-07-14T12:00:00.100Z'),
      taskNotification('agent-def456', 'completed', '2026-07-14T12:05:00.000Z'),
    ]);
    const { activeSubagents } = await parseTranscript(f, 'parent2');
    expect(activeSubagents).toEqual([]);
  });

  it('drops a killed subagent too — any terminal status ends "active"', async () => {
    const f = write('killed.jsonl', [
      dispatch('toolu_3', 'Audit scan pipeline', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_3', 'agent-ghi789', '2026-07-14T12:00:00.100Z'),
      taskNotification('agent-ghi789', 'killed', '2026-07-14T12:01:00.000Z'),
    ]);
    const { activeSubagents } = await parseTranscript(f, 'parent3');
    expect(activeSubagents).toEqual([]);
  });

  it('keeps a still-running subagent active even once the parent stops writing', async () => {
    // Mirrors a real scenario: the parent goes quiet waiting on the subagent,
    // which itself keeps grinding for much longer than the parent's own
    // "actively running" window — no further parent events change that.
    const f = write('parent-idle.jsonl', [
      dispatch('toolu_4', 'Long-running trace hunt', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_4', 'agent-jkl012', '2026-07-14T12:00:00.100Z'),
    ]);
    const { activeSubagents } = await parseTranscript(f, 'parent4');
    expect(activeSubagents).toHaveLength(1);
    expect(activeSubagents[0].agentId).toBe('agent-jkl012');
  });

  it('ignores an in-flight dispatch with no launch tool_result yet (not active until we can locate its file)', async () => {
    const f = write('pending.jsonl', [dispatch('toolu_5', 'Just dispatched', '2026-07-14T12:00:00.000Z')]);
    const { activeSubagents } = await parseTranscript(f, 'parent5');
    expect(activeSubagents).toEqual([]);
  });

  it('drops a subagent whose notification only ever exists as a queue-operation, never promoted to a user turn', async () => {
    const f = write('queue-only.jsonl', [
      dispatch('toolu_7', 'Research Claude Code Notification hook payload', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_7', 'ae221655f3506887a', '2026-07-14T12:00:00.100Z'),
      queuedNotification('ae221655f3506887a', 'completed', '2026-07-14T12:05:00.000Z'),
    ]);
    const { activeSubagents } = await parseTranscript(f, 'parent7');
    expect(activeSubagents).toEqual([]);
  });

  it('extracts AskUserQuestion into structured questions instead of a bare chip', async () => {
    const f = write('ask.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-07-14T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_ask',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    header: 'Status signal',
                    question: 'Which signal should drive the high-level status?',
                    multiSelect: false,
                    options: [
                      { label: 'The task you gave it', description: 'Show the current instruction.' },
                      { label: 'The last thing it said', description: 'Show the latest narration.' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
    ]);
    const { messages } = await parseTranscript(f, 'parent-ask');
    const tool = messages.at(-1)!.tools[0];
    expect(tool.name).toBe('AskUserQuestion');
    expect(tool.questions).toHaveLength(1);
    expect(tool.questions![0].question).toBe('Which signal should drive the high-level status?');
    expect(tool.questions![0].options.map((o) => o.label)).toEqual(['The task you gave it', 'The last thing it said']);
  });

  it('leaves questions undefined for a normal (non-AskUserQuestion) tool', async () => {
    const f = write('normal-tool.jsonl', [
      {
        type: 'assistant',
        timestamp: '2026-07-14T12:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'ls', description: 'list files' } }],
        },
      },
    ]);
    const { messages } = await parseTranscript(f, 'parent-normal');
    expect(messages.at(-1)!.tools[0].questions).toBeUndefined();
  });

  it('never renders the task-notification body as a chat message', async () => {
    const f = write('notif-render.jsonl', [
      dispatch('toolu_6', 'Audit scan pipeline', '2026-07-14T12:00:00.000Z'),
      launchResult('toolu_6', 'agent-mno345', '2026-07-14T12:00:00.100Z'),
      taskNotification('agent-mno345', 'completed', '2026-07-14T12:05:00.000Z'),
    ]);
    const { messages } = await parseTranscript(f, 'parent6');
    expect(messages.some((m) => m.text.includes('task-notification'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import type { AgentModel } from '../types';
import { stripAgents, stripOrder } from './order';

function agent(over: Partial<AgentModel> & { sessionId: string }): AgentModel {
  return {
    product: 'p',
    repoPath: '/p',
    cwd: '/p',
    branch: 'main',
    label: 'main',
    title: null,
    name: over.sessionId,
    state: 'working',
    stage: 'unknown',
    status: '',
    activity: '',
    action: null,
    lastActivity: 0,
    createdAt: 0,
    queued: 0,
    file: `/p/${over.sessionId}.jsonl`,
    ...over,
  };
}

describe('stripAgents', () => {
  const a = agent({ sessionId: 'a' });
  const b = agent({ sessionId: 'b' });
  const c = agent({ sessionId: 'c' });
  const agents = [a, b, c];

  it('shows explicitly-opened sessions', () => {
    const out = stripAgents(agents, { a: 1, b: 2 }, {}, null);
    expect(out.map((x) => x.sessionId)).toEqual(['a', 'b']);
  });

  it('excludes a hidden session even if it was opened', () => {
    const out = stripAgents(agents, { a: 1, b: 2 }, { b: true }, null);
    expect(out.map((x) => x.sessionId)).toEqual(['a']);
  });

  it('always includes the focused session, even if hidden or not opened', () => {
    const hiddenFocused = stripAgents(agents, { a: 1, c: 3 }, { c: true }, 'c');
    expect(hiddenFocused.map((x) => x.sessionId).sort()).toEqual(['a', 'c']);
    const unopenedFocused = stripAgents(agents, { a: 1 }, {}, 'b');
    expect(unopenedFocused.map((x) => x.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('does not show unopened, unhidden, unfocused sessions', () => {
    expect(stripAgents(agents, {}, {}, null)).toEqual([]);
  });
});

describe('stripOrder', () => {
  it('flattens grouped-by-product in first-opened order', () => {
    // product p opened first (at 1), product q later (at 2); within p, a before c
    const agents = [
      agent({ sessionId: 'c', product: 'p' }),
      agent({ sessionId: 'q1', product: 'q' }),
      agent({ sessionId: 'a', product: 'p' }),
    ];
    const openedAt = { a: 1, c: 3, q1: 2 };
    expect(stripOrder(agents, openedAt).map((x) => x.sessionId)).toEqual(['a', 'c', 'q1']);
  });
});

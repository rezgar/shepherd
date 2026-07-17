import { describe, it, expect } from 'vitest';
import type { AgentModel, AgentState } from '../types';
import { groupByProduct } from './format';

function agent(over: Partial<AgentModel> & { sessionId: string }): AgentModel {
  return {
    product: 'p',
    repoPath: '/p',
    cwd: '/p',
    branch: 'main',
    label: 'main',
    title: null,
    name: over.sessionId,
    state: 'idle' as AgentState,
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

describe('groupByProduct (active-first within a lane)', () => {
  it('sorts active sessions before idle ones', () => {
    // idle 'a' was created first; 'w' is working, 'q' needs you
    const agents = [
      agent({ sessionId: 'a', state: 'idle', createdAt: 1 }),
      agent({ sessionId: 'w', state: 'working', createdAt: 2 }),
      agent({ sessionId: 'q', state: 'needs-you', createdAt: 3 }),
    ];
    const [, ags] = groupByProduct(agents)[0];
    // needs-you and working (active) come before idle; error<needs-you<working<idle
    expect(ags.map((x) => x.sessionId)).toEqual(['q', 'w', 'a']);
  });

  it('breaks ties within a state by most-recent activity', () => {
    const agents = [
      agent({ sessionId: 'old', state: 'working', lastActivity: 100 }),
      agent({ sessionId: 'new', state: 'working', lastActivity: 500 }),
    ];
    const [, ags] = groupByProduct(agents)[0];
    expect(ags.map((x) => x.sessionId)).toEqual(['new', 'old']);
  });

  it('keeps lane order stable by earliest project creation, regardless of session state', () => {
    // product p created earliest (createdAt 1), q later (5) — even though q has
    // an active session and p's earliest is idle
    const agents = [
      agent({ sessionId: 'p1', product: 'p', state: 'idle', createdAt: 1 }),
      agent({ sessionId: 'q1', product: 'q', state: 'working', createdAt: 5 }),
    ];
    expect(groupByProduct(agents).map(([prod]) => prod)).toEqual(['p', 'q']);
  });

  it('puts errors and needs-you ahead of working, and idle last', () => {
    const agents = [
      agent({ sessionId: 'i', state: 'idle' }),
      agent({ sessionId: 'w', state: 'working' }),
      agent({ sessionId: 'e', state: 'error' }),
      agent({ sessionId: 'n', state: 'needs-you' }),
    ];
    const [, ags] = groupByProduct(agents)[0];
    expect(ags.map((x) => x.sessionId)).toEqual(['e', 'n', 'w', 'i']);
  });
});

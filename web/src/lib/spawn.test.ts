import { describe, it, expect } from 'vitest';
import type { AgentModel } from '../types';
import { detectNewlySpawned } from './spawn';

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

describe('detectNewlySpawned', () => {
  it('returns a session created at/after the spawn request for a pending product', () => {
    const agents = [agent({ sessionId: 'new', product: 'p', createdAt: 200 })];
    const out = detectNewlySpawned(agents, new Map([['p', 100]]));
    expect(out).toEqual([{ product: 'p', file: '/p/new.jsonl', sessionId: 'new' }]);
  });

  it('ignores sessions created before the spawn request', () => {
    const agents = [agent({ sessionId: 'old', product: 'p', createdAt: 50 })];
    expect(detectNewlySpawned(agents, new Map([['p', 100]]))).toEqual([]);
  });

  it('returns nothing when no spawn is pending', () => {
    const agents = [agent({ sessionId: 'x', product: 'p', createdAt: 999 })];
    expect(detectNewlySpawned(agents, new Map())).toEqual([]);
  });

  it('picks the newest session when several appeared after the request', () => {
    const agents = [
      agent({ sessionId: 'a', product: 'p', createdAt: 150 }),
      agent({ sessionId: 'b', product: 'p', createdAt: 300 }),
    ];
    const out = detectNewlySpawned(agents, new Map([['p', 100]]));
    expect(out).toEqual([{ product: 'p', file: '/p/b.jsonl', sessionId: 'b' }]);
  });

  it('does not match a different product', () => {
    const agents = [agent({ sessionId: 'q', product: 'other', createdAt: 200 })];
    expect(detectNewlySpawned(agents, new Map([['p', 100]]))).toEqual([]);
  });

  it('returns one entry per pending product', () => {
    const agents = [
      agent({ sessionId: 'pa', product: 'p', createdAt: 200 }),
      agent({ sessionId: 'qa', product: 'q', createdAt: 200 }),
    ];
    const out = detectNewlySpawned(agents, new Map([['p', 100], ['q', 100]]));
    expect(out.map((o) => o.sessionId).sort()).toEqual(['pa', 'qa']);
  });
});

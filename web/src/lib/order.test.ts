import { describe, it, expect } from 'vitest';
import type { AgentModel } from '../types';
import { stripAgents, stripOrder, groupStrip, reorder, neighborAfterClose, type StripState } from './order';

const st = (over: Partial<StripState> = {}): StripState => ({
  openedAt: {},
  productOrder: [],
  sessionOrder: {},
  ...over,
});

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

describe('stripOrder (open-time fallback)', () => {
  it('flattens grouped-by-product in first-opened order when no manual order', () => {
    // product p opened first (at 1), product q later (at 2); within p, a before c
    const agents = [
      agent({ sessionId: 'c', product: 'p' }),
      agent({ sessionId: 'q1', product: 'q' }),
      agent({ sessionId: 'a', product: 'p' }),
    ];
    expect(stripOrder(agents, st({ openedAt: { a: 1, c: 3, q1: 2 } })).map((x) => x.sessionId)).toEqual([
      'a',
      'c',
      'q1',
    ]);
  });
});

describe('neighborAfterClose', () => {
  const order = [agent({ sessionId: 'a' }), agent({ sessionId: 'b' }), agent({ sessionId: 'c' })];
  it('lands on the previous session when closing a middle/last one', () => {
    expect(neighborAfterClose(order, 'b')?.sessionId).toBe('a');
    expect(neighborAfterClose(order, 'c')?.sessionId).toBe('b');
  });
  it('lands on the next session when closing the first', () => {
    expect(neighborAfterClose(order, 'a')?.sessionId).toBe('b');
  });
  it('returns null when closing the only session (→ caller goes to canvas)', () => {
    expect(neighborAfterClose([agent({ sessionId: 'x' })], 'x')).toBeNull();
  });
  it('returns null when the session is not in the list', () => {
    expect(neighborAfterClose(order, 'zzz')).toBeNull();
  });
});

describe('reorder', () => {
  it('moves an item to just before the target', () => {
    expect(reorder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(reorder(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c']);
  });
  it('is a no-op when dragged equals target', () => {
    expect(reorder(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']);
  });
  it('appends when the target is absent', () => {
    expect(reorder(['a', 'b'], 'a', 'zzz')).toEqual(['b', 'a']);
  });
});

describe('groupStrip (manual order)', () => {
  const agents = [
    agent({ sessionId: 'a', product: 'p' }),
    agent({ sessionId: 'b', product: 'p' }),
    agent({ sessionId: 'q1', product: 'q' }),
  ];
  const openedAt = { a: 1, b: 2, q1: 3 };

  it('honors a manual product order, then falls back to open time', () => {
    const groups = groupStrip(agents, st({ openedAt, productOrder: ['q', 'p'] }));
    expect(groups.map(([p]) => p)).toEqual(['q', 'p']);
  });

  it('honors a manual session order within a product', () => {
    const groups = groupStrip(agents, st({ openedAt, sessionOrder: { p: ['b', 'a'] } }));
    const p = groups.find(([prod]) => prod === 'p')!;
    expect(p[1].map((x) => x.sessionId)).toEqual(['b', 'a']);
  });

  it('places newly-appeared items after manually-ordered ones', () => {
    // only 'b' is manually placed; 'a' (opened earlier) still falls in after it
    const groups = groupStrip(agents, st({ openedAt, sessionOrder: { p: ['b'] } }));
    const p = groups.find(([prod]) => prod === 'p')!;
    expect(p[1].map((x) => x.sessionId)).toEqual(['b', 'a']);
  });
});

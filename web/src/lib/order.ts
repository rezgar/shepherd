import type { AgentModel } from '../types';
import { groupByProductOrdered } from './format';

/**
 * The sessions shown in the focus-mode strip: the ones you've explicitly
 * opened, minus any you've hidden — plus always the session you're currently
 * viewing (so the card you're looking at can never vanish from its own strip).
 *
 * Hiding is authoritative here: a hidden session leaves the strip just as it
 * leaves the canvas, so it stops occupying a slot and can't be reached by the
 * number-jump anymore.
 */
export function stripAgents(
  agents: AgentModel[],
  openedAt: Record<string, number>,
  hidden: Record<string, true>,
  focusedId: string | null,
): AgentModel[] {
  return agents.filter(
    (a) => a.sessionId === focusedId || (a.sessionId in openedAt && !hidden[a.sessionId]),
  );
}

/**
 * The strip in its rendered order, flattened — grouped by product, sessions by
 * the time you first opened them. This is the exact list `CardStrip` shows, so
 * the number-jump can walk it and "the Nth session" matches what you see.
 */
export function stripOrder(
  agents: AgentModel[],
  openedAt: Record<string, number>,
): AgentModel[] {
  return groupByProductOrdered(agents, (a) => openedAt[a.sessionId] ?? 0).flatMap(([, ags]) => ags);
}

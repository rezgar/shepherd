import type { AgentModel } from '../types';

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
 * After closing `sessionId`, which session to land on: the previous one in the
 * rendered strip order, else the next, else null (nothing else is open → the
 * caller returns to the canvas). `order` is the flattened strip order.
 */
export function neighborAfterClose<T extends { sessionId: string }>(
  order: T[],
  sessionId: string,
): T | null {
  const idx = order.findIndex((a) => a.sessionId === sessionId);
  if (idx < 0) return null;
  return order[idx - 1] ?? order[idx + 1] ?? null;
}

/** Manual drag order + the open-time fallback the strip falls back to for
 *  anything not manually placed yet. */
export interface StripState {
  openedAt: Record<string, number>;
  /** Manual order of product groups (drag-and-drop). */
  productOrder: string[];
  /** Manual order of sessions within each product (drag-and-drop). */
  sessionOrder: Record<string, string[]>;
}

/**
 * Move `dragged` to just before `target` in a copy of `list`. Used for both
 * product-group and within-group session reordering. If `target` isn't present,
 * `dragged` goes to the end; a no-op when they're equal.
 */
export function reorder(list: string[], dragged: string, target: string): string[] {
  if (dragged === target) return list;
  const without = list.filter((x) => x !== dragged);
  const idx = without.indexOf(target);
  if (idx < 0) return [...without, dragged];
  return [...without.slice(0, idx), dragged, ...without.slice(idx)];
}

/** Order `present` keys: manual ones first (in manual order, filtered to those
 *  that exist), then the rest by `fallback` ascending. */
function orderKeys(present: string[], manual: string[], fallback: (k: string) => number): string[] {
  const set = new Set(present);
  const placed = manual.filter((k) => set.has(k));
  const seen = new Set(placed);
  const rest = present.filter((k) => !seen.has(k)).sort((a, b) => fallback(a) - fallback(b));
  return [...placed, ...rest];
}

/**
 * The strip grouped by product and ordered, honoring the manual drag order and
 * falling back to first-opened time for anything not manually placed. This is
 * the single source of truth for what `CardStrip` renders and what the
 * number-jump walks, so the two always agree.
 */
export function groupStrip(agents: AgentModel[], state: StripState): [string, AgentModel[]][] {
  const byProduct = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = byProduct.get(a.product) ?? [];
    arr.push(a);
    byProduct.set(a.product, arr);
  }
  const openedOf = (id: string) => state.openedAt[id] ?? 0;
  // A product sorts (by fallback) by the earliest first-opened session in it.
  const productFallback = (p: string) =>
    Math.min(...byProduct.get(p)!.map((a) => openedOf(a.sessionId)));

  const products = orderKeys([...byProduct.keys()], state.productOrder, productFallback);
  return products.map((p): [string, AgentModel[]] => {
    const ags = byProduct.get(p)!;
    const byId = new Map(ags.map((a) => [a.sessionId, a] as const));
    const ids = orderKeys(ags.map((a) => a.sessionId), state.sessionOrder[p] ?? [], openedOf);
    return [p, ids.map((id) => byId.get(id)!)];
  });
}

/**
 * The strip in its rendered order, flattened — the exact list `CardStrip`
 * shows, so the number-jump can walk it and "the Nth session" matches what you
 * see.
 */
export function stripOrder(agents: AgentModel[], state: StripState): AgentModel[] {
  return groupStrip(agents, state).flatMap(([, ags]) => ags);
}

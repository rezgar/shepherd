import type { AgentModel, AgentState, Stage } from '../types';

const PALETTE = ['#58a6ff', '#bc8cff', '#39c5cf', '#e3b341', '#f0883e', '#56d364', '#ff7b72', '#79c0ff'];

/** Stable, distinct color per product name. */
export function productColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export const STAGES: Stage[] = ['definition', 'planning', 'implementation', 'testing', 'debugging'];
export const STAGE_LABELS = ['Def', 'Plan', 'Impl', 'Test', 'Debug'];

/** Index of the current stage in the pipeline, or -1 for unknown. */
export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/** Sort priority for the canvas — active sessions before idle ones. Mirrors
 *  the daemon's own snapshot ordering so the canvas agrees with it. */
const CANVAS_STATE_RANK: Record<AgentState, number> = {
  error: 0,
  'needs-you': 1,
  working: 2,
  idle: 3,
};

/** Group agents by product for the canvas lanes (and the canvas Alt+N
 *  quick-switch). Products keep a stable order by earliest session creation;
 *  sessions WITHIN a product are ordered active-first — by state priority
 *  (needs-you / error / working before idle), then most-recently-active — so
 *  the sessions actually doing something rise to the top of each lane. The
 *  focus-mode strip has its own manual/open-time order (see order.ts's
 *  groupStrip), so it isn't affected. */
export function groupByProduct(agents: AgentModel[]): [string, AgentModel[]][] {
  const map = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = map.get(a.product) ?? [];
    arr.push(a);
    map.set(a.product, arr);
  }
  const earliestCreated = (ags: AgentModel[]) => Math.min(...ags.map((a) => a.createdAt));
  return [...map.entries()]
    .map(([product, ags]): [string, AgentModel[]] => [
      product,
      [...ags].sort(
        (a, b) => CANVAS_STATE_RANK[a.state] - CANVAS_STATE_RANK[b.state] || b.lastActivity - a.lastActivity,
      ),
    ])
    // Lane order stays stable (earliest project first), independent of how the
    // sessions inside now sort.
    .sort((a, b) => earliestCreated(a[1]) - earliestCreated(b[1]));
}

/** Same product-grouping as groupByProduct, but sessions (and product
 *  groups) ordered by a caller-supplied key instead of creation time —
 *  used by the focus-mode top strip, which only shows explicitly-opened
 *  sessions in the order they were first opened, not created. */
export function groupByProductOrdered(agents: AgentModel[], orderOf: (a: AgentModel) => number): [string, AgentModel[]][] {
  const map = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = map.get(a.product) ?? [];
    arr.push(a);
    map.set(a.product, arr);
  }
  return [...map.entries()]
    .map(([product, ags]): [string, AgentModel[]] => [product, [...ags].sort((a, b) => orderOf(a) - orderOf(b))])
    .sort((a, b) => orderOf(a[1][0]) - orderOf(b[1][0]));
}

export function humAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

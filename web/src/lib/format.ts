import type { AgentModel, Stage } from '../types';

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

/** Group agents by product in a single stable reading order — products by
 *  earliest session creation, sessions within a product by their own creation
 *  time. Shared by the canvas lanes, the focus-mode top strip, and the
 *  Alt+N quick-switch so all three always agree on "the Nth session". */
export function groupByProduct(agents: AgentModel[]): [string, AgentModel[]][] {
  const map = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = map.get(a.product) ?? [];
    arr.push(a);
    map.set(a.product, arr);
  }
  return [...map.entries()]
    .map(([product, ags]): [string, AgentModel[]] => [product, [...ags].sort((a, b) => a.createdAt - b.createdAt)])
    .sort((a, b) => a[1][0].createdAt - b[1][0].createdAt);
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

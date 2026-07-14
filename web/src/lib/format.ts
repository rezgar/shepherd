import type { Stage } from '../types';

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

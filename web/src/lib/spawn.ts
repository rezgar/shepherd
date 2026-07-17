import type { AgentModel } from '../types';

/** A freshly-created session the app should auto-open. */
export interface SpawnedSession {
  product: string;
  file: string;
  sessionId: string;
}

/**
 * Given the current agents and the per-product spawn-request timestamps
 * (`product -> Date.now() when "+" was clicked`), return the freshly-created
 * sessions whose transcript has now shown up in the snapshot — one per pending
 * product. A product can match more than one agent created after the request
 * (rare); the newest wins.
 *
 * This is the same "a fresh session appeared for a product I just spawned"
 * signal the hook already uses to clear the "spawning…" state — surfaced so the
 * app can also add it to the explicitly-opened set, so a "+"-created session
 * shows in the focus strip immediately instead of staying hidden until it is
 * clicked on the canvas.
 */
export function detectNewlySpawned(
  agents: AgentModel[],
  spawning: Map<string, number>,
): SpawnedSession[] {
  const out: SpawnedSession[] = [];
  for (const [product, since] of spawning) {
    const fresh = agents
      .filter((a) => a.product === product && a.createdAt >= since)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (fresh) out.push({ product, file: fresh.file, sessionId: fresh.sessionId });
  }
  return out;
}

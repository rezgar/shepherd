import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { scanAll, PROJECTS_DIR } from './scan.js';
import type { Snapshot } from './types.js';

const PORT = 4177;

const STATE_ORDER = { 'needs-you': 0, working: 1, idle: 2 } as const;

async function buildSnapshot(): Promise<Snapshot> {
  const now = Date.now();
  const agents = await scanAll(now);
  agents.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.lastActivity - a.lastActivity,
  );
  return { type: 'snapshot', now, agents };
}

function humAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function main() {
  const snap = await buildSnapshot();

  if (process.argv.includes('--once')) {
    console.table(
      snap.agents.map((a) => ({
        product: a.product,
        label: a.label,
        state: a.state,
        stage: a.stage,
        ago: humAgo(snap.now - a.lastActivity),
        status: a.status,
      })),
    );
    const products = new Set(snap.agents.map((a) => a.product));
    console.log(`\n${snap.agents.length} agents across ${products.size} products`);
    return;
  }

  let current = snap;
  const wss = new WebSocketServer({ port: PORT });
  console.log(`[shepherd] ws://localhost:${PORT} — watching ${PROJECTS_DIR}`);
  console.log(`[shepherd] ${current.agents.length} agents at boot`);

  const broadcast = () => {
    const data = JSON.stringify(current);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };

  wss.on('connection', (ws) => ws.send(JSON.stringify(current)));

  let timer: NodeJS.Timeout | null = null;
  const rescan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      current = await buildSnapshot();
      broadcast();
    }, 400);
  };

  const watcher = chokidar.watch(PROJECTS_DIR, { ignoreInitial: true, depth: 2 });
  const onEvt = (p: string) => {
    if (p.endsWith('.jsonl')) rescan();
  };
  watcher.on('add', onEvt).on('change', onEvt).on('unlink', onEvt);

  // Recency-based state drifts even without file writes; refresh periodically.
  setInterval(async () => {
    current = await buildSnapshot();
    broadcast();
  }, 15_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

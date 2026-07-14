import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import chokidar from 'chokidar';
import { scanAll, PROJECTS_DIR } from './scan.js';
import { parseTranscript } from './transcript.js';
import { sendToSession } from './sender.js';
import type { Snapshot } from './types.js';

const PORT = 4177;

const STATE_ORDER = { error: 0, 'needs-you': 1, working: 2, idle: 3 } as const;

/** A connection remembers which session (and, separately, which of that
 *  session's subagents) it is focused on. */
interface FocusWs extends WebSocket {
  focusFile?: string;
  focusSession?: string;
  focusSubagentFile?: string;
  focusSubagentId?: string;
}

/** A subagent's own transcript lives at <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl. */
function subagentFilePath(parentFile: string, sessionId: string, agentId: string): string {
  return path.join(path.dirname(parentFile), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

const norm = (p: string) => p.replace(/\\/g, '/');

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
  // In-flight sends this daemon spawned, by session id — lets Esc cancel one.
  const inFlight = new Map<string, { cancel: () => void }>();
  console.log(`[shepherd] ws://localhost:${PORT} — watching ${PROJECTS_DIR}`);
  console.log(`[shepherd] ${current.agents.length} agents at boot`);

  const broadcast = () => {
    const data = JSON.stringify(current);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };

  const LIMIT = 30;
  // Send a recent window of the focused transcript (fast first paint), or an
  // older page when `before` is given (infinite scroll upward).
  const sendWindow = async (ws: FocusWs, before?: number) => {
    if (!ws.focusFile || !ws.focusSession) return;
    try {
      const parsed = await parseTranscript(ws.focusFile, ws.focusSession);
      const all = parsed.messages;
      const total = all.length;
      if (typeof before === 'number') {
        const end = Math.max(0, before);
        const start = Math.max(0, end - LIMIT);
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              type: 'transcriptMore',
              sessionId: ws.focusSession,
              messages: all.slice(start, end),
              offset: start,
            }),
          );
      } else {
        const start = Math.max(0, total - LIMIT);
        if (ws.readyState === 1)
          ws.send(
            JSON.stringify({
              type: 'transcript',
              sessionId: ws.focusSession,
              file: ws.focusFile,
              messages: all.slice(start),
              offset: start,
              total,
              activeSubagents: parsed.activeSubagents,
            }),
          );
      }
    } catch (e) {
      console.error('[transcript error]', ws.focusFile, e);
    }
  };

  // Subagents get a simple, unpaginated live view — their conversations are
  // short-lived, no need for the main transcript's infinite-scroll machinery.
  const sendSubagentWindow = async (ws: FocusWs) => {
    if (!ws.focusSubagentFile || !ws.focusSubagentId) return;
    try {
      const parsed = await parseTranscript(ws.focusSubagentFile, ws.focusSubagentId);
      if (ws.readyState === 1)
        ws.send(JSON.stringify({ type: 'subagentTranscript', agentId: ws.focusSubagentId, messages: parsed.messages }));
    } catch (e) {
      console.error('[subagent transcript error]', ws.focusSubagentFile, e);
    }
  };

  wss.on('connection', (ws: FocusWs) => {
    ws.send(JSON.stringify(current));
    ws.on('message', (buf) => {
      let m: any;
      try {
        m = JSON.parse(buf.toString());
      } catch {
        return;
      }
      if (m.type === 'focus' && m.file && m.sessionId) {
        ws.focusFile = m.file;
        ws.focusSession = m.sessionId;
        void sendWindow(ws);
      } else if (m.type === 'loadMore' && typeof m.before === 'number') {
        void sendWindow(ws, m.before);
      } else if (m.type === 'unfocus') {
        ws.focusFile = undefined;
        ws.focusSession = undefined;
      } else if (m.type === 'focusSubagent' && m.parentFile && m.sessionId && m.agentId) {
        ws.focusSubagentFile = subagentFilePath(m.parentFile, m.sessionId, m.agentId);
        ws.focusSubagentId = m.agentId;
        void sendSubagentWindow(ws);
      } else if (m.type === 'unfocusSubagent') {
        ws.focusSubagentFile = undefined;
        ws.focusSubagentId = undefined;
      } else if (m.type === 'send' && m.sessionId && m.cwd && typeof m.text === 'string' && m.text.trim()) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'send-ack', sessionId: m.sessionId }));
        const handle = sendToSession(
          m.sessionId,
          m.cwd,
          m.text,
          Array.isArray(m.images) ? m.images : undefined,
          () => {
            inFlight.delete(m.sessionId);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'send-done', sessionId: m.sessionId }));
            void sendWindow(ws); // nudge a transcript refresh in case the file-watch is slow
          },
          (error) => {
            inFlight.delete(m.sessionId);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'send-error', sessionId: m.sessionId, error }));
          },
          () => {
            inFlight.delete(m.sessionId);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'send-cancelled', sessionId: m.sessionId }));
            void sendWindow(ws);
          },
        );
        inFlight.set(m.sessionId, handle);
      } else if (m.type === 'cancel' && m.sessionId) {
        inFlight.get(m.sessionId)?.cancel();
      }
    });
  });

  let timer: NodeJS.Timeout | null = null;
  const rescan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      current = await buildSnapshot();
      broadcast();
    }, 400);
  };

  // Debounce transcript resends per connection — a live session's file changes
  // many times a second, and re-sending the whole transcript each time floods
  // the socket and thrashes the UI.
  const tTimers = new WeakMap<FocusWs, NodeJS.Timeout>();
  const subTimers = new WeakMap<FocusWs, NodeJS.Timeout>();
  const onEvt = (p: string) => {
    if (!p.endsWith('.jsonl')) return;
    rescan();
    const np = norm(p);
    for (const c of wss.clients as Set<FocusWs>) {
      if (c.focusFile && norm(c.focusFile) === np) {
        const prev = tTimers.get(c);
        if (prev) clearTimeout(prev);
        tTimers.set(c, setTimeout(() => void sendWindow(c), 400));
      }
      if (c.focusSubagentFile && norm(c.focusSubagentFile) === np) {
        const prev = subTimers.get(c);
        if (prev) clearTimeout(prev);
        subTimers.set(c, setTimeout(() => void sendSubagentWindow(c), 400));
      }
    }
  };

  // depth 3 so a session's subagents/agent-<id>.jsonl (one level deeper than
  // the session file itself) is watched too, for live subagent-modal updates.
  const watcher = chokidar.watch(PROJECTS_DIR, { ignoreInitial: true, depth: 3 });
  watcher.on('add', onEvt).on('change', onEvt).on('unlink', onEvt);

  setInterval(async () => {
    current = await buildSnapshot();
    broadcast();
  }, 15_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import chokidar from 'chokidar';
import { scanAll, PROJECTS_DIR } from './scan.js';
import { parseTranscript } from './transcript.js';
import { sendToSession, spawnSession, startIdleEvictionSweep, shutdownAllSessions } from './sender.js';
import { computeLimits, type Limits } from './usage.js';
import type { Snapshot } from './types.js';

// This process serves every connected session, not just one — an uncaught
// exception anywhere (a bad pty.spawn under load, a malformed transcript
// line, anything) would otherwise take the WHOLE daemon down, silently
// breaking every session's ability to send until someone notices and
// restarts it by hand (confirmed the hard way: a spawn under heavy
// concurrent load killed the process outright, and every send in every
// session just stopped working with no visible error). Log and stay up —
// a daemon that degrades on one bad event beats one that disappears entirely.
process.on('uncaughtException', (err) => {
  console.error('[shepherd] uncaught exception (daemon stays up):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[shepherd] unhandled rejection (daemon stays up):', reason);
});

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
  let currentLimits: Limits | null = null;
  const wss = new WebSocketServer({ port: PORT });
  // In-flight sends this daemon spawned, by session id — lets Esc cancel one.
  const inFlight = new Map<string, { cancel: () => void }>();
  console.log(`[shepherd] ws://localhost:${PORT} — watching ${PROJECTS_DIR}`);
  console.log(`[shepherd] ${current.agents.length} agents at boot`);

  startIdleEvictionSweep();
  // Close every session's live PTY before exiting — otherwise a restart
  // (including the supervisor's own auto-restart-on-crash) leaves orphaned
  // `claude` processes behind instead of a clean handoff.
  const shutdown = () => {
    void shutdownAllSessions().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const broadcast = () => {
    const data = JSON.stringify(current);
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };

  const broadcastLimits = () => {
    if (!currentLimits) return;
    const data = JSON.stringify({ type: 'limits', ...currentLimits });
    for (const c of wss.clients) if (c.readyState === 1) c.send(data);
  };

  // ccusage scans every local transcript, so it's not cheap enough to run on
  // every rescan (400ms debounce) — a slow independent poll is plenty for a
  // 5h/7d rolling estimate that barely moves minute to minute.
  const refreshLimits = async () => {
    try {
      currentLimits = await computeLimits();
      broadcastLimits();
    } catch (e) {
      console.error('[limits error]', e);
    }
  };
  void refreshLimits();
  setInterval(refreshLimits, 5 * 60_000);

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
    if (currentLimits) ws.send(JSON.stringify({ type: 'limits', ...currentLimits }));
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
        const targetFile = current.agents.find((a) => a.sessionId === m.sessionId)?.file;
        if (!targetFile) {
          // The client already set its optimistic "sending…" state before this
          // message was even parsed (see api.ts's send()) — silently returning
          // here left it stuck that way forever with zero indication anything
          // was wrong (confirmed the hard way: no error, no banner, nothing).
          // `current` is only rebuilt on a debounced file-change or a 15s
          // timer, so a session can legitimately be momentarily (or, if it's
          // aged past the scan window, permanently) absent from it — either
          // way the client must always get a response.
          if (ws.readyState === 1)
            ws.send(
              JSON.stringify({
                type: 'send-error',
                sessionId: m.sessionId,
                error: 'session not found in the current snapshot — try again in a moment',
              }),
            );
          return;
        }
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'send-ack', sessionId: m.sessionId }));
        const handle = sendToSession(
          m.sessionId,
          m.cwd,
          targetFile,
          m.text,
          Array.isArray(m.images) ? m.images : undefined,
          (wasLiveElsewhere) => {
            inFlight.delete(m.sessionId);
            if (ws.readyState === 1)
              ws.send(JSON.stringify({ type: 'send-done', sessionId: m.sessionId, wasLiveElsewhere }));
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
      } else if (m.type === 'spawn' && typeof m.product === 'string') {
        // Any current session in that product names the repo root — a fresh
        // session always lands there, never in a specific worktree.
        const repoPath = current.agents.find((a) => a.product === m.product)?.repoPath;
        if (!repoPath) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'spawn-error', product: m.product, error: 'unknown product' }));
          return;
        }
        // The session id isn't known until the SDK reports it mid-flight —
        // register the handle in `inFlight` the moment it is, so the card
        // that shows up for it is cancellable (Esc) just like any other
        // Shepherd-owned send, not silently un-stoppable.
        let spawnedId: string | null = null;
        const handle = spawnSession(
          repoPath,
          'New session started via Shepherd. Say hi and wait for instructions.',
          (sessionId) => {
            spawnedId = sessionId;
            inFlight.set(sessionId, handle);
          },
          () => {
            if (spawnedId) inFlight.delete(spawnedId); // the new transcript file's own chokidar event drives the next broadcast
          },
          (error) => {
            if (spawnedId) inFlight.delete(spawnedId);
            console.error('[spawn error]', m.product, error);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'spawn-error', product: m.product, error }));
          },
          () => {
            if (spawnedId) inFlight.delete(spawnedId);
          },
        );
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

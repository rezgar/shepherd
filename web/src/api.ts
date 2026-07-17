import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, DirListing, Limits, Snapshot, SubagentInfo } from './types';
import { detectNewlySpawned, type SpawnedSession } from './lib/spawn';

const WS_URL = 'ws://localhost:4177';

interface Loaded {
  sessionId: string;
  messages: ChatMsg[];
  offset: number; // index of the first loaded message in the full transcript
  total: number;
}

export interface Shepherd {
  snap: Snapshot | null;
  /** null until the daemon's first ccusage-based estimate lands. */
  limits: Limits | null;
  connected: boolean;
  focusedId: string | null;
  /** null = nothing (or a different session still loading); [] = focused-but-empty. */
  messages: ChatMsg[] | null;
  hasMore: boolean;
  focus: (file: string, sessionId: string) => void;
  unfocus: () => void;
  loadMore: () => void;
  /** Bumped every time the attached session changes — TerminalView keys off
   *  this to force a fresh xterm.js instance rather than reusing one across
   *  sessions. */
  termResetKey: string;
  attachTerminal: (sessionId: string, cwd: string) => void;
  detachTerminal: (sessionId: string) => void;
  sendTermInput: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  resizeTerm: (sessionId: string, cols: number, rows: number) => void;
  /** Write a raw control key straight to the pty — no composed line, no
   *  trailing Enter, just the byte(s) themselves (e.g. Escape to interrupt
   *  generation, same as pressing it at a real keyboard). */
  sendTerminalKey: (sessionId: string, cwd: string, key: string) => void;
  /** Register a listener that fires for every raw output chunk of the
   *  CURRENTLY attached session, called directly and synchronously from the
   *  WS message handler — deliberately NOT routed through React state.
   *  `useState` only ever holds the latest value; a burst of `termOutput`
   *  messages arriving faster than a render cycle (completely normal for a
   *  live terminal — a spinner alone can redraw many times a second) has
   *  React batch/coalesce the updates, so every chunk except the last in a
   *  batch is silently dropped before its effect ever runs (confirmed the
   *  hard way: the terminal froze on a stale mid-spinner frame while the
   *  real session had already finished and gone idle — the "done" chunk
   *  never got applied because an earlier setState call in the same batch
   *  was thrown away). Returns an unsubscribe function. */
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
  termError: string | null;
  /** Ask the daemon to spawn a fresh session. `cwd` is required for a brand
   *  new product with no existing card to derive a repo root from — omit it
   *  to reuse an already-known product's repo root. */
  spawn: (product: string, cwd?: string) => void;
  /** Products with a spawn request still in flight — shows "spawning…" on the + card. */
  spawningProducts: Set<string>;
  /** Most recent spawn failure per product, if any — cleared on retry. */
  spawnErrors: Map<string, string>;
  /** Latest directory listing for the new-project picker, or null before the
   *  first request / after an error. */
  dirListing: DirListing | null;
  dirListingError: string | null;
  /** Ask the daemon to list subdirectories of `path` (or a sensible default
   *  root when omitted) for the new-project picker. */
  listDir: (path?: string) => void;
  /** Subagents the focused session dispatched that haven't finished yet. */
  activeSubagents: SubagentInfo[];
  openSubagent: (parentFile: string, sessionId: string, agentId: string, description: string) => void;
  closeSubagent: () => void;
  /** null while the modal is closed or its first window hasn't arrived yet. */
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  /** Sessions just created via a "+" card whose transcript has now appeared —
   *  the app opens each so a spawned session shows in the strip immediately.
   *  Drained via `consumeSpawned` once handled. */
  justSpawned: SpawnedSession[];
  consumeSpawned: () => void;
}

function mergeTail(prev: Loaded | null, sessionId: string, tail: ChatMsg[], offset: number, total: number): Loaded {
  if (!prev || prev.sessionId !== sessionId || !prev.messages.length) {
    return { sessionId, messages: tail, offset, total };
  }
  // A tail window overlaps what we have — append only genuinely new messages.
  const have = new Set(prev.messages.map((m) => m.id));
  const added = tail.filter((m) => !have.has(m.id));
  return {
    sessionId,
    messages: added.length ? [...prev.messages, ...added] : prev.messages,
    offset: prev.offset,
    total,
  };
}

/** `WebSocket.send` throws if the socket isn't OPEN — a raw call left
 *  unguarded in a callback aborts everything after it in that same function,
 *  silently skipping whatever local state update was supposed to follow
 *  (confirmed the hard way: a message typed while disconnected vanished
 *  with no trace because the throw skipped the optimistic-echo code right
 *  after it). Every fire-and-forget WS send in this file goes through here
 *  instead of touching `ws.send` directly. */
function wsSend(ws: WebSocket | null, msg: object): void {
  if (ws?.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (e) {
    console.warn('[shepherd] ws send failed:', e);
  }
}

function prependOlder(prev: Loaded, older: ChatMsg[], offset: number): Loaded {
  const have = new Set(prev.messages.map((m) => m.id));
  const fresh = older.filter((m) => !have.has(m.id));
  return { sessionId: prev.sessionId, messages: [...fresh, ...prev.messages], offset, total: prev.total };
}

export function useShepherd(): Shepherd {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [connected, setConnected] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [termResetKey, setTermResetKey] = useState('');
  const [termError, setTermError] = useState<string | null>(null);
  const [activeSubagents, setActiveSubagents] = useState<SubagentInfo[]>([]);
  // product -> request timestamp, cleared once a fresher session shows up in
  // that group's snapshot, on a spawn-error, or after a safety timeout.
  const [spawning, setSpawning] = useState<Map<string, number>>(() => new Map());
  const [spawnErrors, setSpawnErrors] = useState<Map<string, string>>(() => new Map());
  // Sessions born from a "+" card, waiting to be auto-opened by App.
  const [justSpawned, setJustSpawned] = useState<SpawnedSession[]>([]);
  const [dirListing, setDirListing] = useState<DirListing | null>(null);
  const [dirListingError, setDirListingError] = useState<string | null>(null);
  const [subagentModal, setSubagentModal] = useState<{
    agentId: string;
    description: string;
    messages: ChatMsg[] | null;
  } | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<{ file: string; sessionId: string } | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  const subagentModalRef = useRef(subagentModal);
  subagentModalRef.current = subagentModal;
  // The onmessage handler is installed once (connect effect has [] deps), so it
  // reads live spawn requests through a ref rather than a stale closure.
  const spawningRef = useRef(spawning);
  spawningRef.current = spawning;
  // Cache the loaded window per session so re-focusing is instant.
  const cache = useRef<Map<string, Loaded>>(new Map());
  // Raw-output listeners for the currently attached terminal — see
  // `subscribeTerminal`'s doc comment for why this bypasses React state.
  const termListeners = useRef<Set<(chunk: string) => void>>(new Set());

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        // Note: this re-focuses the transcript tail but does NOT re-attach the
        // terminal — attachTerm needs a real cwd, which focusRef doesn't carry
        // (focus() is only ever called with file/sessionId). A reconnect while
        // a terminal is open leaves it stale until you navigate away and back,
        // which re-triggers FocusView's own attach effect. A known, narrow gap
        // for the WS-drops-while-focused case, not worth widening focus()'s
        // signature for.
        if (focusRef.current) wsSend(ws, { type: 'focus', ...focusRef.current });
      };
      ws.onmessage = (e) => {
        let d: any;
        try {
          d = JSON.parse(e.data as string);
        } catch {
          return;
        }
        if (d.type === 'snapshot') {
          const s = d as Snapshot;
          setSnap(s);
          // A session created via a "+" card has now appeared — queue it for
          // the app to open, so it shows in the strip without a canvas detour.
          const spawned = detectNewlySpawned(s.agents, spawningRef.current);
          if (spawned.length) setJustSpawned((q) => [...q, ...spawned]);
          setSpawning((prev) => {
            if (!prev.size) return prev;
            let changed = false;
            const next = new Map(prev);
            for (const [product, since] of prev) {
              if (s.agents.some((a) => a.product === product && a.createdAt >= since)) {
                next.delete(product);
                changed = true;
              }
            }
            return changed ? next : prev;
          });
        } else if (d.type === 'spawn-error') {
          console.warn('[shepherd] spawn failed:', d.product, d.error);
          setSpawning((s) => {
            if (!s.has(d.product)) return s;
            const n = new Map(s);
            n.delete(d.product);
            return n;
          });
          setSpawnErrors((s) => new Map(s).set(d.product, d.error));
        } else if (d.type === 'dirListing') {
          setDirListing({ path: d.path, parent: d.parent, entries: d.entries });
          setDirListingError(null);
        } else if (d.type === 'dirListing-error') {
          setDirListingError(d.error);
        } else if (d.type === 'limits') {
          setLimits({ session: d.session ?? null, weekly: d.weekly ?? null });
        } else if (d.type === 'transcript') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setActiveSubagents(Array.isArray(d.activeSubagents) ? d.activeSubagents : []);
          setLoaded((prev) => {
            const next = mergeTail(prev, d.sessionId, d.messages, d.offset, d.total);
            cache.current.set(d.sessionId, next);
            return next;
          });
        } else if (d.type === 'transcriptMore') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setLoaded((prev) => {
            if (!prev || prev.sessionId !== d.sessionId) return prev;
            const next = prependOlder(prev, d.messages, d.offset);
            cache.current.set(d.sessionId, next);
            return next;
          });
        } else if (d.type === 'subagentTranscript') {
          if (d.agentId !== subagentModalRef.current?.agentId) return;
          setSubagentModal((prev) => (prev && prev.agentId === d.agentId ? { ...prev, messages: d.messages } : prev));
        } else if (d.type === 'termOutput') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          for (const fn of termListeners.current) fn(d.chunk);
        } else if (d.type === 'termError') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setTermError(d.error);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const focus = useCallback((file: string, sessionId: string) => {
    focusRef.current = { file, sessionId };
    setFocusedId(sessionId);
    setLoaded(cache.current.get(sessionId) ?? null); // instant paint from cache, else clears
    setActiveSubagents([]);
    setSubagentModal(null);
    wsSend(wsRef.current, { type: 'focus', file, sessionId });
    wsSend(wsRef.current, { type: 'unfocusSubagent' });
  }, []);

  const unfocus = useCallback(() => {
    focusRef.current = null;
    setFocusedId(null);
    setLoaded(null);
    setActiveSubagents([]);
    setSubagentModal(null);
    wsSend(wsRef.current, { type: 'unfocus' });
    wsSend(wsRef.current, { type: 'unfocusSubagent' });
  }, []);

  const openSubagent = useCallback((parentFile: string, sessionId: string, agentId: string, description: string) => {
    setSubagentModal({ agentId, description, messages: null });
    wsSend(wsRef.current, { type: 'focusSubagent', parentFile, sessionId, agentId });
  }, []);

  const closeSubagent = useCallback(() => {
    setSubagentModal(null);
    wsSend(wsRef.current, { type: 'unfocusSubagent' });
  }, []);

  const loadMore = useCallback(() => {
    const f = focusRef.current;
    const st = loadedRef.current;
    if (!f || !st || st.sessionId !== f.sessionId || st.offset <= 0) return;
    wsSend(wsRef.current, { type: 'loadMore', file: f.file, sessionId: f.sessionId, before: st.offset });
  }, []);

  const attachTerminal = useCallback((sessionId: string, cwd: string) => {
    setTermError(null);
    setTermResetKey(sessionId);
    wsSend(wsRef.current, { type: 'attachTerm', sessionId, cwd });
  }, []);

  const detachTerminal = useCallback((sessionId: string) => {
    wsSend(wsRef.current, { type: 'detachTerm', sessionId });
  }, []);

  const subscribeTerminal = useCallback((onChunk: (chunk: string) => void) => {
    termListeners.current.add(onChunk);
    return () => {
      termListeners.current.delete(onChunk);
    };
  }, []);

  const sendTermInput = useCallback((sessionId: string, cwd: string, text: string, images?: string[]) => {
    setTermError(null);
    wsSend(wsRef.current, { type: 'termInput', sessionId, cwd, text, images });
  }, []);

  const resizeTerm = useCallback((sessionId: string, cols: number, rows: number) => {
    wsSend(wsRef.current, { type: 'termResize', sessionId, cols, rows });
  }, []);

  const sendTerminalKey = useCallback((sessionId: string, cwd: string, key: string) => {
    wsSend(wsRef.current, { type: 'termKey', sessionId, cwd, key });
  }, []);

  const spawn = useCallback((product: string, cwd?: string) => {
    const since = Date.now();
    wsSend(wsRef.current, { type: 'spawn', product, cwd });
    setSpawning((s) => new Map(s).set(product, since));
    setSpawnErrors((s) => {
      if (!s.has(product)) return s;
      const n = new Map(s);
      n.delete(product);
      return n;
    });
    // Safety net — if neither a fresh session nor a spawn-error ever arrives
    // (daemon restart mid-flight, etc.), don't leave the card stuck forever.
    setTimeout(() => {
      setSpawning((s) => {
        if (s.get(product) !== since) return s;
        const n = new Map(s);
        n.delete(product);
        return n;
      });
    }, 25_000);
  }, []);

  const listDir = useCallback((path?: string) => {
    wsSend(wsRef.current, { type: 'listDir', path });
  }, []);

  // App calls this after opening the queued spawned sessions, so each is
  // auto-opened exactly once (re-opening later is the user's own choice).
  const consumeSpawned = useCallback(() => setJustSpawned((q) => (q.length ? [] : q)), []);

  // Only ever surface the transcript that matches the focused session — a previous
  // session's content must never linger while switching.
  const matches = !!loaded && loaded.sessionId === focusedId;
  const messages: ChatMsg[] | null = matches ? loaded!.messages : null;
  return {
    snap,
    limits,
    connected,
    focusedId,
    messages,
    hasMore: matches ? loaded!.offset > 0 : false,
    focus,
    unfocus,
    loadMore,
    termResetKey,
    termError,
    attachTerminal,
    detachTerminal,
    sendTermInput,
    resizeTerm,
    sendTerminalKey,
    subscribeTerminal,
    spawn,
    spawningProducts: new Set(spawning.keys()),
    spawnErrors,
    justSpawned,
    consumeSpawned,
    dirListing,
    dirListingError,
    listDir,
    activeSubagents,
    openSubagent,
    closeSubagent,
    subagentModal,
  };
}

/** Re-render on an interval so relative timestamps stay fresh. */
export function useTick(ms = 1000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

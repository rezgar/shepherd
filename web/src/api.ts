import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, Snapshot, SubagentInfo } from './types';

const WS_URL = 'ws://localhost:4177';

interface Loaded {
  sessionId: string;
  messages: ChatMsg[];
  offset: number; // index of the first loaded message in the full transcript
  total: number;
}

export interface Shepherd {
  snap: Snapshot | null;
  connected: boolean;
  focusedId: string | null;
  /** null = nothing (or a different session still loading); [] = focused-but-empty. */
  messages: ChatMsg[] | null;
  hasMore: boolean;
  focus: (file: string, sessionId: string) => void;
  unfocus: () => void;
  loadMore: () => void;
  send: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  /** Stop an in-flight reply Shepherd itself spawned for this session. */
  cancel: (sessionId: string) => void;
  /** Sessions with an in-flight reply. */
  sendingIds: Set<string>;
  /** Subagents the focused session dispatched that haven't finished yet. */
  activeSubagents: SubagentInfo[];
  openSubagent: (parentFile: string, sessionId: string, agentId: string, description: string) => void;
  closeSubagent: () => void;
  /** null while the modal is closed or its first window hasn't arrived yet. */
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
}

interface PendingEcho {
  msg: ChatMsg;
  /** id of the message that was last in the list when this was sent — the
   *  echo renders right after it, not always at the tail, so it doesn't jump
   *  after real content that streams in past it while the reply is in flight. */
  anchor: string | null;
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

function prependOlder(prev: Loaded, older: ChatMsg[], offset: number): Loaded {
  const have = new Set(prev.messages.map((m) => m.id));
  const fresh = older.filter((m) => !have.has(m.id));
  return { sessionId: prev.sessionId, messages: [...fresh, ...prev.messages], offset, total: prev.total };
}

export function useShepherd(): Shepherd {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sendingIds, setSendingIds] = useState<Set<string>>(() => new Set());
  // Shown instantly on send, before the CLI round-trip writes the real transcript
  // line — cleared once that reply lands (send-done/send-error/send-cancelled),
  // never merged into `loaded` itself so there's no id to reconcile against the
  // real one.
  const [pending, setPending] = useState<Record<string, PendingEcho>>({});
  const [activeSubagents, setActiveSubagents] = useState<SubagentInfo[]>([]);
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
  // Cache the loaded window per session so re-focusing is instant.
  const cache = useRef<Map<string, Loaded>>(new Map());

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        if (focusRef.current) ws.send(JSON.stringify({ type: 'focus', ...focusRef.current }));
      };
      ws.onmessage = (e) => {
        let d: any;
        try {
          d = JSON.parse(e.data as string);
        } catch {
          return;
        }
        if (d.type === 'snapshot') {
          setSnap(d as Snapshot);
        } else if (d.type === 'transcript') {
          if (d.sessionId !== focusRef.current?.sessionId) return;
          setActiveSubagents(Array.isArray(d.activeSubagents) ? d.activeSubagents : []);
          let merged: Loaded | null = null;
          setLoaded((prev) => {
            const next = mergeTail(prev, d.sessionId, d.messages, d.offset, d.total);
            cache.current.set(d.sessionId, next);
            merged = next;
            return next;
          });
          // The real write can land (via the file-watcher push) before send-done
          // fires — drop the echo the moment a real user turn shows up after the
          // anchor point. Position-based, not text-matched: the real text can
          // differ slightly from what was echoed (reformatting, trimming), so
          // matching on content is unreliable — but only one send is ever in
          // flight per session, so "a user turn landed after the anchor" is
          // unambiguously that send's real message.
          setPending((p) => {
            const entry = p[d.sessionId];
            if (!entry || !merged) return p;
            const anchorIdx = entry.anchor ? merged.messages.findIndex((m) => m.id === entry.anchor) : -1;
            const landed = merged.messages.slice(anchorIdx + 1).some((m) => m.role === 'user');
            if (!landed) return p;
            const { [d.sessionId]: _drop, ...rest } = p;
            return rest;
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
        } else if (d.type === 'send-done' || d.type === 'send-error' || d.type === 'send-cancelled') {
          setSendingIds((s) => {
            if (!s.has(d.sessionId)) return s;
            const n = new Set(s);
            n.delete(d.sessionId);
            return n;
          });
          setPending((p) => {
            if (!(d.sessionId in p)) return p;
            const { [d.sessionId]: _drop, ...rest } = p;
            return rest;
          });
          if (d.type === 'send-error') console.warn('[shepherd] send failed:', d.error);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // The daemon tracks in-flight sends only in memory, so once the socket
        // drops (daemon restart/crash) it can never deliver the completion that
        // clears these — leaving the composer stuck on "Sending…" forever.
        // Release them: after a disconnect the send is unrecoverable anyway.
        setSendingIds((s) => (s.size ? new Set() : s));
        setPending((p) => (Object.keys(p).length ? {} : p));
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
    wsRef.current?.send(JSON.stringify({ type: 'focus', file, sessionId }));
    wsRef.current?.send(JSON.stringify({ type: 'unfocusSubagent' }));
  }, []);

  const unfocus = useCallback(() => {
    focusRef.current = null;
    setFocusedId(null);
    setLoaded(null);
    setActiveSubagents([]);
    setSubagentModal(null);
    wsRef.current?.send(JSON.stringify({ type: 'unfocus' }));
    wsRef.current?.send(JSON.stringify({ type: 'unfocusSubagent' }));
  }, []);

  const openSubagent = useCallback((parentFile: string, sessionId: string, agentId: string, description: string) => {
    setSubagentModal({ agentId, description, messages: null });
    wsRef.current?.send(JSON.stringify({ type: 'focusSubagent', parentFile, sessionId, agentId }));
  }, []);

  const closeSubagent = useCallback(() => {
    setSubagentModal(null);
    wsRef.current?.send(JSON.stringify({ type: 'unfocusSubagent' }));
  }, []);

  const loadMore = useCallback(() => {
    const f = focusRef.current;
    const st = loadedRef.current;
    if (!f || !st || st.sessionId !== f.sessionId || st.offset <= 0) return;
    wsRef.current?.send(JSON.stringify({ type: 'loadMore', file: f.file, sessionId: f.sessionId, before: st.offset }));
  }, []);

  const send = useCallback((sessionId: string, cwd: string, text: string, images?: string[]) => {
    wsRef.current?.send(JSON.stringify({ type: 'send', sessionId, cwd, text, images }));
    setSendingIds((s) => new Set(s).add(sessionId));
    const st = loadedRef.current;
    const anchor = st?.sessionId === sessionId ? (st.messages.at(-1)?.id ?? null) : null;
    setPending((p) => ({
      ...p,
      [sessionId]: {
        anchor,
        msg: {
          id: `pending-${sessionId}`,
          role: 'user',
          text,
          tools: [],
          images: images ?? [],
          ts: Date.now(),
          pending: true,
        },
      },
    }));
  }, []);

  const cancel = useCallback((sessionId: string) => {
    wsRef.current?.send(JSON.stringify({ type: 'cancel', sessionId }));
    // Release the composer immediately rather than waiting for send-cancelled —
    // if the daemon already lost the handle (e.g. it restarted), that reply
    // would never come and the input would stay stuck.
    setSendingIds((s) => {
      if (!s.has(sessionId)) return s;
      const n = new Set(s);
      n.delete(sessionId);
      return n;
    });
    setPending((p) => {
      if (!(sessionId in p)) return p;
      const { [sessionId]: _drop, ...rest } = p;
      return rest;
    });
  }, []);

  // Only ever surface the transcript that matches the focused session — a previous
  // session's content must never linger while switching.
  const matches = !!loaded && loaded.sessionId === focusedId;
  const echo = focusedId ? pending[focusedId] : undefined;
  let messages: ChatMsg[] | null = matches ? loaded!.messages : echo ? [] : null;
  if (echo && messages) {
    const idx = echo.anchor ? messages.findIndex((m) => m.id === echo.anchor) : -1;
    const at = idx >= 0 ? idx + 1 : messages.length;
    messages = [...messages.slice(0, at), echo.msg, ...messages.slice(at)];
  }
  return {
    snap,
    connected,
    focusedId,
    messages,
    hasMore: matches ? loaded!.offset > 0 : false,
    focus,
    unfocus,
    loadMore,
    send,
    cancel,
    sendingIds,
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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, Snapshot } from './types';

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

  const wsRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<{ file: string; sessionId: string } | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
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
    wsRef.current?.send(JSON.stringify({ type: 'focus', file, sessionId }));
  }, []);

  const unfocus = useCallback(() => {
    focusRef.current = null;
    setFocusedId(null);
    setLoaded(null);
    wsRef.current?.send(JSON.stringify({ type: 'unfocus' }));
  }, []);

  const loadMore = useCallback(() => {
    const f = focusRef.current;
    const st = loadedRef.current;
    if (!f || !st || st.sessionId !== f.sessionId || st.offset <= 0) return;
    wsRef.current?.send(JSON.stringify({ type: 'loadMore', file: f.file, sessionId: f.sessionId, before: st.offset }));
  }, []);

  // Only ever surface the transcript that matches the focused session — a previous
  // session's content must never linger while switching.
  const matches = !!loaded && loaded.sessionId === focusedId;
  return {
    snap,
    connected,
    focusedId,
    messages: matches ? loaded!.messages : null,
    hasMore: matches ? loaded!.offset > 0 : false,
    focus,
    unfocus,
    loadMore,
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

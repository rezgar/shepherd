import { useCallback, useEffect, useRef, useState } from 'react';
import type { Snapshot, Transcript } from './types';

const WS_URL = 'ws://localhost:4177';

export interface Shepherd {
  snap: Snapshot | null;
  transcript: Transcript | null;
  connected: boolean;
  focus: (file: string, sessionId: string) => void;
  unfocus: () => void;
}

/** One WebSocket to the daemon: streams the snapshot, and (when focused) the
 *  focused session's transcript, both auto-reconnecting. */
export function useShepherd(): Shepherd {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<{ file: string; sessionId: string } | null>(null);

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
        try {
          const data = JSON.parse(e.data as string);
          if (data?.type === 'snapshot') setSnap(data as Snapshot);
          else if (data?.type === 'transcript') setTranscript(data as Transcript);
        } catch {
          /* ignore malformed frame */
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
    setTranscript(null);
    wsRef.current?.send(JSON.stringify({ type: 'focus', file, sessionId }));
  }, []);

  const unfocus = useCallback(() => {
    focusRef.current = null;
    setTranscript(null);
    wsRef.current?.send(JSON.stringify({ type: 'unfocus' }));
  }, []);

  return { snap, transcript, connected, focus, unfocus };
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

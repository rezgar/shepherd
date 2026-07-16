import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMsg, Limits, Snapshot, SubagentInfo } from './types';

const WS_URL = 'ws://localhost:4177';

interface Loaded {
  sessionId: string;
  messages: ChatMsg[];
  offset: number; // index of the first loaded message in the full transcript
  total: number;
}

/** A draft held client-side because the session was busy when you hit send —
 *  never touches the wire until its session goes idle. */
export interface QueuedDraft {
  text: string;
  images: string[];
  /** Set when this draft was requeued after a real send-error — e.g. the
   *  daemon couldn't confirm the session ever started (slow under load) or
   *  some other failure — none of which clear on their own, since they're
   *  orthogonal to the transcript-derived "working" state the auto-flush
   *  effect watches. Auto-flush skips it; only an explicit retry
   *  (forceSendQueued) sends it, so a failure queues once instead of
   *  retrying in a tight, flickering loop. */
  blocked?: boolean;
  /** The daemon's own error text for the attempt that set `blocked` — shown
   *  verbatim so "busy elsewhere" isn't guessed at for failures that were
   *  actually something else entirely (a slow start, a dead process, etc). */
  blockReason?: string;
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
  send: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  /** Stop an in-flight reply Shepherd itself spawned for this session. */
  cancel: (sessionId: string) => void;
  /** Sessions with an in-flight reply. */
  sendingIds: Set<string>;
  /** sessionId -> when its current in-flight send started (Date.now()) — lets
   *  the UI show elapsed time and offer a way out once it's been a while,
   *  instead of an unexplained "sending…" with no sense of whether it's
   *  normal or stuck. */
  sendingSince: Record<string, number>;
  /** Hold a message client-side instead of sending — used while the session
   *  is busy. Appends to that session's queue; drains one at a time, oldest
   *  first, each only once the session is no longer "working". */
  queueSend: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  /** Drop one queued draft (by index) without sending it. */
  dequeueSend: (sessionId: string, index: number) => void;
  /** sessionId -> its held drafts in send order, for sessions with any queued. */
  queuedMsgs: Record<string, QueuedDraft[]>;
  /** Skip the wait: cancel whatever Shepherd has in flight for this session
   *  (if anything) and send the front of its queue right now. */
  forceSendQueued: (sessionId: string, cwd: string) => void;
  /** Ask the daemon to spawn a fresh session in this product's repo root. */
  spawn: (product: string) => void;
  /** Products with a spawn request still in flight — shows "spawning…" on the + card. */
  spawningProducts: Set<string>;
  /** Subagents the focused session dispatched that haven't finished yet. */
  activeSubagents: SubagentInfo[];
  openSubagent: (parentFile: string, sessionId: string, agentId: string, description: string) => void;
  closeSubagent: () => void;
  /** null while the modal is closed or its first window hasn't arrived yet. */
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  /** Sessions whose most recent send went out while another interactive
   *  process (a real terminal, or another relay) already had that exact
   *  session open — the message still sent, but its output may be
   *  interleaved with that other process's. Shown as a dismissible warning. */
  liveElsewhereWarnings: Set<string>;
  dismissLiveElsewhereWarning: (sessionId: string) => void;
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
  const [sendingIds, setSendingIds] = useState<Set<string>>(() => new Set());
  const [sendingSince, setSendingSince] = useState<Record<string, number>>({});
  // Shown instantly on send, before the CLI round-trip writes the real transcript
  // line — cleared once that reply lands (send-done/send-error/send-cancelled),
  // never merged into `loaded` itself so there's no id to reconcile against the
  // real one.
  const [pending, setPending] = useState<Record<string, PendingEcho>>({});
  // Persisted — a bare page reload must not silently drop a message that was
  // queued but never actually sent.
  const [queuedMsgs, setQueuedMsgs] = useState<Record<string, QueuedDraft[]>>(() => {
    try {
      const raw = localStorage.getItem('shepherd:queued');
      return raw ? (JSON.parse(raw) as Record<string, QueuedDraft[]>) : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    localStorage.setItem('shepherd:queued', JSON.stringify(queuedMsgs));
  }, [queuedMsgs]);
  const [activeSubagents, setActiveSubagents] = useState<SubagentInfo[]>([]);
  // product -> request timestamp, cleared once a fresher session shows up in
  // that group's snapshot, on a spawn-error, or after a safety timeout.
  const [spawning, setSpawning] = useState<Map<string, number>>(() => new Map());
  const [subagentModal, setSubagentModal] = useState<{
    agentId: string;
    description: string;
    messages: ChatMsg[] | null;
  } | null>(null);
  const [liveElsewhereWarnings, setLiveElsewhereWarnings] = useState<Set<string>>(() => new Set());

  const wsRef = useRef<WebSocket | null>(null);
  const focusRef = useRef<{ file: string; sessionId: string } | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  loadedRef.current = loaded;
  // React's setState updater callback does NOT run synchronously at the call
  // site — it's deferred to the reconciliation pass. Reading a value "out of"
  // a setPending(prev => ...) updater into a plain variable, then using that
  // variable later in the SAME synchronous block, reads it before the
  // updater has ever run (confirmed the hard way: the read logged before the
  // updater's own log line). A ref sidesteps this — always current, readable
  // synchronously anywhere.
  const pendingRef = useRef<Record<string, PendingEcho>>({});
  pendingRef.current = pending;
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
        } else if (d.type === 'limits') {
          setLimits({ session: d.session ?? null, weekly: d.weekly ?? null });
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
          setSendingSince((s) => {
            if (!(d.sessionId in s)) return s;
            const { [d.sessionId]: _drop, ...rest } = s;
            return rest;
          });
          // A failed send would otherwise just vanish — the echo is dropped
          // and nothing else remembers the text. Put it back at the front of
          // the queue instead, so it's visible and retriable rather than lost.
          // Read the about-to-be-dropped echo from the ref (synchronous,
          // always current) rather than out of the setPending updater itself
          // — that updater doesn't run until React's next reconciliation
          // pass, so reading it into a variable used later in this same
          // synchronous block was reading a value that didn't exist yet.
          const failed = pendingRef.current[d.sessionId]?.msg ?? null;
          setPending((p) => {
            if (!(d.sessionId in p)) return p;
            const { [d.sessionId]: _drop, ...rest } = p;
            return rest;
          });
          if (d.type === 'send-error') {
            console.warn('[shepherd] send failed:', d.error);
            if (failed) {
              setQueuedMsgs((q) => ({
                ...q,
                [d.sessionId]: [
                  { text: failed.text, images: failed.images, blocked: true, blockReason: d.error },
                  ...(q[d.sessionId] ?? []),
                ],
              }));
            }
          } else if (d.type === 'send-done') {
            // Clears itself the next time this session sends cleanly (no longer
            // live elsewhere) — otherwise a stale warning would linger forever
            // once the other window actually closed.
            setLiveElsewhereWarnings((s) => {
              const has = s.has(d.sessionId);
              if (!!d.wasLiveElsewhere === has) return s;
              const n = new Set(s);
              if (d.wasLiveElsewhere) n.add(d.sessionId);
              else n.delete(d.sessionId);
              return n;
            });
          }
        }
      };
      ws.onclose = () => {
        setConnected(false);
        // The daemon tracks in-flight sends only in memory, so once the socket
        // drops (daemon restart/crash) it can never deliver the completion that
        // clears these — leaving the composer stuck on "Sending…" forever.
        // Release them: after a disconnect the send is unrecoverable anyway.
        setSendingIds((s) => (s.size ? new Set() : s));
        setSendingSince((s) => (Object.keys(s).length ? {} : s));
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

  const send = useCallback((sessionId: string, cwd: string, text: string, images?: string[]) => {
    // A closed/not-yet-open socket makes `ws.send` throw — uncaught in a
    // callback like this one, that aborts everything AFTER it in the same
    // function, so the optimistic echo below would just never run and the
    // message vanishes with no trace and no way to retry it (confirmed the
    // hard way: typing while the daemon was down silently dropped
    // everything). Route it through the same requeue-as-blocked path a real
    // send-error uses instead, so it's always visible and retriable.
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setQueuedMsgs((q) => ({
        ...q,
        [sessionId]: [
          { text, images: images ?? [], blocked: true, blockReason: 'not connected to the daemon' },
          ...(q[sessionId] ?? []),
        ],
      }));
      return;
    }
    wsSend(wsRef.current, { type: 'send', sessionId, cwd, text, images });
    setSendingIds((s) => new Set(s).add(sessionId));
    setSendingSince((s) => ({ ...s, [sessionId]: Date.now() }));
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

  const queueSend = useCallback((sessionId: string, _cwd: string, text: string, images?: string[]) => {
    setQueuedMsgs((q) => ({ ...q, [sessionId]: [...(q[sessionId] ?? []), { text, images: images ?? [] }] }));
  }, []);

  const dequeueSend = useCallback((sessionId: string, index: number) => {
    setQueuedMsgs((q) => {
      const drafts = q[sessionId];
      if (!drafts || !drafts[index]) return q;
      const next = drafts.filter((_, i) => i !== index);
      if (next.length) return { ...q, [sessionId]: next };
      const { [sessionId]: _drop, ...rest } = q;
      return rest;
    });
  }, []);

  // Drain one queued draft at a time, oldest first — a session whose queue
  // has more behind it stays queued until this one's reply actually lands.
  // Gated on sendingIds (not just snapshot state) because a snapshot can lag
  // a beat behind send() actually starting; without that guard, two flushes
  // could fire for the same session before its state flips to "working",
  // sending drafts out of order into a session that isn't ready for either.
  //
  // A `blocked` head draft is skipped here — it was requeued after a real
  // send-error (usually the session being live in another window), which
  // `a.state` says nothing about. Without this, a permanent collision (e.g.
  // this exact session open in your own terminal) would auto-retry every
  // time the snapshot ticks, sending → failing → requeuing in a tight loop
  // that reads as constant flicker between "sending…" and "Queued".
  useEffect(() => {
    if (!snap || !Object.keys(queuedMsgs).length) return;
    const toFlush: Array<{ sessionId: string; cwd: string; draft: QueuedDraft }> = [];
    for (const [sessionId, drafts] of Object.entries(queuedMsgs)) {
      if (!drafts.length || drafts[0].blocked || sendingIds.has(sessionId)) continue;
      const a = snap.agents.find((x) => x.sessionId === sessionId);
      if (a && a.state !== 'working') toFlush.push({ sessionId, cwd: a.cwd, draft: drafts[0] });
    }
    if (!toFlush.length) return;
    setQueuedMsgs((q) => {
      const next = { ...q };
      for (const f of toFlush) {
        const rest = (next[f.sessionId] ?? []).slice(1);
        if (rest.length) next[f.sessionId] = rest;
        else delete next[f.sessionId];
      }
      return next;
    });
    for (const f of toFlush) send(f.sessionId, f.cwd, f.draft.text, f.draft.images);
  }, [snap, queuedMsgs, sendingIds, send]);

  const cancel = useCallback((sessionId: string) => {
    wsSend(wsRef.current, { type: 'cancel', sessionId });
    // Release the composer immediately rather than waiting for send-cancelled —
    // if the daemon already lost the handle (e.g. it restarted), that reply
    // would never come and the input would stay stuck.
    setSendingIds((s) => {
      if (!s.has(sessionId)) return s;
      const n = new Set(s);
      n.delete(sessionId);
      return n;
    });
    setSendingSince((s) => {
      if (!(sessionId in s)) return s;
      const { [sessionId]: _drop, ...rest } = s;
      return rest;
    });
    // Escape only interrupts generation — it doesn't erase what you typed
    // (the CLI itself hands an interrupted message back to its own input
    // line for a human to edit or resend). Do the parallel thing here
    // instead of silently discarding it: read it out of the ref (synchronous,
    // always current — see the matching comment on the send-error path for
    // why a plain variable read here would race React's own update) and put
    // it back as an editable queued draft.
    //
    // Marked `blocked` — not because it failed, but because that's the ONLY
    // flag the auto-flush effect (below) respects to skip a draft. Without
    // it, the effect sees a normal queued draft the instant the snapshot
    // next reports this session as non-"working" (which happens almost
    // immediately after a cancel) and re-sends it right back into the PTY on
    // its own — turning "stop" into "stop, then silently resend the same
    // message a beat later" (confirmed the hard way: the requeued draft
    // vanished with nothing in the transcript to show for it). An explicit
    // Retry is the only thing allowed to send this again.
    const cancelled = pendingRef.current[sessionId]?.msg ?? null;
    if (cancelled) {
      setQueuedMsgs((q) => ({
        ...q,
        [sessionId]: [
          { text: cancelled.text, images: cancelled.images, blocked: true, blockReason: 'stopped — press retry to resend when ready' },
          ...(q[sessionId] ?? []),
        ],
      }));
    }
    setPending((p) => {
      if (!(sessionId in p)) return p;
      const { [sessionId]: _drop, ...rest } = p;
      return rest;
    });
  }, []);

  const forceSendQueued = useCallback(
    (sessionId: string, cwd: string) => {
      const drafts = queuedMsgs[sessionId];
      if (!drafts?.length) return;
      if (sendingIds.has(sessionId)) cancel(sessionId); // best-effort — a no-op if it can't be stopped
      setQueuedMsgs((q) => {
        const rest = (q[sessionId] ?? []).slice(1);
        if (rest.length) return { ...q, [sessionId]: rest };
        const { [sessionId]: _drop, ...others } = q;
        return others;
      });
      send(sessionId, cwd, drafts[0].text, drafts[0].images);
    },
    [queuedMsgs, sendingIds, cancel, send],
  );

  const dismissLiveElsewhereWarning = useCallback((sessionId: string) => {
    setLiveElsewhereWarnings((s) => {
      if (!s.has(sessionId)) return s;
      const n = new Set(s);
      n.delete(sessionId);
      return n;
    });
  }, []);

  const spawn = useCallback((product: string) => {
    const since = Date.now();
    wsSend(wsRef.current, { type: 'spawn', product });
    setSpawning((s) => new Map(s).set(product, since));
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
    limits,
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
    sendingSince,
    queueSend,
    dequeueSend,
    queuedMsgs,
    forceSendQueued,
    spawn,
    spawningProducts: new Set(spawning.keys()),
    activeSubagents,
    openSubagent,
    closeSubagent,
    subagentModal,
    liveElsewhereWarnings,
    dismissLiveElsewhereWarning,
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

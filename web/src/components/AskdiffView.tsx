import { useEffect, useRef } from 'react';

function isAskdiffEscapeMessage(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'type' in data && data.type === 'askdiff-escape';
}

/** Embeds a session's pre-warmed askdiff instance. There's no embeddable
 *  component API for askdiff (it's a full SPA with its own WS channel) —
 *  this iframes its served URL directly. `port` is null until the daemon's
 *  pre-warm finishes (normally already true by the time this ever renders,
 *  since pre-warm starts the moment the session is focused, well before a
 *  click); `error` is set if the instance failed to start. Exactly one of
 *  {port, error} is ever meaningfully set at a time.
 *
 *  `visible` toggles CSS display only — it never unmounts the iframe. The
 *  askdiff UI keeps its entire Q&A history in an in-memory store with no
 *  persistence of its own (no localStorage, nothing server-side to replay
 *  to a fresh connection); destroying and recreating the iframe on every
 *  panel close or session switch silently wiped that history. The caller
 *  (FocusView's pool) is expected to keep one AskdiffView mounted per
 *  visited session for the life of the pool, only ever flipping `visible`. */
export function AskdiffView({
  visible,
  port,
  error,
  onEscape,
}: {
  visible: boolean;
  port: number | null;
  error: string | null;
  onEscape: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Escape typed while focus is inside the iframe fires in ITS OWN
  // document/window, never reaching a parent-side keydown listener —
  // iframes are a separate browsing context regardless of capture/bubble
  // phase. The served HTML relays it here via postMessage instead (see
  // vendor/askdiff/static-server.ts's ESCAPE_RELAY_SCRIPT); this checks
  // `event.source` against this exact iframe so an unrelated postMessage
  // elsewhere on the page can't trigger it. Only the currently-visible pool
  // entry can actually receive a keypress to relay, so this stays safe to
  // register unconditionally even while hidden.
  useEffect(() => {
    const onMessage = (e: MessageEvent<unknown>) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (isAskdiffEscapeMessage(e.data)) onEscape();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onEscape]);

  return (
    <div className="askdiff-view" style={visible ? undefined : { display: 'none' }}>
      {error ? (
        <div className="askdiff-view--status askdiff-view--error">
          <p>⚠ Couldn't start the diff view: {error}</p>
        </div>
      ) : port === null ? (
        <div className="askdiff-view--status">
          <p>Starting diff view…</p>
        </div>
      ) : (
        <iframe ref={iframeRef} className="askdiff-view__frame" src={`http://localhost:${port}/`} title="Diff view" />
      )}
    </div>
  );
}

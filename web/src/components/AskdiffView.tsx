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
 *  {port, error} is ever meaningfully set at a time. */
export function AskdiffView({
  port,
  error,
  onEscape,
}: {
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
  // elsewhere on the page can't trigger it.
  useEffect(() => {
    const onMessage = (e: MessageEvent<unknown>) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (isAskdiffEscapeMessage(e.data)) onEscape();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onEscape]);

  if (error) {
    return (
      <div className="askdiff-view--status askdiff-view--error">
        <p>⚠ Couldn't start the diff view: {error}</p>
      </div>
    );
  }
  if (port === null) {
    return (
      <div className="askdiff-view--status">
        <p>Starting diff view…</p>
      </div>
    );
  }
  return (
    <div className="askdiff-view">
      <iframe
        ref={iframeRef}
        className="askdiff-view__frame"
        src={`http://localhost:${port}/`}
        title="Diff view"
      />
    </div>
  );
}

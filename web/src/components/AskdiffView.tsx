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
 *  visited session for the life of the pool, only ever flipping `visible`.
 *
 *  `fontSize` (the same value driving the terminal's own A−/A+ controls)
 *  scales the whole embedded page via CSS `zoom` — there's no way to reach
 *  into a cross-origin iframe's own font-size, and askdiff's UI has no
 *  API/message for it either (its only inbound channel is the escape
 *  relay). `zoom` on the iframe itself asks Chromium to render that page
 *  at a different effective DPI (real reflow, not a blurry pixel stretch),
 *  same as the browser's own page-zoom would. Confirmed live: a plain
 *  `width: 100%; height: 100%` alongside `zoom` already fills the
 *  container exactly at any zoom level — the percentages resolve against
 *  the wrapper's real (unzoomed) size and the zoomed content reflows to
 *  fit that resolved box, no inverse-percentage compensation needed
 *  (tried that first; it left a gap, since it was solving a problem `zoom`
 *  doesn't actually have here). Sized via a wrapper so the flex-item
 *  sizing this used to have directly lives on a plain, unzoomed element —
 *  zoom is applied to the LEAF element so it can't also disturb the flex
 *  layout that positions it. */
export function AskdiffView({
  visible,
  port,
  error,
  fontSize,
  onEscape,
}: {
  visible: boolean;
  port: number | null;
  error: string | null;
  fontSize: number;
  onEscape: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const zoom = fontSize / 14;

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
        <div className="askdiff-view__frame-wrap">
          <iframe
            ref={iframeRef}
            className="askdiff-view__frame"
            src={`http://localhost:${port}/`}
            title="Diff view"
            style={{ zoom, width: "100%", height: "100%" }}
          />
        </div>
      )}
    </div>
  );
}

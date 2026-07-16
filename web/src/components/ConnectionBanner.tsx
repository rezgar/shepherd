import { useState } from 'react';

const CONTROL_URL = 'http://localhost:4178/restart-daemon';

/** Shown whenever the WebSocket to the daemon isn't connected — sends,
 *  live updates, everything routes through it, so losing it needs to be
 *  loud, not a small label easy to miss while heads-down in a chat.
 *  `everConnected` distinguishes "still starting up" from "was working,
 *  then died" — the latter is the case worth a restart button for. */
export function ConnectionBanner({ everConnected }: { everConnected: boolean }) {
  const [restarting, setRestarting] = useState(false);
  const [result, setResult] = useState<'ok' | 'error' | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const restart = async () => {
    setRestarting(true);
    setResult(null);
    setErrorDetail(null);
    try {
      const res = await fetch(CONTROL_URL, { method: 'POST' });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.ok) {
        setResult('ok');
      } else {
        setResult('error');
        setErrorDetail(body?.error ?? `HTTP ${res.status}`);
      }
    } catch {
      setResult('error');
      setErrorDetail('could not reach the supervisor on :4178 — is it running? (`pnpm serve:web`)');
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="conn-banner">
      <span className="conn-banner__text">
        {everConnected
          ? '⚠ Lost connection to the Shepherd daemon — sends and live updates are paused until it reconnects.'
          : '⚠ Waiting for the Shepherd daemon to start…'}
      </span>
      <span className="conn-banner__actions">
        <button className="conn-banner__restart" onClick={restart} disabled={restarting}>
          {restarting ? 'Restarting…' : '↻ Restart daemon'}
        </button>
        {result === 'ok' && <span className="conn-banner__result conn-banner__result--ok">restart requested — reconnecting…</span>}
        {result === 'error' && <span className="conn-banner__result conn-banner__result--error">{errorDetail}</span>}
      </span>
    </div>
  );
}

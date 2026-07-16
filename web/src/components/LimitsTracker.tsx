import { humAgo } from '../lib/format';
import type { Limits } from '../types';

const SEGMENTS = 10;

function Bar({ label, percent, resetMs }: { label: string; percent: number; resetMs: number }) {
  const filled = Math.round((percent / 100) * SEGMENTS);
  return (
    <div className="limits__bar" title={`${label} usage: ~${percent}% (estimated) · resets in ${humAgo(resetMs)}`}>
      <span className="limits__label">{label}</span>
      <span className="limits__segments">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <i key={i} className={i < filled ? 'on' : ''} />
        ))}
      </span>
      <span className="limits__pct">
        {percent}% · {humAgo(resetMs)}
      </span>
    </div>
  );
}

/** Claude Code's own 5h/7d rolling usage bars, estimated locally from
 *  transcripts via ccusage (see server/src/usage.ts) — not the account's
 *  exact enforced percentage, which only Anthropic's account API knows. */
export function LimitsTracker({ limits }: { limits: Limits | null }) {
  if (!limits || (!limits.session && !limits.weekly)) return null;
  return (
    <div className="limits">
      {limits.session && <Bar label="5h" percent={limits.session.percent} resetMs={limits.session.resetMs} />}
      {limits.weekly && <Bar label="7d" percent={limits.weekly.percent} resetMs={limits.weekly.resetMs} />}
    </div>
  );
}

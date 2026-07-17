import { humAgo } from '../lib/format';
import type { Limits } from '../types';

const SEGMENTS = 10;

function Bar({ label, percent, resetMs }: { label: string; percent: number; resetMs: number }) {
  const filled = Math.round((percent / 100) * SEGMENTS);
  return (
    <div className="limits__bar" title={`${label} usage: ${percent}% · resets in ${humAgo(resetMs)}`}>
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

/** Claude Code's own weekly usage bar — the account's real enforced
 *  percentage, read straight from /usage itself (see server/src/usage.ts),
 *  not a local estimate. The 5h/session bar is deliberately not shown; the
 *  weekly limit is the one that gates longer work. */
export function LimitsTracker({ limits }: { limits: Limits | null }) {
  if (!limits || !limits.weekly) return null;
  return (
    <div className="limits">
      <Bar label="week" percent={limits.weekly.percent} resetMs={limits.weekly.resetMs} />
    </div>
  );
}

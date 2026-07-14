import { useSpinGlyph } from '../lib/useSpinGlyph';
import type { SubagentInfo } from '../types';

/** Claude-Code-style "✽ Transfiguring…" row, pinned at the bottom of the chat
 *  while the focused session is actively working — unchanged from before.
 *  Subagent chips get their own distinct blue row ABOVE it, not blended in,
 *  since they're a different kind of thing (a dispatched child, not the
 *  parent's own status). `status` is undefined when the parent itself has
 *  gone quiet (its own "actively running" window lapsed) but a dispatched
 *  subagent is still grinding away much longer than that — the chips stay
 *  up either way. */
export function WorkingIndicator({
  status,
  subagents,
  onSelectSubagent,
}: {
  status?: string;
  subagents: SubagentInfo[];
  onSelectSubagent: (s: SubagentInfo) => void;
}) {
  const glyph = useSpinGlyph(true);
  return (
    <div className="working-indicator">
      {subagents.length > 0 && (
        <div className="working-indicator__subagents">
          {subagents.map((s) => (
            <button key={s.agentId} className="subagent-chip" onClick={() => onSelectSubagent(s)} title={s.description}>
              <span className="subagent-chip__glyph">✳</span>
              {s.description}
            </button>
          ))}
        </div>
      )}
      {status && (
        <div className="working-indicator__row">
          <span className="working-indicator__glyph">{glyph}</span>
          <span className="working-indicator__text">{status}</span>
        </div>
      )}
    </div>
  );
}

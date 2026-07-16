import { useSpinGlyph } from '../lib/useSpinGlyph';
import type { SubagentInfo, TaskLine } from '../types';

/** Current task (bold/white, with the spinner glyph) followed by every
 *  still-upcoming one in gray — one line, ellipsis-truncated if it's too
 *  long to fit. No scrolling; completed tasks aren't shown here at all. */
function TaskLineRow({ glyph, taskLine }: { glyph: string; taskLine: TaskLine }) {
  return (
    <div className="working-indicator__row working-indicator__taskline">
      <b className="working-indicator__current">
        {glyph} {taskLine.current ?? 'working…'}
      </b>
      {taskLine.upcoming.length > 0 && (
        <span className="working-indicator__upcoming">{taskLine.upcoming.join('  ·  ')}</span>
      )}
    </div>
  );
}

/** Claude-Code-style "✽ Transfiguring…" row, pinned at the bottom of the chat
 *  while the focused session is actively working. Subagent chips get their
 *  own distinct blue row ABOVE it, not blended in, since they're a different
 *  kind of thing (a dispatched child, not the parent's own status). `status`
 *  is undefined when the parent itself has gone quiet (its own "actively
 *  running" window lapsed) but a dispatched subagent is still grinding away
 *  much longer than that — the chips stay up either way.
 *
 *  When the session tracks an explicit todo list (`taskLine`), that replaces
 *  the plain status text with a done/current/next line instead. */
export function WorkingIndicator({
  status,
  taskLine,
  subagents,
  onSelectSubagent,
}: {
  status?: string;
  taskLine?: TaskLine;
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
      {taskLine ? (
        <TaskLineRow glyph={glyph} taskLine={taskLine} />
      ) : (
        status && (
          <div className="working-indicator__row">
            <span className="working-indicator__glyph">{glyph}</span>
            <span className="working-indicator__text">{status}</span>
          </div>
        )
      )}
    </div>
  );
}

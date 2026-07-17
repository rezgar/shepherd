import type { AgentModel } from '../types';
import { STAGE_LABELS, STAGES, stageIndex, humAgo } from '../lib/format';
import { useSpinGlyph } from '../lib/useSpinGlyph';

const STATE_DOT: Record<AgentModel['state'], string> = {
  error: '#f85149',
  'needs-you': '#f0883e',
  working: '#3fb950',
  idle: '#8b949e',
};

export function AgentCard({
  agent,
  now,
  compact,
  selected,
  onClick,
  displayName,
  onHide,
}: {
  agent: AgentModel;
  now: number;
  compact?: boolean;
  selected?: boolean;
  onClick?: () => void;
  displayName?: string;
  onHide?: () => void;
}) {
  const needs = agent.state === 'needs-you';
  const working = agent.state === 'working';
  const errored = agent.state === 'error';
  const glyph = useSpinGlyph(working);
  const cur = stageIndex(agent.stage);
  const ago = humAgo(now - agent.lastActivity);
  const name = displayName ?? agent.name;
  // Prefer the conceptual, model-written summary of what the agent is doing
  // and how it's going (set only for working / just-finished sessions). Falls
  // back to the explicit todo's current item, then the heuristic `status` gist
  // — so needs-you/error cards, and any session without a summary yet, keep
  // their existing line and the card is never blank. `||` (not `??`) so an
  // empty summary also falls through.
  const statusText = agent.summary || agent.taskLine?.current || agent.status;

  const cls = [
    'card',
    errored && 'card--error',
    needs && 'card--needs',
    working && 'card--working',
    agent.state === 'idle' && 'card--idle',
    compact && 'card--compact',
    selected && 'card--selected',
    onClick && 'card--clickable',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onClick={onClick}>
      {errored && <span className="badge badge--error">⚠</span>}
      {needs && <span className="badge">!</span>}
      {onHide && (
        <button
          className="card__hide"
          title="Hide session"
          onClick={(e) => {
            e.stopPropagation();
            onHide();
          }}
        >
          ×
        </button>
      )}

      <div className="card__top">
        {working ? (
          <span className="spin" aria-label="working">
            {glyph}
          </span>
        ) : (
          <span className="dot" style={{ background: STATE_DOT[agent.state] }} />
        )}
        {agent.queued > 0 && <span className="card__queued">⌸{agent.queued}</span>}
        <span className="card__ago">{ago}</span>
      </div>

      {/* progress bar above the title */}
      <div className="pips" aria-label={`stage ${agent.stage}`} title={`stage: ${agent.stage}`}>
        {STAGES.map((_, i) => {
          const c = cur < 0 ? '' : i < cur ? 'g' : i === cur ? (needs ? 'a' : 'g') : '';
          return <i key={i} className={c} />;
        })}
      </div>
      {!compact && (
        <div className="pips__labels">
          {STAGE_LABELS.map((l, i) => (
            <span key={l} className={i === cur ? 'on' : ''}>
              {l}
            </span>
          ))}
        </div>
      )}

      <div className="card__name" title={`${name}\n${agent.label} · ${agent.cwd}`}>
        {name}
      </div>

      <div
        className={`card__status${needs ? ' card__status--needs' : ''}${errored ? ' card__status--error' : ''}`}
        title={statusText}
      >
        {statusText}
      </div>
    </div>
  );
}

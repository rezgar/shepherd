import type { AgentModel } from '../types';
import { STAGE_LABELS, STAGES, stageIndex, humAgo } from '../lib/format';

const STATE_DOT: Record<AgentModel['state'], string> = {
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
}: {
  agent: AgentModel;
  now: number;
  compact?: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  const needs = agent.state === 'needs-you';
  const cur = stageIndex(agent.stage);
  const ago = humAgo(now - agent.lastActivity);

  const cls = [
    'card',
    needs && 'card--needs',
    agent.state === 'idle' && 'card--idle',
    compact && 'card--compact',
    selected && 'card--selected',
    onClick && 'card--clickable',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} onClick={onClick}>
      {needs && <span className="badge">!</span>}

      <div className="card__top">
        <span className="dot" style={{ background: STATE_DOT[agent.state] }} />
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

      <div className="card__name" title={`${agent.name}\n${agent.label} · ${agent.cwd}`}>
        {agent.name}
      </div>

      {needs && (
        <div className="card__kind">{agent.action === 'approve' ? '⏸ APPROVE' : '❔ QUESTION'}</div>
      )}
      <div className={`card__status${needs ? ' card__status--needs' : ''}`} title={agent.status}>
        {agent.status}
      </div>
    </div>
  );
}

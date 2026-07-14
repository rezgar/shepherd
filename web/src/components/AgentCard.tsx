import type { AgentModel } from '../types';
import { STAGE_LABELS, STAGES, stageIndex, humAgo } from '../lib/format';

const STATE_DOT: Record<AgentModel['state'], string> = {
  'needs-you': '#f0883e',
  working: '#3fb950',
  idle: '#8b949e',
};

export function AgentCard({ agent, now }: { agent: AgentModel; now: number }) {
  const needs = agent.state === 'needs-you';
  const cur = stageIndex(agent.stage);
  const ago = humAgo(now - agent.lastActivity);

  return (
    <div className={`card${needs ? ' card--needs' : ''}${agent.state === 'idle' ? ' card--idle' : ''}`}>
      {needs && <span className="badge">!</span>}

      <div className="card__top">
        <span className="dot" style={{ background: STATE_DOT[agent.state] }} />
        <span className="card__label" title={agent.title ?? agent.cwd}>
          {agent.label}
        </span>
        {agent.queued > 0 && <span className="card__queued">⌸{agent.queued}</span>}
        <span className="card__ago">{ago}</span>
      </div>

      {needs && (
        <div className="card__kind">{agent.action === 'approve' ? '⏸ APPROVE' : '❔ ANSWER'}</div>
      )}

      <div className="pips" aria-label={`stage ${agent.stage}`}>
        {STAGES.map((_, i) => {
          const cls = cur < 0 ? '' : i < cur ? 'g' : i === cur ? (needs ? 'a' : 'g') : '';
          return <i key={i} className={cls} />;
        })}
      </div>
      <div className="pips__labels">
        {STAGE_LABELS.map((l, i) => (
          <span key={l} className={i === cur ? 'on' : ''}>
            {l}
          </span>
        ))}
      </div>

      <div className={`card__status${needs ? ' card__status--needs' : ''}`}>{agent.status}</div>
    </div>
  );
}

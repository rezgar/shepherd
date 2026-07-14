import type { AgentModel } from '../types';
import { AgentCard } from './AgentCard';

export function ProjectLane({
  product,
  agents,
  now,
  color,
  onSelect,
  nameOf,
  onHide,
}: {
  product: string;
  agents: AgentModel[];
  now: number;
  color: string;
  onSelect: (a: AgentModel) => void;
  nameOf: (a: AgentModel) => string;
  onHide: (sessionId: string) => void;
}) {
  const needs = agents.filter((a) => a.state === 'needs-you').length;

  return (
    <div className="lane">
      <div className="lane__tab" style={{ background: color, color: '#04121f' }}>
        <span className="lane__name">{product}</span>
        <span className="lane__count">· {agents.length}</span>
        {needs > 0 && <span className="lane__need">{needs} ⏵</span>}
      </div>
      <div className="lane__body" style={{ borderColor: color + '55' }}>
        {agents.map((a) => (
          <AgentCard
            key={a.sessionId}
            agent={a}
            now={now}
            displayName={nameOf(a)}
            onClick={() => onSelect(a)}
            onHide={() => onHide(a.sessionId)}
          />
        ))}
      </div>
    </div>
  );
}

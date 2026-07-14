import type { AgentModel } from '../types';
import { AgentCard } from './AgentCard';

const STATE_RANK: Record<AgentModel['state'], number> = { 'needs-you': 0, working: 1, idle: 2 };

export function ProjectLane({
  product,
  agents,
  now,
  color,
  onSelect,
}: {
  product: string;
  agents: AgentModel[];
  now: number;
  color: string;
  onSelect: (a: AgentModel) => void;
}) {
  const needs = agents.filter((a) => a.state === 'needs-you').length;
  const sorted = [...agents].sort(
    (a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || b.lastActivity - a.lastActivity,
  );

  return (
    <div className="lane">
      <div className="lane__tab" style={{ background: color, color: '#04121f' }}>
        <span className="lane__name">{product}</span>
        <span className="lane__count">· {agents.length}</span>
        {needs > 0 && <span className="lane__need">{needs} ⏵</span>}
      </div>
      <div className="lane__body" style={{ borderColor: color + '55' }}>
        {sorted.map((a) => (
          <AgentCard key={a.sessionId} agent={a} now={now} onClick={() => onSelect(a)} />
        ))}
      </div>
    </div>
  );
}

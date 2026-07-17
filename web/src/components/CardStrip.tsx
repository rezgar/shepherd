import type { AgentModel } from '../types';
import { AgentCard } from './AgentCard';
import { groupByProductOrdered } from '../lib/format';

/** The persistent product-grouped strip shown across the top of focus mode —
 *  only the sessions you've explicitly opened (see App's openedAt), ordered
 *  by when you first opened each one, not by creation time. Re-opening an
 *  already-listed session doesn't move it — same as a browser tab. */
export function CardStrip({
  agents,
  focusedId,
  now,
  colorOf,
  onSelect,
  nameOf,
  onHide,
  onSpawn,
  spawningProducts,
  openedAt,
}: {
  agents: AgentModel[];
  focusedId: string;
  now: number;
  colorOf: (product: string) => string;
  onSelect: (a: AgentModel) => void;
  nameOf: (a: AgentModel) => string;
  onHide: (sessionId: string) => void;
  onSpawn: (product: string) => void;
  spawningProducts: Set<string>;
  openedAt: Record<string, number>;
}) {
  return (
    <div className="strip">
      {groupByProductOrdered(agents, (a) => openedAt[a.sessionId] ?? 0).map(([product, ags]) => (
        <div className="strip__group" key={product}>
          <div className="strip__tab" style={{ background: colorOf(product), color: '#04121f' }}>
            {product}
          </div>
          <div className="strip__cards">
            {ags.map((a) => (
              <AgentCard
                key={a.sessionId}
                agent={a}
                now={now}
                compact
                selected={a.sessionId === focusedId}
                onClick={() => onSelect(a)}
                displayName={nameOf(a)}
                onHide={() => onHide(a.sessionId)}
              />
            ))}
            <button
              className="new-session-card"
              disabled={spawningProducts.has(product)}
              onClick={() => onSpawn(product)}
              title={`Start a new session in ${product}`}
            >
              {spawningProducts.has(product) ? '…' : '+'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

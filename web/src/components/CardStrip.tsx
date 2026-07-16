import type { AgentModel } from '../types';
import { AgentCard } from './AgentCard';
import { groupByProduct } from '../lib/format';

/** The persistent product-grouped strip shown across the top of focus mode. */
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
}) {
  return (
    <div className="strip">
      {groupByProduct(agents).map(([product, ags]) => (
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

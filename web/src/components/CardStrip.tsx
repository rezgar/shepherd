import { useRef } from 'react';
import type { AgentModel } from '../types';
import { AgentCard } from './AgentCard';
import { groupStrip, type StripState } from '../lib/order';

/** The persistent product-grouped strip shown across the top of focus mode —
 *  only the sessions you've explicitly opened (see App's openedAt). Order
 *  follows your manual drag order, falling back to first-opened time (see
 *  order.ts). Drag a project's tab to reorder groups; drag a session card to
 *  reorder within its group (a session can't move to another project). */
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
  stripState,
  onReorderProduct,
  onReorderSession,
  iconOnly,
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
  stripState: StripState;
  onReorderProduct: (dragged: string, target: string) => void;
  onReorderSession: (product: string, dragged: string, target: string) => void;
  /** Collapses every card (and the product tabs / "+" button) to a narrow
   *  icon rail — used while the askdiff panel is open so switching sessions
   *  stays possible without costing the diff panel much width. */
  iconOnly?: boolean;
}) {
  // Transient drag state — what's being dragged right now. A ref (not state)
  // because it changes many times per drag and never needs to re-render.
  const drag = useRef<{ kind: 'product'; product: string } | { kind: 'session'; product: string; id: string } | null>(
    null,
  );

  return (
    <div className={iconOnly ? 'strip strip--icon-only' : 'strip'}>
      {groupStrip(agents, stripState).map(([product, ags]) => (
        <div
          className="strip__group"
          key={product}
          onDragOver={(e) => {
            if (drag.current?.kind === 'product') e.preventDefault();
          }}
          onDrop={(e) => {
            const d = drag.current;
            if (d?.kind === 'product' && d.product !== product) {
              e.preventDefault();
              onReorderProduct(d.product, product);
            }
          }}
        >
          <div
            className="strip__tab"
            style={{ background: colorOf(product), color: '#04121f' }}
            draggable
            title={`${product} — drag to reorder projects`}
            onDragStart={() => {
              drag.current = { kind: 'product', product };
            }}
            onDragEnd={() => {
              drag.current = null;
            }}
          >
            {iconOnly ? product.slice(0, 1).toUpperCase() : product}
          </div>
          <div className="strip__cards">
            {ags.map((a) => (
              <div
                key={a.sessionId}
                className="strip__card-wrap"
                draggable
                onDragStart={(e) => {
                  e.stopPropagation();
                  drag.current = { kind: 'session', product, id: a.sessionId };
                }}
                onDragEnd={() => {
                  drag.current = null;
                }}
                onDragOver={(e) => {
                  const d = drag.current;
                  // Only a same-project session drag is a valid drop here.
                  if (d?.kind === 'session' && d.product === product) e.preventDefault();
                }}
                onDrop={(e) => {
                  const d = drag.current;
                  if (d?.kind === 'session' && d.product === product && d.id !== a.sessionId) {
                    e.stopPropagation();
                    onReorderSession(product, d.id, a.sessionId);
                  }
                }}
              >
                <AgentCard
                  agent={a}
                  now={now}
                  compact
                  iconOnly={iconOnly}
                  selected={a.sessionId === focusedId}
                  onClick={() => onSelect(a)}
                  displayName={nameOf(a)}
                  onHide={() => onHide(a.sessionId)}
                />
              </div>
            ))}
            {!iconOnly && (
              <button
                className="new-session-card"
                disabled={spawningProducts.has(product)}
                onClick={() => onSpawn(product)}
                title={`Start a new session in ${product}`}
              >
                {spawningProducts.has(product) ? '…' : '+'}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

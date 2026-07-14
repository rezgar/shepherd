import { useSnapshot, useTick } from './api';
import { ProjectLane } from './components/ProjectLane';
import type { AgentModel } from './types';

function groupByProduct(agents: AgentModel[]): [string, AgentModel[]][] {
  const map = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = map.get(a.product) ?? [];
    arr.push(a);
    map.set(a.product, arr);
  }
  // Products with someone waiting on you float first, then by most-recent activity.
  return [...map.entries()].sort((a, b) => {
    const an = a[1].some((x) => x.state === 'needs-you') ? 0 : 1;
    const bn = b[1].some((x) => x.state === 'needs-you') ? 0 : 1;
    if (an !== bn) return an - bn;
    const at = Math.max(...a[1].map((x) => x.lastActivity));
    const bt = Math.max(...b[1].map((x) => x.lastActivity));
    return bt - at;
  });
}

export function App() {
  const { snap, connected } = useSnapshot();
  const now = useTick(1000);

  if (!snap) {
    return (
      <div className="shell">
        <div className="empty">{connected ? 'No sessions found.' : 'Connecting to shepherd daemon…'}</div>
      </div>
    );
  }

  const needsYou = snap.agents.filter((a) => a.state === 'needs-you').length;
  const working = snap.agents.filter((a) => a.state === 'working').length;
  const groups = groupByProduct(snap.agents);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">🐑 Agent Shepherd</span>
        <span className="counts">
          {snap.agents.length} agents · <b className="c-work">{working} working</b>
          {needsYou > 0 && (
            <>
              {' · '}
              <b className="c-need">{needsYou} need you</b>
            </>
          )}
        </span>
        <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? 'live' : 'reconnecting…'}</span>
      </header>

      <main className="canvas">
        {groups.map(([product, agents]) => (
          <ProjectLane key={product} product={product} agents={agents} now={now} />
        ))}
      </main>
    </div>
  );
}

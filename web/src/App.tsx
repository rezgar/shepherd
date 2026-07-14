import { useMemo, useState } from 'react';
import { useShepherd, useTick } from './api';
import { ProjectLane } from './components/ProjectLane';
import { FocusView } from './components/FocusView';
import type { AgentModel } from './types';

const PALETTE = ['#58a6ff', '#bc8cff', '#39c5cf', '#e3b341', '#f0883e', '#56d364', '#ff7b72', '#79c0ff'];
const WINDOWS = [1, 4, 12, 24];

function groupByProduct(agents: AgentModel[]): [string, AgentModel[]][] {
  const map = new Map<string, AgentModel[]>();
  for (const a of agents) {
    const arr = map.get(a.product) ?? [];
    arr.push(a);
    map.set(a.product, arr);
  }
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
  const { snap, transcript, connected, focus, unfocus } = useShepherd();
  const now = useTick(1000);
  const [windowH, setWindowH] = useState(4);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const colorMap = useMemo(() => {
    const names = snap ? [...new Set(snap.agents.map((a) => a.product))].sort() : [];
    const m = new Map<string, string>();
    names.forEach((n, i) => m.set(n, PALETTE[i % PALETTE.length]));
    return m;
  }, [snap]);
  const colorOf = (product: string) => colorMap.get(product) ?? '#58a6ff';

  if (!snap) {
    return (
      <div className="shell">
        <div className="empty">{connected ? 'No sessions found.' : 'Connecting to shepherd daemon…'}</div>
      </div>
    );
  }

  const latest = snap.agents.reduce((mx, a) => Math.max(mx, a.lastActivity), 0);
  const cutoff = latest - windowH * 3_600_000;
  const visible = snap.agents.filter((a) => a.lastActivity >= cutoff);

  const openAgent = (a: AgentModel) => {
    setFocusedId(a.sessionId);
    focus(a.file, a.sessionId);
  };
  const closeFocus = () => {
    setFocusedId(null);
    unfocus();
  };

  const focused = focusedId ? (snap.agents.find((a) => a.sessionId === focusedId) ?? null) : null;

  if (focused) {
    return (
      <FocusView
        agents={visible}
        focused={focused}
        transcript={transcript && transcript.sessionId === focused.sessionId ? transcript : null}
        now={now}
        colorOf={colorOf}
        onSelect={openAgent}
        onExit={closeFocus}
      />
    );
  }

  const needsYou = visible.filter((a) => a.state === 'needs-you').length;
  const working = visible.filter((a) => a.state === 'working').length;
  const groups = groupByProduct(visible);

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">🐑 Agent Shepherd</span>
        <span className="counts">
          {visible.length} agents · <b className="c-work">{working} working</b>
          {needsYou > 0 && (
            <>
              {' · '}
              <b className="c-need">{needsYou} need you</b>
            </>
          )}
        </span>
        <label className="winsel">
          active last
          <select value={windowH} onChange={(e) => setWindowH(Number(e.target.value))}>
            {WINDOWS.map((h) => (
              <option key={h} value={h}>
                {h}h
              </option>
            ))}
          </select>
        </label>
        <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? 'live' : 'reconnecting…'}</span>
      </header>

      <main className="canvas">
        {groups.map(([product, agents]) => (
          <ProjectLane
            key={product}
            product={product}
            agents={agents}
            now={now}
            color={colorOf(product)}
            onSelect={openAgent}
          />
        ))}
      </main>
    </div>
  );
}

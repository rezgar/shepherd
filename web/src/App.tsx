import { useEffect, useMemo, useRef, useState } from 'react';
import { useShepherd, useTick } from './api';
import { ProjectLane } from './components/ProjectLane';
import { FocusView } from './components/FocusView';
import { LimitsTracker } from './components/LimitsTracker';
import { ConnectionBanner } from './components/ConnectionBanner';
import { NewProjectModal } from './components/NewProjectModal';
import { groupByProduct } from './lib/format';
import { stripAgents, stripOrder, groupStrip, reorder, neighborAfterClose, type StripState } from './lib/order';
import { playDone, playError, playNeedsYou, unlockAudio } from './lib/sound';
import type { AgentModel, AgentState } from './types';

const PALETTE = ['#58a6ff', '#bc8cff', '#39c5cf', '#e3b341', '#f0883e', '#56d364', '#ff7b72', '#79c0ff'];
const WINDOWS = [1, 4, 12, 24];

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function App() {
  const {
    snap,
    limits,
    connected,
    focusedId,
    focus,
    unfocus,
    termResetKey,
    termError,
    attachTerminal,
    detachTerminal,
    subscribeTerminal,
    resizeTerm,
    sendTerminalKey,
    spawn,
    spawningProducts,
    spawnErrors,
    justSpawned,
    consumeSpawned,
    dirListing,
    dirListingError,
    listDir,
    activeSubagents,
    openSubagent,
    closeSubagent,
    subagentModal,
  } = useShepherd();
  const now = useTick(1000);
  // Never resets once true — distinguishes "still starting up" (fine, just
  // wait) from "was working, then the daemon died" (worth a restart button).
  const everConnectedRef = useRef(false);
  if (connected) everConnectedRef.current = true;
  const [windowH, setWindowH] = useState(4);
  const [fontSize, setFontSize] = useState<number>(() => load('shepherd:font', 14));
  const [renames, setRenames] = useState<Record<string, string>>(() => load('shepherd:names', {}));
  const [hidden, setHidden] = useState<Record<string, true>>(() => load('shepherd:hidden', {}));
  const [showHidden, setShowHidden] = useState(false);
  const [muted, setMuted] = useState<boolean>(() => load('shepherd:muted', false));
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  // sessionId -> when you FIRST opened it in Shepherd — drives the focus-mode
  // top strip, which shows only sessions you've explicitly opened (not every
  // active one) in a stable order (re-opening one doesn't move it, same as a
  // browser tab), instead of every active session sorted by creation time.
  const [openedAt, setOpenedAt] = useState<Record<string, number>>(() => load('shepherd:openedAt', {}));
  // Manual drag order for the focus strip: product-group order, and session
  // order within each product. Anything not explicitly placed falls back to
  // first-opened time (see order.ts).
  const [productOrder, setProductOrder] = useState<string[]>(() => load('shepherd:productOrder', []));
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() =>
    load('shepherd:sessionOrder', {}),
  );

  useEffect(() => {
    localStorage.setItem('shepherd:font', JSON.stringify(fontSize));
  }, [fontSize]);
  useEffect(() => {
    localStorage.setItem('shepherd:names', JSON.stringify(renames));
  }, [renames]);
  useEffect(() => {
    localStorage.setItem('shepherd:hidden', JSON.stringify(hidden));
  }, [hidden]);
  useEffect(() => {
    localStorage.setItem('shepherd:muted', JSON.stringify(muted));
  }, [muted]);
  useEffect(() => {
    localStorage.setItem('shepherd:openedAt', JSON.stringify(openedAt));
  }, [openedAt]);
  useEffect(() => {
    localStorage.setItem('shepherd:productOrder', JSON.stringify(productOrder));
  }, [productOrder]);
  useEffect(() => {
    localStorage.setItem('shepherd:sessionOrder', JSON.stringify(sessionOrder));
  }, [sessionOrder]);

  // Browsers suspend audio until a user gesture — warm it up on the first one.
  useEffect(() => {
    const onFirstInteraction = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
    };
    window.addEventListener('pointerdown', onFirstInteraction);
    window.addEventListener('keydown', onFirstInteraction);
    return () => {
      window.removeEventListener('pointerdown', onFirstInteraction);
      window.removeEventListener('keydown', onFirstInteraction);
    };
  }, []);

  // Ding on state transitions: done (working → idle), needs-you (anything →
  // needs-you), error (anything → error). Never on the first snapshot seen
  // for a session — that would ding for states that already existed before
  // Shepherd connected/reconnected, not a fresh transition.
  const prevStates = useRef<Map<string, AgentState>>(new Map());
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  useEffect(() => {
    if (!snap) return;
    const prev = prevStates.current;
    for (const a of snap.agents) {
      const was = prev.get(a.sessionId);
      prev.set(a.sessionId, a.state);
      if (was === undefined || was === a.state || mutedRef.current) continue;
      if (a.state === 'error') playError();
      else if (a.state === 'needs-you') playNeedsYou();
      else if (a.state === 'idle' && was === 'working') playDone();
    }
  }, [snap]);

  const colorMap = useMemo(() => {
    const names = snap ? [...new Set(snap.agents.map((a) => a.product))].sort() : [];
    const m = new Map<string, string>();
    names.forEach((n, i) => m.set(n, PALETTE[i % PALETTE.length]));
    return m;
  }, [snap]);
  const colorOf = (product: string) => colorMap.get(product) ?? '#58a6ff';
  const nameOf = (a: AgentModel) => renames[a.sessionId] || a.name;
  const rename = (sessionId: string, name: string) =>
    setRenames((r) => {
      const next = { ...r };
      if (name) next[sessionId] = name;
      else delete next[sessionId];
      return next;
    });
  const changeFont = (delta: number) => setFontSize((f) => Math.max(12, Math.min(22, f + delta)));
  const hide = (sessionId: string) =>
    setHidden((h) => ({ ...h, [sessionId]: true }));
  const restore = (sessionId: string) =>
    setHidden((h) => {
      const next = { ...h };
      delete next[sessionId];
      return next;
    });

  // The single path every "go look at this session" action goes through —
  // records the first-opened timestamp (a no-op if already recorded, so
  // re-opening never moves its position in the strip) before deferring to
  // the real focus() from useShepherd.
  const openSession = (file: string, sessionId: string) => {
    setOpenedAt((prev) => (sessionId in prev ? prev : { ...prev, [sessionId]: Date.now() }));
    focus(file, sessionId);
  };
  // Removes a session from the focus-mode strip's explicit-open list. When you
  // close the session you're viewing, land on a neighbor in the strip — the
  // previous one, or the next if it was first — instead of dropping back to the
  // canvas. Only when nothing else is open does it exit focus mode. `openedOrder`
  // is read at call time (post-render), so it reflects the current strip order.
  const closeOpened = (sessionId: string) => {
    const wasFocused = sessionId === focusedId;
    const neighbor = wasFocused ? neighborAfterClose(openedOrder, sessionId) : null;
    setOpenedAt((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    if (wasFocused) {
      if (neighbor) openSession(neighbor.file, neighbor.sessionId);
      else unfocus();
    }
  };

  // A session created from a "+" card auto-opens the instant its transcript
  // shows up: it goes into the explicitly-opened set (so it appears in the
  // focus strip immediately) and becomes the focused session, so you land in
  // it instead of hunting for it on the canvas. See detectNewlySpawned in
  // api.ts. openSession is a no-op for openedAt if you'd already opened it.
  useEffect(() => {
    if (!justSpawned.length) return;
    for (const s of justSpawned) openSession(s.file, s.sessionId);
    consumeSpawned();
  }, [justSpawned, consumeSpawned]);

  const latest = snap ? snap.agents.reduce((mx, a) => Math.max(mx, a.lastActivity), 0) : 0;
  const cutoff = latest - windowH * 3_600_000;
  const allVisible = snap ? snap.agents.filter((a) => a.lastActivity >= cutoff) : [];
  const shownVisible = allVisible.filter((a) => !hidden[a.sessionId]);
  const hiddenVisible = allVisible.filter((a) => hidden[a.sessionId]);
  const groups = groupByProduct(shownVisible);
  // Same shared order the canvas lanes render in — Alt+N jumps to the Nth
  // card there. The focus-mode top strip has its OWN order now (see
  // openedAgents below) since it only shows explicitly-opened sessions.
  const flatOrder = groups.flatMap(([, ags]) => ags);
  // The focus-mode strip: every session you explicitly opened (across the full
  // snapshot, not just shownVisible — an opened session stays listed even past
  // the active-window cutoff), minus any you've hidden, plus always the session
  // you're currently viewing (so the card you're looking at never vanishes from
  // its own strip even if its openedAt entry is missing). Hiding is
  // authoritative: a hidden session leaves the strip too, so it stops taking a
  // slot and can't be reached by the number-jump.
  const openedAgents = snap ? stripAgents(snap.agents, openedAt, hidden, focusedId) : [];
  const stripState: StripState = { openedAt, productOrder, sessionOrder };
  // The strip in its rendered order — the list the number-jump walks in focus
  // mode, so "the Nth session" matches what you see there (the canvas uses
  // flatOrder instead). Follows the manual drag order.
  const openedOrder = stripOrder(openedAgents, stripState);

  // Drag-and-drop reorder: materialize the current effective order (manual +
  // open-time fallback), move the dragged item before the target, and persist.
  const reorderProduct = (dragged: string, target: string) => {
    const effective = groupStrip(openedAgents, stripState).map(([p]) => p);
    setProductOrder(reorder(effective, dragged, target));
  };
  const reorderSession = (product: string, dragged: string, target: string) => {
    const group = groupStrip(openedAgents, stripState).find(([p]) => p === product);
    const ids = group ? group[1].map((a) => a.sessionId) : [];
    setSessionOrder((prev) => ({ ...prev, [product]: reorder(ids, dragged, target) }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      const n = Number(e.key);
      if (n < 1 || n > 9) return;
      // Walk the list you're actually looking at: the strip in focus mode, the
      // canvas otherwise. Both exclude hidden sessions, so a hidden or closed
      // session is never number-reachable and can't pop back into the strip.
      const list = focusedId ? openedOrder : flatOrder;
      const target = list[n - 1];
      if (!target) return;
      e.preventDefault();
      openSession(target.file, target.sessionId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flatOrder, openedOrder, focusedId, openSession]);

  const banner = !connected && <ConnectionBanner everConnected={everConnectedRef.current} />;

  if (!snap) {
    return (
      <div className="shell">
        {banner}
        <div className="empty">{connected ? 'No sessions found.' : 'Connecting to Shepherd daemon…'}</div>
      </div>
    );
  }

  const focused = focusedId ? (snap.agents.find((a) => a.sessionId === focusedId) ?? null) : null;

  if (focused) {
    return (
      <div className="focus-shell">
        {banner}
        <FocusView
          agents={openedAgents}
          focused={focused}
          now={now}
          colorOf={colorOf}
          nameOf={nameOf}
          onSelect={(a) => openSession(a.file, a.sessionId)}
          onExit={unfocus}
          onRename={rename}
          fontSize={fontSize}
          onFontSize={changeFont}
          onHide={closeOpened}
          onSpawn={spawn}
          spawningProducts={spawningProducts}
          stripState={stripState}
          onReorderProduct={reorderProduct}
          onReorderSession={reorderSession}
          activeSubagents={activeSubagents}
          onSelectSubagent={(s) => openSubagent(focused.file, focused.sessionId, s.agentId, s.description)}
          onCloseSubagent={closeSubagent}
          subagentModal={subagentModal}
          subscribeTerminal={subscribeTerminal}
          termResetKey={termResetKey}
          termError={termError}
          onAttachTerminal={attachTerminal}
          onDetachTerminal={detachTerminal}
          onResizeTerm={resizeTerm}
          onSendTerminalKey={sendTerminalKey}
          limits={limits}
        />
      </div>
    );
  }

  const needsYou = shownVisible.filter((a) => a.state === 'needs-you').length;
  const working = shownVisible.filter((a) => a.state === 'working').length;
  const errored = shownVisible.filter((a) => a.state === 'error').length;

  return (
    <div className="shell">
      {banner}
      <header className="topbar">
        <span className="brand">🐑 Shepherd</span>
        <span className="counts">
          {shownVisible.length} agents · <b className="c-work">{working} working</b>
          {needsYou > 0 && (
            <>
              {' · '}
              <b className="c-need">{needsYou} need you</b>
            </>
          )}
          {errored > 0 && (
            <>
              {' · '}
              <b className="c-error">{errored} errored</b>
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
        <button className="new-project-btn" onClick={() => setNewProjectOpen(true)} title="Start a session in a new project directory">
          + new project
        </button>
        <button className="mute-toggle" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute sounds' : 'Mute sounds'}>
          {muted ? '🔕' : '🔔'}
        </button>
        <LimitsTracker limits={limits} />
        {hiddenVisible.length > 0 && (
          <button className="hidden-toggle" onClick={() => setShowHidden((s) => !s)}>
            {hiddenVisible.length} hidden {showHidden ? '▴' : '▾'}
          </button>
        )}
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
            onSelect={(a) => openSession(a.file, a.sessionId)}
            nameOf={nameOf}
            onHide={hide}
            onSpawn={spawn}
            spawningProducts={spawningProducts}
          />
        ))}

        {showHidden && hiddenVisible.length > 0 && (
          <div className="hidden-tray">
            <div className="hidden-tray__title">Hidden — click to restore</div>
            <div className="hidden-tray__list">
              {hiddenVisible.map((a) => (
                <button key={a.sessionId} className="hidden-chip" onClick={() => restore(a.sessionId)}>
                  <span className="hidden-chip__dot" style={{ background: colorOf(a.product) }} />
                  <span className="hidden-chip__name" title={nameOf(a)}>
                    {nameOf(a)}
                  </span>
                  <span className="hidden-chip__restore">↺ restore</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      {newProjectOpen && (
        <NewProjectModal
          dirListing={dirListing}
          dirListingError={dirListingError}
          onListDir={listDir}
          onSpawn={spawn}
          onClose={() => setNewProjectOpen(false)}
          agents={snap.agents}
          spawnErrors={spawnErrors}
          onFocus={(file, sessionId) => {
            setNewProjectOpen(false);
            openSession(file, sessionId);
          }}
        />
      )}
    </div>
  );
}

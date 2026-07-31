import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentModel, ChatMsg, Limits, SubagentInfo } from '../types';
import { CardStrip } from './CardStrip';
import type { StripState } from '../lib/order';
import { TerminalView } from './TerminalView';
import { AskdiffView } from './AskdiffView';
import { localImageUrl } from '../api';
import { NewProjectButton } from './NewProjectButton';
import { SubagentModal } from './SubagentModal';
import { LimitsTracker } from './LimitsTracker';

export function FocusView({
  agents,
  focused,
  now,
  colorOf,
  nameOf,
  onSelect,
  onExit,
  onRename,
  fontSize,
  onFontSize,
  onHide,
  onSpawn,
  spawningProducts,
  stripState,
  onReorderProduct,
  onReorderSession,
  onNewProject,
  activeSubagents,
  onSelectSubagent,
  onCloseSubagent,
  subagentModal,
  termResetKey,
  termError,
  linesChanged,
  askdiffState,
  onAttachTerminal,
  onDetachTerminal,
  onResizeTerm,
  onSendTerminalKey,
  subscribeTerminal,
  limits,
}: {
  agents: AgentModel[];
  focused: AgentModel;
  now: number;
  colorOf: (product: string) => string;
  nameOf: (a: AgentModel) => string;
  onSelect: (a: AgentModel) => void;
  onExit: () => void;
  onRename: (sessionId: string, name: string) => void;
  fontSize: number;
  onFontSize: (delta: number) => void;
  onHide: (sessionId: string) => void;
  onSpawn: (product: string) => void;
  spawningProducts: Set<string>;
  stripState: StripState;
  onReorderProduct: (dragged: string, target: string) => void;
  onReorderSession: (product: string, dragged: string, target: string) => void;
  onNewProject: () => void;
  activeSubagents: SubagentInfo[];
  onSelectSubagent: (s: SubagentInfo) => void;
  onCloseSubagent: () => void;
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  termResetKey: string;
  termError: string | null;
  linesChanged: { added: number; removed: number } | null;
  askdiffState: Map<string, { port: number | null; error: string | null }>;
  onAttachTerminal: (sessionId: string, cwd: string, cols: number, rows: number) => void;
  onDetachTerminal: (sessionId: string) => void;
  onResizeTerm: (sessionId: string, cols: number, rows: number) => void;
  onSendTerminalKey: (sessionId: string, cwd: string, key: string) => void;
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
  limits: Limits | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const name = nameOf(focused);
  const focusRootRef = useRef<HTMLDivElement>(null);

  // Sessions whose askdiff iframe this FocusView instance is keeping warm —
  // each stays mounted (just hidden) once added, so its in-memory Q&A store
  // survives closing the panel and flipping between session cards, rather
  // than being torn down and rebuilt from scratch every time (see
  // AskdiffView's doc comment for why that history has nowhere else to
  // live). Grows lazily: only when the panel is actually opened for a
  // session, not on every focus (the backend pre-warms an instance on every
  // focus regardless, but there's no reason to also carry an idle iframe +
  // WS connection for a session whose diff view was never looked at).
  // Capped to mirror the daemon's own MAX_CONCURRENT_INSTANCES — no point
  // keeping more browser-side iframes warm than the backend could
  // concurrently back anyway; evicting one just means that one session's
  // panel goes back to a fresh "Starting diff view…" next time, same as
  // today's behavior for every session.
  const ASKDIFF_POOL_CAP = 4;
  const [askdiffPool, setAskdiffPool] = useState<Map<string, number>>(() => new Map());
  useEffect(() => {
    if (!showDiff) return;
    setAskdiffPool((prev) => {
      const next = new Map(prev);
      next.set(focused.sessionId, Date.now());
      if (next.size > ASKDIFF_POOL_CAP) {
        let evictId: string | null = null;
        let evictAt = Infinity;
        for (const [sid, at] of next) {
          if (sid === focused.sessionId) continue;
          if (at < evictAt) {
            evictAt = at;
            evictId = sid;
          }
        }
        if (evictId) next.delete(evictId);
      }
      return next;
    });
  }, [showDiff, focused.sessionId]);

  // Always land back on the terminal when switching sessions — whether the
  // diff panel happens to be open is UI state, not something that should
  // follow you to a different card (the Q&A *history* underneath it does
  // persist per-session via the pool above; this is only about which panel
  // is showing). `useLayoutEffect`, not `useEffect`: a passive effect would
  // run after the switch's own commit already painted, showing one visible
  // frame with the new session's `focused.sessionId` but the old
  // `showDiff`/pool state (either the wrong-looking "diff view followed
  // you" flash, or a blank slot if the new session has no pool entry yet).
  // The layout-effect timing (synchronous, pre-paint) closes that gap.
  useLayoutEffect(() => {
    setShowDiff(false);
  }, [focused.sessionId]);

  // Detach on unmount / session switch / opening the diff view (which takes
  // over the terminal's own slot in focus__main below). Attach is driven by
  // TerminalView instead (via onAttach below): it must happen only once the
  // terminal has mounted and measured its own size, so the attach can carry
  // that size and the server can serialize a width-matched snapshot. The
  // PTY itself keeps running either way (see sender.ts's idle-eviction) —
  // this only stops/starts streaming to us. The detach callback is captured
  // in a ref so this effect's only real dependencies are which session is
  // focused and whether the diff view is showing, not the callback's own
  // (recreated-every-render) identity.
  const detachRef = useRef(onDetachTerminal);
  detachRef.current = onDetachTerminal;
  useEffect(() => {
    if (showDiff) return;
    return () => detachRef.current(focused.sessionId);
  }, [focused.sessionId, showDiff]);

  // The terminal now owns keyboard input natively (see TerminalView) and
  // focuses itself, so there's no composer focus to reclaim. Esc goes
  // straight to the pty via the terminal — except when the subagent modal
  // or the diff view is open, when it should close that instead (modal
  // takes priority since it can only ever be open together with the diff
  // view by direct user action, and closing the more recently opened thing
  // first is the least surprising order). The terminal is blurred while
  // either is open (TerminalView's `active` prop), so Esc here won't also
  // reach the pty.
  useEffect(() => {
    if (!subagentModal && !showDiff) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (subagentModal) onCloseSubagent();
      else setShowDiff(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subagentModal, showDiff, onCloseSubagent]);

  const startEdit = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    onRename(focused.sessionId, draft.trim());
    setEditing(false);
  };

  return (
    <div className="focus" ref={focusRootRef}>
      <CardStrip
        agents={agents}
        focusedId={focused.sessionId}
        now={now}
        colorOf={colorOf}
        onSelect={onSelect}
        nameOf={nameOf}
        onHide={onHide}
        onSpawn={onSpawn}
        spawningProducts={spawningProducts}
        stripState={stripState}
        onReorderProduct={onReorderProduct}
        onReorderSession={onReorderSession}
      />

      <div className="focus__main">
        <div className="focus__bar">
          <button className="focus__back" onClick={onExit} title="Back to canvas (Esc)">
            ⌂ canvas
          </button>
          <span className="focus__crumb">
            <span style={{ color: colorOf(focused.product) }}>{focused.product}</span>
            <span className="focus__sep">/</span>
            {editing ? (
              <input
                className="focus__rename"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit();
                  if (e.key === 'Escape') setEditing(false);
                }}
              />
            ) : (
              <>
                <b title={name} onDoubleClick={startEdit}>
                  {name}
                </b>
                <button className="focus__edit" onClick={startEdit} title="Rename session">
                  ✎
                </button>
              </>
            )}
          </span>
          <span className="focus__tools">
            <NewProjectButton onClick={onNewProject} />
            {linesChanged && (linesChanged.added > 0 || linesChanged.removed > 0) && (
              <button
                className="lines-changed"
                onClick={() => setShowDiff(true)}
                title="Review working-tree changes"
              >
                <span className="lines-changed__added">+{linesChanged.added}</span>
                <span className="lines-changed__removed">-{linesChanged.removed}</span>
              </button>
            )}
            <LimitsTracker limits={limits} />
            <span className="fontctl" title="Terminal font size">
              <button onClick={() => onFontSize(-1)}>A−</button>
              <button onClick={() => onFontSize(1)}>A+</button>
            </span>
          </span>
        </div>

        {termError && <div className="term-error">⚠ {termError}</div>}

        {showDiff && (
          <div className="askdiff-bar">
            <span>Reviewing working-tree changes</span>
            <button onClick={() => setShowDiff(false)}>← Back to terminal (Esc)</button>
          </div>
        )}
        {/* `display: contents` so each pooled session's .askdiff-view becomes
            a direct flex item of .focus__main, exactly like the single
            AskdiffView this replaces — only one is ever visible (CSS, not
            mount state) at a time. */}
        <div style={{ display: 'contents' }}>
          {[...askdiffPool.keys()].map((sessionId) => {
            const state = askdiffState.get(sessionId) ?? { port: null, error: null };
            return (
              <AskdiffView
                key={sessionId}
                visible={showDiff && sessionId === focused.sessionId}
                port={state.port}
                error={state.error}
                onEscape={() => setShowDiff(false)}
              />
            );
          })}
        </div>
        {!showDiff && (
          <TerminalView
            resetKey={termResetKey}
            subscribeTerminal={subscribeTerminal}
            fontSize={fontSize}
            onAttach={(cols, rows) => onAttachTerminal(focused.sessionId, focused.cwd, cols, rows)}
            onResize={(cols, rows) => onResizeTerm(focused.sessionId, cols, rows)}
            onInput={(data) => onSendTerminalKey(focused.sessionId, focused.cwd, data)}
            active={!subagentModal}
            resolveImageSrc={(p) => localImageUrl(focused.cwd, p)}
          />
        )}
      </div>

      {subagentModal && (
        <SubagentModal description={subagentModal.description} messages={subagentModal.messages} onClose={onCloseSubagent} />
      )}
    </div>
  );
}

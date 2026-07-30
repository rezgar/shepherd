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
  askdiffPort,
  askdiffError,
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
  askdiffPort: number | null;
  askdiffError: string | null;
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

  // Always land back on the terminal when switching sessions — the diff
  // view is per-session state, not something that should follow you to a
  // different card. `useLayoutEffect`, not `useEffect`: api.ts's focus()
  // resets linesChanged/askdiffPort/askdiffError to null in the SAME
  // commit as the session switch, but this reset lives here, in a
  // different component's effect — a passive `useEffect` would run after
  // that commit already painted, showing one visible frame of
  // `<AskdiffView port={null} error={null}>` ("Starting diff view…") for
  // the newly-focused session before flipping back to the terminal. The
  // layout-effect timing (synchronous, pre-paint) closes that gap.
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

        {showDiff ? (
          <>
            <div className="askdiff-bar">
              <span>Reviewing working-tree changes</span>
              <button onClick={() => setShowDiff(false)}>← Back to terminal (Esc)</button>
            </div>
            <AskdiffView port={askdiffPort} error={askdiffError} onEscape={() => setShowDiff(false)} />
          </>
        ) : (
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

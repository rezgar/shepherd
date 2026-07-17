import { useEffect, useRef, useState } from 'react';
import type { AgentModel, ChatMsg, Limits, SubagentInfo } from '../types';
import { CardStrip } from './CardStrip';
import { TerminalView } from './TerminalView';
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
  activeSubagents,
  onSelectSubagent,
  onCloseSubagent,
  subagentModal,
  termResetKey,
  termError,
  onAttachTerminal,
  onDetachTerminal,
  onResizeTerm,
  onSendTerminalKey,
  subscribeTerminal,
  openedAt,
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
  activeSubagents: SubagentInfo[];
  onSelectSubagent: (s: SubagentInfo) => void;
  onCloseSubagent: () => void;
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  termResetKey: string;
  termError: string | null;
  onAttachTerminal: (sessionId: string, cwd: string) => void;
  onDetachTerminal: (sessionId: string) => void;
  onResizeTerm: (sessionId: string, cols: number, rows: number) => void;
  onSendTerminalKey: (sessionId: string, cwd: string, key: string) => void;
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
  openedAt: Record<string, number>;
  limits: Limits | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = nameOf(focused);
  const focusRootRef = useRef<HTMLDivElement>(null);

  // Attach on mount / whenever the focused session changes; detach on
  // unmount / session switch. The PTY itself keeps running either way (see
  // sender.ts's idle-eviction) — this only stops/starts streaming to us.
  // The attach/detach callbacks are captured in a ref so this effect's only
  // real dependency is which session is focused, not the callbacks' own
  // (recreated-every-render) identity.
  const attachRef = useRef({ onAttachTerminal, onDetachTerminal });
  attachRef.current = { onAttachTerminal, onDetachTerminal };
  useEffect(() => {
    attachRef.current.onAttachTerminal(focused.sessionId, focused.cwd);
    return () => attachRef.current.onDetachTerminal(focused.sessionId);
  }, [focused.sessionId, focused.cwd]);

  // The terminal now owns keyboard input natively (see TerminalView) and
  // focuses itself, so there's no composer focus to reclaim. Esc goes straight
  // to the pty via the terminal — except when the subagent modal is open, when
  // it should close the modal instead. The terminal is blurred while the modal
  // is open (TerminalView's `active` prop), so Esc here won't also reach the pty.
  useEffect(() => {
    if (!subagentModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onCloseSubagent();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [subagentModal, onCloseSubagent]);

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
        openedAt={openedAt}
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
            <LimitsTracker limits={limits} />
            <span className="fontctl" title="Terminal font size">
              <button onClick={() => onFontSize(-1)}>A−</button>
              <button onClick={() => onFontSize(1)}>A+</button>
            </span>
          </span>
        </div>

        {termError && <div className="term-error">⚠ {termError}</div>}

        <TerminalView
          resetKey={termResetKey}
          subscribeTerminal={subscribeTerminal}
          fontSize={fontSize}
          onResize={(cols, rows) => onResizeTerm(focused.sessionId, cols, rows)}
          onInput={(data) => onSendTerminalKey(focused.sessionId, focused.cwd, data)}
          active={!subagentModal}
        />
      </div>

      {subagentModal && (
        <SubagentModal description={subagentModal.description} messages={subagentModal.messages} onClose={onCloseSubagent} />
      )}
    </div>
  );
}

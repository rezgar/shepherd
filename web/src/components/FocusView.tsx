import { useEffect, useRef, useState } from 'react';
import type { AgentModel, ChatMsg, SubagentInfo } from '../types';
import { CardStrip } from './CardStrip';
import { TerminalView } from './TerminalView';
import { TermComposer } from './TermComposer';
import { SubagentModal } from './SubagentModal';

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
  onSendTermInput,
  onResizeTerm,
  onSendTerminalKey,
  subscribeTerminal,
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
  onSendTermInput: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  onResizeTerm: (sessionId: string, cols: number, rows: number) => void;
  onSendTerminalKey: (sessionId: string, cwd: string, key: string) => void;
  subscribeTerminal: (onChunk: (chunk: string) => void) => () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = nameOf(focused);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
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

  // The composer should hold focus by default — you can always just start
  // typing — except while you're genuinely doing something else with the
  // mouse: selecting text to copy (including from the terminal output, which
  // is real selectable text), or typing into another real text field (the
  // rename box). A click that lands on neither reclaims focus right after,
  // e.g. clicking the font-size controls — this is the same behavior the
  // chat-based UI had; it quietly dropped out when this component was
  // rewritten for the terminal view and nothing else ever restored it.
  useEffect(() => {
    if (subagentModal) return;
    const isTextEntry = (el: Element | null) =>
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
    const reclaim = () => {
      if (isTextEntry(document.activeElement)) return;
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      composerInputRef.current?.focus();
    };
    const root = focusRootRef.current;
    root?.addEventListener('mouseup', reclaim);
    // Also release focus on window blur so keystrokes after an OS-level tab
    // switch don't land in an already-focused composer unintentionally
    // (confirmed the hard way earlier: alt-tabbing back and typing sent an
    // unintended message because DOM focus survives an OS-level switch).
    const releaseOnBlur = () => {
      if (document.activeElement === composerInputRef.current) composerInputRef.current?.blur();
    };
    window.addEventListener('blur', releaseOnBlur);
    return () => {
      root?.removeEventListener('mouseup', reclaim);
      window.removeEventListener('blur', releaseOnBlur);
    };
  }, [subagentModal]);

  // Esc closes the subagent modal if one's open; otherwise it interrupts
  // whatever the session is doing, exactly like pressing it in a real
  // terminal — this has nowhere else to go now that the terminal view is
  // output-only (it never wires xterm's own keyboard capture, see
  // TerminalView), so without this Escape had no path to the pty at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing) return;
      e.preventDefault();
      if (subagentModal) onCloseSubagent();
      else onSendTerminalKey(focused.sessionId, focused.cwd, '\x1b');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, subagentModal, onCloseSubagent, onSendTerminalKey, focused.sessionId, focused.cwd]);

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
        />

        <TermComposer
          onSend={(text, images) => onSendTermInput(focused.sessionId, focused.cwd, text, images)}
          inputRef={composerInputRef}
        />
      </div>

      {subagentModal && (
        <SubagentModal description={subagentModal.description} messages={subagentModal.messages} onClose={onCloseSubagent} />
      )}
    </div>
  );
}

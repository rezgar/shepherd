import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentModel, ChatMsg, SubagentInfo } from '../types';
import type { QueuedDraft } from '../api';
import { CardStrip } from './CardStrip';
import { ChatTranscript } from './ChatTranscript';
import { Composer, type ComposerDraft } from './Composer';
import { QueuedMessage } from './QueuedMessage';
import { WorkingIndicator } from './WorkingIndicator';
import { SubagentModal } from './SubagentModal';

export function FocusView({
  agents,
  focused,
  messages,
  hasMore,
  onLoadMore,
  now,
  colorOf,
  nameOf,
  onSelect,
  onExit,
  onRename,
  fontSize,
  onFontSize,
  onSend,
  sending,
  sendingSince,
  onCancel,
  onHide,
  onSpawn,
  spawningProducts,
  queued,
  onQueueSend,
  onDequeueSend,
  onForceSendQueued,
  activeSubagents,
  onSelectSubagent,
  onCloseSubagent,
  subagentModal,
  liveElsewhereWarning,
  onDismissLiveElsewhereWarning,
}: {
  agents: AgentModel[];
  focused: AgentModel;
  messages: ChatMsg[] | null;
  hasMore: boolean;
  onLoadMore: () => void;
  now: number;
  colorOf: (product: string) => string;
  nameOf: (a: AgentModel) => string;
  onSelect: (a: AgentModel) => void;
  onExit: () => void;
  onRename: (sessionId: string, name: string) => void;
  fontSize: number;
  onFontSize: (delta: number) => void;
  onSend: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  sending: boolean;
  /** Date.now() when the current in-flight send started — undefined if none. */
  sendingSince: number | undefined;
  onCancel: (sessionId: string) => void;
  onHide: (sessionId: string) => void;
  onSpawn: (product: string) => void;
  spawningProducts: Set<string>;
  /** This session's held-back drafts, oldest first, if the composer queued any because it was busy. */
  queued: QueuedDraft[];
  onQueueSend: (sessionId: string, cwd: string, text: string, images?: string[]) => void;
  onDequeueSend: (sessionId: string, index: number) => void;
  onForceSendQueued: (sessionId: string, cwd: string) => void;
  activeSubagents: SubagentInfo[];
  onSelectSubagent: (s: SubagentInfo) => void;
  onCloseSubagent: () => void;
  subagentModal: { agentId: string; description: string; messages: ChatMsg[] | null } | null;
  /** True when this session's most recent send went out while another
   *  interactive process (a real terminal, or another relay) already had it
   *  open — the message still sent, but output may be interleaved. */
  liveElsewhereWarning: boolean;
  onDismissLiveElsewhereWarning: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = nameOf(focused);

  // The composer should hold focus by default — you can always just start
  // typing — except while you're genuinely doing something else with the
  // mouse: selecting text to copy, or typing into another real text field
  // (the rename box, a question's comment box). A click that lands on
  // neither reclaims focus right after, e.g. clicking a question's option
  // button or the font-size controls.
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusRootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (subagentModal) return; // read-only overlay — let it keep whatever focus/selection it has
    const isTextEntry = (el: Element | null) =>
      !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
    const reclaim = () => {
      if (isTextEntry(document.activeElement)) return;
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      composerInputRef.current?.focus();
    };
    const root = focusRootRef.current;
    root?.addEventListener('mouseup', reclaim);
    // DOM focus and OS window focus are independent — leaving the composer
    // focused across an OS-level tab/window switch means keystrokes typed
    // right after alt-tabbing back (meant for whatever the user THINKS is
    // focused) land silently in this session's composer instead, and Enter
    // sends them with zero confirmation (confirmed the hard way: a message
    // never consciously composed landed in a live session this exact way).
    // Blurring on window blur means a return trip always needs a real click
    // first — the auto-focus convenience still holds for as long as you're
    // actually in this tab, just not across a trip away from it.
    const releaseOnBlur = () => {
      if (document.activeElement === composerInputRef.current) composerInputRef.current?.blur();
    };
    window.addEventListener('blur', releaseOnBlur);
    return () => {
      root?.removeEventListener('mouseup', reclaim);
      window.removeEventListener('blur', releaseOnBlur);
    };
  }, [subagentModal]);

  // A send that's been in flight a while with nothing else on screen reads as
  // broken even when it's perfectly normal (a genuinely long turn) — there's
  // no way to tell the two apart from here, so this doesn't claim failure,
  // it just stops leaving you with literally nothing: elapsed time plus a
  // safe way out (Stop preserves what you typed — see cancel() in api.ts).
  // Dismissal is keyed to `sendingSince` itself so dismissing this one stall
  // doesn't suppress the banner for a later, unrelated send.
  const STALL_MS = 30_000;
  const [dismissedStallFor, setDismissedStallFor] = useState<number | null>(null);
  const stalledSinceMs = sending && sendingSince ? now - sendingSince : 0;
  const stalled = stalledSinceMs >= STALL_MS && dismissedStallFor !== sendingSince;

  // Per-session composer drafts, kept across session switches (the Composer is
  // keyed by sessionId, so it remounts on switch and reads its session's draft).
  const composerDrafts = useRef<Map<string, ComposerDraft>>(new Map());
  const saveDraft = useCallback(
    (d: ComposerDraft) => {
      if (d.text || d.images.length) composerDrafts.current.set(focused.sessionId, d);
      else composerDrafts.current.delete(focused.sessionId);
    },
    [focused.sessionId],
  );

  // Bumped to force the Composer to remount (and re-read composerDrafts) when
  // a queued message is pulled back in for editing — it isn't a controlled
  // input, so there's no other way to push new text into an already-mounted one.
  const [reloadTick, setReloadTick] = useState(0);

  // The session was busy when you hit send — hold the message instead of
  // racing a --resume against whatever's already running. Answering a
  // question goes through the same gate (rare in practice, since a question
  // usually means the agent is waiting on you, not working).
  // Queue instead of sending immediately whenever the daemon's own state
  // says the session is busy, OR when Shepherd already has a send of ours
  // in flight for it (`sending`) — the latter matters even when `state`
  // hasn't caught up yet: two concurrent WS `send`s for the same session
  // would both try to type into its one persistent PTY at once, interleaving
  // keystrokes. Queueing is always safe either way — it never touches the
  // wire until this one resolves.
  const dispatch = useCallback(
    (text: string, images?: string[]) => {
      if (focused.state === 'working' || sending) onQueueSend(focused.sessionId, focused.cwd, text, images);
      else onSend(focused.sessionId, focused.cwd, text, images);
    },
    [focused.state, sending, focused.sessionId, focused.cwd, onQueueSend, onSend],
  );

  const editQueued = useCallback(
    (index: number) => {
      const draft = queued[index];
      if (!draft) return;
      composerDrafts.current.set(focused.sessionId, {
        text: draft.text,
        images: draft.images.map((dataUrl, i) => ({ id: `queued-${i}`, dataUrl })),
      });
      onDequeueSend(focused.sessionId, index);
      setReloadTick((t) => t + 1);
    },
    [queued, focused.sessionId, onDequeueSend],
  );
  // ↑ in an empty composer edits the most recently queued draft — the one
  // you likely just typed and might want to tweak — leaving earlier ones
  // queued ahead of it.
  const editLastQueued = useCallback(() => editQueued(queued.length - 1), [editQueued, queued.length]);

  // Esc is reserved for stopping things (a subagent modal, an in-flight
  // Shepherd-relayed reply) — it never navigates back to canvas. That's what
  // the explicit "⌂ canvas" button is for; getting bounced out mid-read by a
  // stray Esc (or one that turned out not to be stoppable) is disruptive.
  // With something queued, Esc means "don't wait — stop this (if possible)
  // and send the next one now" rather than just stopping.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || editing) return;
      if (subagentModal) {
        e.preventDefault();
        onCloseSubagent();
      } else if (queued.length > 0) {
        e.preventDefault();
        onForceSendQueued(focused.sessionId, focused.cwd);
      } else if (sending) {
        e.preventDefault();
        onCancel(focused.sessionId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, onCloseSubagent, onForceSendQueued, editing, sending, queued.length, subagentModal, focused.sessionId, focused.cwd]);

  const lastUser = messages?.filter((m) => m.role === 'user').at(-1)?.text ?? null;

  const startEdit = () => {
    setDraft(name);
    setEditing(true);
  };
  const commit = () => {
    onRename(focused.sessionId, draft.trim());
    setEditing(false);
  };

  return (
    <div className="focus" ref={focusRootRef} style={{ ['--chat-font' as never]: `${fontSize}px` }}>
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
          <span className="fontctl" title="Chat font size">
            <button onClick={() => onFontSize(-1)}>A−</button>
            <button onClick={() => onFontSize(1)}>A+</button>
          </span>
          {sending && <span className="focus__hint">Esc = stop</span>}
        </span>
      </div>

      {liveElsewhereWarning && (
        <div className="live-elsewhere-warning">
          <span>⚠ Last message was sent while this session was also open in another window — output may be interleaved.</span>
          <button onClick={onDismissLiveElsewhereWarning} title="Dismiss">
            ×
          </button>
        </div>
      )}

      {stalled && (
        <div className="stall-warning">
          <span>
            ⏳ Still waiting on a response — {Math.round(stalledSinceMs / 1000)}s with no confirmation yet. The agent may
            just be mid-task, or something could be stuck.
          </span>
          <span className="stall-warning__actions">
            <button onClick={() => onCancel(focused.sessionId)} title="Interrupt it — what you typed is kept as a draft">
              Stop &amp; keep as draft
            </button>
            <button onClick={() => setDismissedStallFor(sendingSince ?? null)} title="Dismiss">
              Keep waiting
            </button>
          </span>
        </div>
      )}

      <ChatTranscript
        key={`chat-${focused.sessionId}`}
        messages={messages}
        hasMore={hasMore}
        onLoadMore={onLoadMore}
        onAnswer={dispatch}
      />

      {(focused.state === 'working' || activeSubagents.length > 0) && (
        <WorkingIndicator
          status={focused.state === 'working' ? focused.activity || focused.status : undefined}
          taskLine={focused.state === 'working' ? focused.taskLine : undefined}
          subagents={activeSubagents}
          onSelectSubagent={(s) => onSelectSubagent(s)}
        />
      )}

      {queued.map((draft, i) => (
        <QueuedMessage
          key={`${focused.sessionId}-${i}-${draft.text}`}
          text={draft.text}
          images={draft.images}
          blocked={i === 0 && draft.blocked}
          blockReason={i === 0 ? draft.blockReason : undefined}
          onEdit={() => editQueued(i)}
          onDelete={() => onDequeueSend(focused.sessionId, i)}
          onRetry={i === 0 ? () => onForceSendQueued(focused.sessionId, focused.cwd) : undefined}
        />
      ))}

      <Composer
        key={`composer-${focused.sessionId}-${reloadTick}`}
        initialDraft={composerDrafts.current.get(focused.sessionId)}
        onDraftChange={saveDraft}
        lastUserMessage={lastUser}
        onSend={dispatch}
        sending={sending}
        onCancel={() => onCancel(focused.sessionId)}
        hasQueued={queued.length > 0}
        onEditQueued={editLastQueued}
        onForceSendQueued={() => onForceSendQueued(focused.sessionId, focused.cwd)}
        inputRef={composerInputRef}
      />
      </div>

      {subagentModal && (
        <SubagentModal description={subagentModal.description} messages={subagentModal.messages} onClose={onCloseSubagent} />
      )}
    </div>
  );
}

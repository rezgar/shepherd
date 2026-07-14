import { useEffect, useState } from 'react';
import type { AgentModel, ChatMsg } from '../types';
import { CardStrip } from './CardStrip';
import { ChatTranscript } from './ChatTranscript';
import { Composer } from './Composer';

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
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const name = nameOf(focused);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit, editing]);

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
    <div className="focus" style={{ ['--chat-font' as never]: `${fontSize}px` }}>
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
          <span className="focus__hint">Esc = canvas</span>
        </span>
      </div>

      <CardStrip
        agents={agents}
        focusedId={focused.sessionId}
        now={now}
        colorOf={colorOf}
        onSelect={onSelect}
        nameOf={nameOf}
      />

      <ChatTranscript key={focused.sessionId} messages={messages} hasMore={hasMore} onLoadMore={onLoadMore} />

      <Composer lastUserMessage={lastUser} />
    </div>
  );
}

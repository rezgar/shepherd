import { useEffect } from 'react';
import type { AgentModel, Transcript } from '../types';
import { CardStrip } from './CardStrip';
import { ChatTranscript } from './ChatTranscript';
import { Composer } from './Composer';

export function FocusView({
  agents,
  focused,
  transcript,
  now,
  colorOf,
  onSelect,
  onExit,
}: {
  agents: AgentModel[];
  focused: AgentModel;
  transcript: Transcript | null;
  now: number;
  colorOf: (product: string) => string;
  onSelect: (a: AgentModel) => void;
  onExit: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  const lastUser = transcript?.messages.filter((m) => m.role === 'user').at(-1)?.text ?? null;

  return (
    <div className="focus">
      <div className="focus__bar">
        <button className="focus__back" onClick={onExit} title="Back to canvas (Esc)">
          ⌂ canvas
        </button>
        <span className="focus__crumb">
          <span style={{ color: colorOf(focused.product) }}>{focused.product}</span>
          <span className="focus__sep">/</span>
          <b title={focused.name}>{focused.name}</b>
        </span>
        <span className="focus__hint">Esc = canvas</span>
      </div>

      <CardStrip
        agents={agents}
        focusedId={focused.sessionId}
        now={now}
        colorOf={colorOf}
        onSelect={onSelect}
      />

      <ChatTranscript transcript={transcript} />

      <Composer lastUserMessage={lastUser} />
    </div>
  );
}

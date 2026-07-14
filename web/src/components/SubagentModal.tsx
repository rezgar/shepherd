import type { ChatMsg } from '../types';
import { ChatTranscript } from './ChatTranscript';

/** Read-only, auto-updating view of one subagent's own transcript — no
 *  composer, since you can't message a subagent directly, only the parent.
 *  Escape-to-close is owned by FocusView (it must take priority over the
 *  focus view's own Escape-to-exit/cancel while the modal is open). */
export function SubagentModal({
  description,
  messages,
  onClose,
}: {
  description: string;
  messages: ChatMsg[] | null;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <b>
            <span className="subagent-chip__glyph">✳</span> {description}
          </b>
          <button className="modal__close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="modal__body">
          {/* Read-only: you answer the parent session, never a subagent directly. */}
          <ChatTranscript messages={messages} hasMore={false} onLoadMore={() => {}} onAnswer={() => {}} answerable={false} />
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';

interface PastedImage {
  id: string;
  dataUrl: string;
}

export interface ComposerDraft {
  text: string;
  images: PastedImage[];
}

let pasteIdSeq = 0;

/** Message input. Enter sends, Shift+Enter newlines, ↑ recalls the last message,
 *  pasted images attach and are read by the agent from a temp file. While a
 *  reply is in flight the Send button becomes Stop.
 *
 *  Per-session drafts: the parent keys this component by session and hands it
 *  that session's saved draft; every edit is pushed back up via onDraftChange
 *  so switching away and back restores exactly what was typed (text + images). */
export function Composer({
  initialDraft,
  onDraftChange,
  lastUserMessage,
  onSend,
  sending,
  onCancel,
  hasQueued,
  onEditQueued,
  onForceSendQueued,
  inputRef,
}: {
  initialDraft: ComposerDraft | undefined;
  onDraftChange: (draft: ComposerDraft) => void;
  lastUserMessage: string | null;
  onSend: (text: string, images?: string[]) => void;
  sending: boolean;
  onCancel: () => void;
  /** True when this session already has a queued (unsent) draft — ↑ in an
   *  empty composer edits that instead of recalling the last sent message. */
  hasQueued: boolean;
  /** Pulls the queued draft back into the composer for editing (the parent
   *  owns the actual dequeue + remount, since this component never sees the
   *  queued text itself). */
  onEditQueued: () => void;
  /** Enter/Send with an empty composer while a message is queued: stop
   *  whatever's running (if Shepherd can) and send the next queued one now. */
  onForceSendQueued: () => void;
  /** Exposes the textarea node so the parent can reclaim focus for it (e.g.
   *  after a click elsewhere that isn't itself a text field). */
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState(initialDraft?.text ?? '');
  const [images, setImages] = useState<PastedImage[]>(initialDraft?.images ?? []);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // Mirror every edit up to the parent's per-session store so it survives a
  // session switch (which unmounts/remounts this via its key).
  useEffect(() => {
    onDraftChange({ text: value, images });
  }, [value, images, onDraftChange]);

  // Grows with newlines (Shift+Enter) up to 3 lines, then scrolls internally
  // rather than growing further — snaps back to 1 the moment it's cleared.
  const rows = Math.min(3, Math.max(1, value.split('\n').length));

  const submit = () => {
    const t = value.trim();
    if (!t && !images.length) {
      if (hasQueued) onForceSendQueued();
      return;
    }
    // No `sending` guard here — this always calls through to the parent's
    // dispatch, which is the single source of truth for queue-vs-send-now
    // (including treating an in-flight send as a reason to queue). A guard
    // here that just dropped the message on the floor while sending was
    // exactly why queuing looked broken: pressing Enter while busy did
    // nothing at all, not even queue it (confirmed the hard way).
    onSend(t, images.map((i) => i.dataUrl));
    setValue('');
    setImages([]);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items]
      .filter((it) => it.type.startsWith('image/'))
      .map((it) => it.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      const id = String(pasteIdSeq++);
      reader.onload = () => {
        if (typeof reader.result === 'string') setImages((imgs) => [...imgs, { id, dataUrl: reader.result as string }]);
      };
      reader.readAsDataURL(file);
    }
  };

  const removeImage = (id: string) => setImages((imgs) => imgs.filter((i) => i.id !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' && value.trim() === '' && hasQueued) {
      e.preventDefault();
      onEditQueued();
    } else if (e.key === 'ArrowUp' && value.trim() === '' && lastUserMessage) {
      e.preventDefault();
      setValue(lastUserMessage);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      });
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
    // Shift+Enter falls through to the default → newline
  };

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="composer__images">
          {images.map((img) => (
            <div className="composer__thumb" key={img.id}>
              <img src={img.dataUrl} alt="pasted" />
              <button className="composer__thumb-remove" onClick={() => removeImage(img.id)} title="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer__row">
        <textarea
          ref={(el) => {
            ref.current = el;
            if (inputRef) inputRef.current = el;
          }}
          className="composer__input"
          placeholder="Message this agent…   (Enter to send · Shift+Enter for newline · ↑ to edit last · paste an image to attach)"
          value={value}
          rows={rows}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        {sending ? (
          <button className="composer__send composer__send--stop" onClick={onCancel} title="Stop this reply (Esc)">
            Stop
          </button>
        ) : (
          <button
            className="composer__send composer__send--live"
            onClick={submit}
            disabled={!value.trim() && !images.length && !hasQueued}
            title={!value.trim() && !images.length && hasQueued ? 'Stop (if possible) and send the next queued message now' : undefined}
          >
            {!value.trim() && !images.length && hasQueued ? 'Send next' : 'Send'}
          </button>
        )}
      </div>
    </div>
  );
}

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
}: {
  initialDraft: ComposerDraft | undefined;
  onDraftChange: (draft: ComposerDraft) => void;
  lastUserMessage: string | null;
  onSend: (text: string, images?: string[]) => void;
  sending: boolean;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialDraft?.text ?? '');
  const [images, setImages] = useState<PastedImage[]>(initialDraft?.images ?? []);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Mirror every edit up to the parent's per-session store so it survives a
  // session switch (which unmounts/remounts this via its key).
  useEffect(() => {
    onDraftChange({ text: value, images });
  }, [value, images, onDraftChange]);

  const submit = () => {
    const t = value.trim();
    if ((!t && !images.length) || sending) return;
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
    if (e.key === 'ArrowUp' && value.trim() === '' && lastUserMessage) {
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
          ref={ref}
          className="composer__input"
          placeholder="Message this agent…   (Enter to send · Shift+Enter for newline · ↑ to edit last · paste an image to attach)"
          value={value}
          rows={1}
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
            disabled={!value.trim() && !images.length}
          >
            Send
          </button>
        )}
      </div>
    </div>
  );
}

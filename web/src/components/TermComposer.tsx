import { useRef, useState } from 'react';

let pasteIdSeq = 0;

/** Plain input box for a session's terminal — no sending/queued state at
 *  all, since the terminal view right above it is what shows whether
 *  anything happened. Enter submits (writes text + Enter to the pty via
 *  onSend); Shift+Enter inserts a newline. Paste-image keeps the existing
 *  save-to-temp-file + inject-a-note trick, since a real terminal has no
 *  native image paste. */
export function TermComposer({
  onSend,
  inputRef,
}: {
  onSend: (text: string, images?: string[]) => void;
  inputRef?: React.MutableRefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<{ id: string; dataUrl: string }[]>([]);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const rows = Math.min(3, Math.max(1, value.split('\n').length));

  const submit = () => {
    const t = value.trim();
    if (!t && !images.length) return;
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

  return (
    <div className="term-composer">
      {images.length > 0 && (
        <div className="term-composer__images">
          {images.map((img) => (
            <div className="term-composer__thumb" key={img.id}>
              <img src={img.dataUrl} alt="pasted" />
              <button className="term-composer__thumb-remove" onClick={() => removeImage(img.id)} title="Remove">
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="term-composer__row">
        <textarea
          ref={(el) => {
            ref.current = el;
            if (inputRef) inputRef.current = el;
          }}
          className="term-composer__input"
          placeholder="Type into this session's terminal…   (Enter to send · Shift+Enter for newline · paste an image to attach)"
          value={value}
          rows={rows}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={onPaste}
        />
        <button className="term-composer__send" onClick={submit} disabled={!value.trim() && !images.length}>
          Send
        </button>
      </div>
    </div>
  );
}

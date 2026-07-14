import { useRef, useState } from 'react';

/** Message input. ↑ in an empty composer recalls the last message for editing. */
export function Composer({ lastUserMessage }: { lastUserMessage: string | null }) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

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
    }
  };

  return (
    <div className="composer">
      <textarea
        ref={ref}
        className="composer__input"
        placeholder="Message this agent…   (↑ to edit your last message · sending lands in Slice 3)"
        value={value}
        rows={1}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button className="composer__send" disabled title="Replying goes live in Slice 3">
        Send
      </button>
    </div>
  );
}

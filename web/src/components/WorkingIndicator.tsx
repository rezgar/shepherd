import { useSpinGlyph } from '../lib/useSpinGlyph';

/** Claude-Code-style "✽ Transfiguring…" row, pinned at the bottom of the chat
 *  while the focused session is actively working. */
export function WorkingIndicator({ status }: { status: string }) {
  const glyph = useSpinGlyph(true);
  return (
    <div className="working-indicator">
      <span className="working-indicator__glyph">{glyph}</span>
      <span className="working-indicator__text">{status}</span>
    </div>
  );
}

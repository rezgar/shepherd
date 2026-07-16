/** A message held client-side because the session was busy when it was sent —
 *  rendered at the bottom of the chat, visually distinct from an actual sent
 *  turn, with a way to edit or drop it before it goes out for real.
 *
 *  `blocked` means the last attempt actually failed — the daemon's own error
 *  text (`blockReason`) is shown verbatim rather than guessed at, since it
 *  could be a live-elsewhere collision, a slow start, or something else
 *  entirely. None of these clear on their own, so it's held for an explicit
 *  retry instead of auto-flushing again the moment it looks idle, which
 *  would just fail the same way in a tight loop. */
export function QueuedMessage({
  text,
  images,
  blocked,
  blockReason,
  onEdit,
  onDelete,
  onRetry,
}: {
  text: string;
  images: string[];
  blocked?: boolean;
  blockReason?: string;
  onEdit: () => void;
  onDelete: () => void;
  onRetry?: () => void;
}) {
  return (
    <div className={`queued-msg${blocked ? ' queued-msg--blocked' : ''}`}>
      <div className="queued-msg__head">
        <span className="queued-msg__badge" title={blocked ? blockReason : undefined}>
          {blocked ? `Couldn't send — ${blockReason ?? 'unknown error'}` : 'Queued — sends once idle'}
        </span>
        <span className="queued-msg__actions">
          {blocked && onRetry && (
            <button className="queued-msg__retry" onClick={onRetry} title="Try sending again now">
              ↻ Retry
            </button>
          )}
          <button className="queued-msg__edit" onClick={onEdit} title="Edit (or press ↑ in the composer)">
            ✎
          </button>
          <button className="queued-msg__delete" onClick={onDelete} title="Delete">
            ×
          </button>
        </span>
      </div>
      {images.length > 0 && (
        <div className="queued-msg__images">
          {images.map((src, i) => (
            <img key={i} src={src} alt="" />
          ))}
        </div>
      )}
      {text && <div className="queued-msg__text">{text}</div>}
    </div>
  );
}

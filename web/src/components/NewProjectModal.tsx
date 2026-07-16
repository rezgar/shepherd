import { useEffect, useState } from 'react';
import type { AgentModel, DirListing } from '../types';

function joinChild(base: string, name: string): string {
  // At the drive list (base === ''), entries are already full paths (e.g. "C:\\").
  if (!base) return name;
  return base.endsWith('\\') || base.endsWith('/') ? `${base}${name}` : `${base}\\${name}`;
}

function basenameOf(dirPath: string): string {
  const parts = dirPath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || dirPath;
}

/** Browse the filesystem to start a session in a directory that has no
 *  existing card to spawn from — the only way to bootstrap a brand new
 *  project group, since every "+" elsewhere derives its repo root from an
 *  agent that already exists in that group. */
export function NewProjectModal({
  dirListing,
  dirListingError,
  onListDir,
  onSpawn,
  onClose,
  agents,
  spawnErrors,
  onFocus,
}: {
  dirListing: DirListing | null;
  dirListingError: string | null;
  onListDir: (path?: string) => void;
  onSpawn: (product: string, cwd: string) => void;
  onClose: () => void;
  agents: AgentModel[];
  spawnErrors: Map<string, string>;
  onFocus: (file: string, sessionId: string) => void;
}) {
  const [creating, setCreating] = useState<{ product: string; since: number } | null>(null);

  useEffect(() => {
    onListDir();
  }, [onListDir]);

  // Once the daemon's own transcript watcher notices the new session, jump
  // straight to it — that's the whole point of picking a directory here.
  useEffect(() => {
    if (!creating) return;
    const fresh = agents.find((a) => a.product === creating.product && a.createdAt >= creating.since);
    if (fresh) onFocus(fresh.file, fresh.sessionId);
  }, [agents, creating, onFocus]);

  const error = creating ? spawnErrors.get(creating.product) : undefined;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal newproject-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <b>Start a new project</b>
          <button className="modal__close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="modal__body newproject-modal__body">
          {creating ? (
            <div className="newproject-modal__status">
              {error ? (
                <>
                  <div className="newproject-modal__error">⚠ {error}</div>
                  <button className="newproject-modal__retry" onClick={() => setCreating(null)}>
                    ← back to picker
                  </button>
                </>
              ) : (
                <>
                  <div className="newproject-modal__spinner">…</div>
                  <div>
                    Starting a session in <code>{creating.product}</code> — this can take a little while.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="newproject-modal__path">{dirListing?.path || 'Drives'}</div>
              {dirListingError && <div className="newproject-modal__error">⚠ {dirListingError}</div>}
              <div className="newproject-modal__list">
                {dirListing?.parent !== null && dirListing !== null && (
                  <button className="newproject-modal__entry newproject-modal__entry--up" onClick={() => onListDir(dirListing.parent!)}>
                    ↑ ..
                  </button>
                )}
                {dirListing?.entries.map((e) => (
                  <button
                    key={e.name}
                    className="newproject-modal__entry"
                    onClick={() => onListDir(joinChild(dirListing.path, e.name))}
                  >
                    📁 {e.name}
                  </button>
                ))}
                {dirListing && dirListing.entries.length === 0 && (
                  <div className="newproject-modal__empty">No subfolders here.</div>
                )}
              </div>
              {dirListing?.path && (
                <button
                  className="newproject-modal__confirm"
                  onClick={() => {
                    const product = basenameOf(dirListing.path);
                    setCreating({ product, since: Date.now() });
                    onSpawn(product, dirListing.path);
                  }}
                >
                  Start a session in “{basenameOf(dirListing.path)}”
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

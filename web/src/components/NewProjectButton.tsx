/** Shared between the canvas topbar and the focused single-session view —
 *  same entry point into NewProjectModal, so a future tweak (copy, icon,
 *  disabled state) only needs to happen in one place. */
export function NewProjectButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="new-project-btn" onClick={onClick} title="Start a session in a new project directory">
      + new project
    </button>
  );
}

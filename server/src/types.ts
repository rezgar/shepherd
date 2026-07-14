export type AgentState = 'working' | 'needs-you' | 'idle';

export type Stage =
  | 'definition'
  | 'planning'
  | 'implementation'
  | 'testing'
  | 'debugging'
  | 'unknown';

export type ActionKind = 'approve' | 'question';

/** One Claude Code session, as Shepherd sees it. */
export interface AgentModel {
  sessionId: string;
  /** Repo name used to group agents into lanes. */
  product: string;
  /** Repo root path (worktree-stripped). */
  repoPath: string;
  /** Actual working dir (may be a worktree). */
  cwd: string;
  /** git branch, if known. */
  branch: string | null;
  /** Short card label — worktree name or branch. */
  label: string;
  /** Auto-generated session title, if any. */
  title: string | null;
  state: AgentState;
  stage: Stage;
  /** One-line human status. */
  status: string;
  /** If needs-you, what kind of action. */
  action: ActionKind | null;
  /** Epoch ms of last activity. */
  lastActivity: number;
  /** Queued (not-yet-sent) instructions. */
  queued: number;
  /** Source transcript path. */
  file: string;
}

export interface Snapshot {
  type: 'snapshot';
  /** Server clock at snapshot time (ms) — clients derive "ago" from this. */
  now: number;
  agents: AgentModel[];
}

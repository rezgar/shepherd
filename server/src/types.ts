export type AgentState = 'working' | 'needs-you' | 'idle' | 'error';

export type Stage =
  | 'definition'
  | 'planning'
  | 'implementation'
  | 'testing'
  | 'debugging'
  | 'unknown';

export type ActionKind = 'approve' | 'question';

/** Current + upcoming tasks, derived from the session's own TodoWrite/
 *  TaskCreate/TaskUpdate tool calls — undefined for sessions that never used
 *  one. Completed items are dropped; only what's happening now and next matters. */
export interface TaskLine {
  current: string | null;
  upcoming: string[];
}

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
  /** Best display name: GitHub issue title → session title → branch/worktree. */
  name: string;
  state: AgentState;
  stage: Stage;
  /** High-level card status while working — the current task, one altitude below `stage`. */
  status: string;
  /** Conceptual, plain-language line of what the agent is doing and how it's
   *  going, produced by a fast model over the recent transcript (see
   *  summarize.ts). Set only for working / just-finished sessions; null
   *  otherwise, so the card falls back to `status`. */
  summary?: string | null;
  /** Granular "doing this instant" detail — shown in the focus-view ✽ indicator. */
  activity: string;
  /** If needs-you, what kind of action. */
  action: ActionKind | null;
  /** Epoch ms of last activity. */
  lastActivity: number;
  /** Epoch ms of the first event — session creation, for stable ordering. */
  createdAt: number;
  /** Queued (not-yet-sent) instructions. */
  queued: number;
  /** Source transcript path. */
  file: string;
  /** Done/current/next task tracking, if the session used TodoWrite/TaskCreate. */
  taskLine?: TaskLine;
}

export interface Snapshot {
  type: 'snapshot';
  /** Server clock at snapshot time (ms) — clients derive "ago" from this. */
  now: number;
  agents: AgentModel[];
}

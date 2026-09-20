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
  /** Whether a `/remote-control is active` system event has ever appeared in
   *  this session's transcript — Claude Code writes one whenever a process
   *  for it starts up with Remote Control on, and never writes a
   *  corresponding "now disconnected" one (it drops silently by design), so
   *  this can only prove "a phone/browser could reach this at some point,"
   *  never "it's connected right now." That's what restore-selection needs:
   *  see selectRestoreTargets in restore.ts. */
  everHadRemoteControl: boolean;
  /** Turns genuinely put to the model (tool results, interrupt notices and
   *  the PTY driver's own slash-command echoes excluded), and tool calls made
   *  in reply. Together they distinguish a one-shot tool invocation — `aic.sh`
   *  asking for a commit message, say — from a session a person actually used;
   *  see machineIssued.ts. */
  userTurns: number;
  toolUses: number;
}

export interface Snapshot {
  type: 'snapshot';
  /** Server clock at snapshot time (ms) — clients derive "ago" from this. */
  now: number;
  agents: AgentModel[];
}

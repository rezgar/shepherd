// Mirror of the server wire types (@shepherd/server/src/types.ts).
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

export interface AgentModel {
  sessionId: string;
  product: string;
  repoPath: string;
  cwd: string;
  branch: string | null;
  label: string;
  title: string | null;
  name: string;
  state: AgentState;
  stage: Stage;
  /** High-level card status while working (the current task). */
  status: string;
  /** Granular "doing this instant" detail — focus-view ✽ indicator. */
  activity: string;
  action: ActionKind | null;
  lastActivity: number;
  createdAt: number;
  queued: number;
  file: string;
  taskLine?: TaskLine;
}

export interface Snapshot {
  type: 'snapshot';
  now: number;
  agents: AgentModel[];
}

/** 5h/7d rolling usage, estimated locally by the daemon (see server/src/usage.ts). */
export interface LimitBar {
  percent: number;
  resetMs: number;
}

export interface Limits {
  session: LimitBar | null;
  weekly: LimitBar | null;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  header?: string;
  question: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface ChatTool {
  name: string;
  detail: string;
  /** Set only for AskUserQuestion — rendered as a question card, not a chip. */
  questions?: AskQuestion[];
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ChatTool[];
  images: string[];
  ts: number;
  /** Optimistic local echo, not yet confirmed written by the real transcript. */
  pending?: boolean;
}

export interface SubagentInfo {
  agentId: string;
  description: string;
  dispatchedAt: number;
}

export interface Transcript {
  type: 'transcript';
  sessionId: string;
  file: string;
  messages: ChatMsg[];
  activeSubagents: SubagentInfo[];
}

/** One level of the directory picker used to start a session in a brand
 *  new project that has no existing card to spawn from. */
export interface DirListing {
  path: string;
  /** '' means "go up to the drive list" (Windows only); null means already at the top. */
  parent: string | null;
  entries: { name: string }[];
}

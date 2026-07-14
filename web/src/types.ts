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
}

export interface Snapshot {
  type: 'snapshot';
  now: number;
  agents: AgentModel[];
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

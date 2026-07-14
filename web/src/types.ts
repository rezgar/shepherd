// Mirror of the server wire types (@shepherd/server/src/types.ts).
export type AgentState = 'working' | 'needs-you' | 'idle';

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
  status: string;
  action: ActionKind | null;
  lastActivity: number;
  queued: number;
  file: string;
}

export interface Snapshot {
  type: 'snapshot';
  now: number;
  agents: AgentModel[];
}

export interface ChatTool {
  name: string;
  detail: string;
}

export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  tools: ChatTool[];
  images: string[];
  ts: number;
}

export interface Transcript {
  type: 'transcript';
  sessionId: string;
  file: string;
  messages: ChatMsg[];
}

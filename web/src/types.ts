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

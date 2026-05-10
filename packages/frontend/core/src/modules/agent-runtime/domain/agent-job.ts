// ─── Job Status ────────────────────────────────────────────────
export type AgentJobStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_approval'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'succeeded'
  | 'failed'
  | 'interrupted';

export type AgentJobPriority = 'low' | 'normal' | 'high';

export type AgentWorkflowKind =
  | 'fake_long_running'
  | 'create_doc_from_prompt'
  | 'append_to_current_doc'
  | 'approval_demo'
  | 'llm_planner';

export function isActiveJobStatus(status: AgentJobStatus): boolean {
  return ['queued', 'planning', 'running', 'waiting_approval'].includes(status);
}

// ─── Error ─────────────────────────────────────────────────────
export type AgentErrorCode =
  | 'LLM_PROVIDER_ERROR'
  | 'TOOL_NOT_FOUND'
  | 'TOOL_EXECUTION_FAILED'
  | 'APPROVAL_REJECTED'
  | 'CONTEXT_CAPTURE_FAILED'
  | 'DOC_READ_FAILED'
  | 'DOC_WRITE_FAILED'
  | 'NETWORK_ERROR'
  | 'CANCELLED'
  | 'UNKNOWN';

export interface AgentErrorInfo {
  code: AgentErrorCode;
  message: string;
  details?: unknown;
}

// ─── Step ──────────────────────────────────────────────────────
export type AgentStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'failed'
  | 'skipped';

export interface AgentStep {
  id: string;
  jobId: string;
  title: string;
  description?: string;
  status: AgentStepStatus;
  toolName?: string;
  toolInput?: unknown;
  toolInputPreview?: unknown;
  toolOutputPreview?: unknown;
  startedAt?: string;
  completedAt?: string;
  error?: AgentErrorInfo;
}

// ─── Log ───────────────────────────────────────────────────────
export type AgentLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AgentLog {
  id: string;
  jobId: string;
  stepId?: string;
  level: AgentLogLevel;
  message: string;
  data?: unknown;
  createdAt: string;
}

// ─── Artifact ──────────────────────────────────────────────────
export type AgentArtifactType =
  | 'markdown'
  | 'doc'
  | 'diff'
  | 'link'
  | 'json'
  | 'text';

export interface AgentArtifact {
  id: string;
  jobId: string;
  type: AgentArtifactType;
  title: string;
  content?: string;
  docId?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ─── Job ───────────────────────────────────────────────────────
export interface AgentJobProgress {
  currentStepIndex: number;
  totalSteps: number;
  percent: number;
  label: string;
}

export interface AgentJob {
  id: string;
  workspaceId: string;
  title: string;
  userPrompt: string;
  context: import('./agent-context').AgentContextSnapshot;
  workflow?: AgentWorkflowKind;
  status: AgentJobStatus;
  priority: AgentJobPriority;
  progress: AgentJobProgress;
  plan: AgentStep[];
  logs: AgentLog[];
  artifacts: AgentArtifact[];
  approvals: import('./agent-tool').ApprovalRequest[];
  error?: AgentErrorInfo;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface EnqueueAgentJobInput {
  title: string;
  userPrompt: string;
  workspaceId: string;
  context: import('./agent-context').AgentContextSnapshot;
  workflow?: AgentWorkflowKind;
  priority?: AgentJobPriority;
}

import type { Workspace } from '@affine/core/modules/workspace';
import type { DocsService } from '@affine/core/modules/doc';

import type { AgentArtifact, AgentLog } from './agent-job';

// ─── Tool Risk Level ───────────────────────────────────────────
export type ToolRiskLevel =
  | 'read'
  | 'create'
  | 'append'
  | 'modify'
  | 'delete'
  | 'bulk';

// ─── Tool Execution Context ───────────────────────────────────
export interface ToolExecutionContext {
  jobId: string;
  workspaceId: string;
  workspace: Workspace;
  docsService: DocsService;
  docsSearchService: import('../../docs-search').DocsSearchService;
  signal: AbortSignal;
  addLog(log: Omit<AgentLog, 'id' | 'jobId' | 'createdAt'>): void;
  addArtifact(
    artifact: Omit<AgentArtifact, 'id' | 'jobId' | 'createdAt'>
  ): void;
  requestApproval(request: CreateApprovalRequest): Promise<ApprovalDecision>;
}

// ─── Tool Interface ────────────────────────────────────────────
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  riskLevel: ToolRiskLevel;
  /** If true, tool requires server connectivity. Default: false. */
  requiresNetwork?: boolean;
  inputSchema: unknown;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
}

// ─── Approval ──────────────────────────────────────────────────
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalDecision = 'approved' | 'rejected';

export interface CreateApprovalRequest {
  title: string;
  description: string;
  riskLevel: ToolRiskLevel;
  proposedAction: {
    toolName: string;
    input: unknown;
    summary: string;
  };
  diffPreview?: {
    before?: string;
    after?: string;
    format: 'markdown' | 'json' | 'text';
  };
}

export interface ApprovalRequest extends CreateApprovalRequest {
  id: string;
  jobId: string;
  stepId?: string;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
}

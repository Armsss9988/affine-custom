export { AgentRuntimeService } from './services/agent-runtime-service';
export { createAgentContextSnapshot } from './services/context-snapshot';
export { ToolRegistry } from './services/tool-registry';
export type { AgentContextSnapshot } from './domain/agent-context';
export type {
  AgentArtifact,
  AgentArtifactType,
  AgentErrorCode,
  AgentErrorInfo,
  AgentJob,
  AgentJobProgress,
  AgentJobStatus,
  AgentWorkflowKind,
  AgentLog,
  AgentLogLevel,
  AgentStep,
  AgentStepStatus,
  EnqueueAgentJobInput,
} from './domain/agent-job';
export { isActiveJobStatus } from './domain/agent-job';
export type {
  AgentTool,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
  CreateApprovalRequest,
  ToolExecutionContext,
  ToolRiskLevel,
} from './domain/agent-tool';

import type { Framework } from '@toeverything/infra';

import { WorkspaceScope, WorkspaceService } from '../workspace';
import { AgentRuntimeService } from './services/agent-runtime-service';
import { ToolRegistry } from './services/tool-registry';

import { WorkspaceServerService } from '../cloud';
import { DocsService } from '../doc';

export function configureAgentRuntimeModule(framework: Framework) {
  framework
    .scope(WorkspaceScope)
    .service(ToolRegistry)
    .service(AgentRuntimeService, [
      ToolRegistry,
      WorkspaceService,
      WorkspaceServerService,
      DocsService,
    ]);
}

import type { AgentContextSnapshot } from '../domain/agent-context';

/**
 * Creates an immutable snapshot of the current AFFiNE context.
 * Called at job submission time to decouple the job from live editor state.
 */
export function createAgentContextSnapshot(params: {
  workspaceId: string;
  docId?: string;
  docTitle?: string;
  viewMode?: AgentContextSnapshot['sourceView'];
  selectedText?: string;
  selectedBlockIds?: string[];
  route?: string;
}): AgentContextSnapshot {
  return {
    workspaceId: params.workspaceId,
    sourceDocId: params.docId,
    sourceDocTitle: params.docTitle,
    sourceView: params.viewMode ?? 'unknown',
    selectedText: params.selectedText,
    selectedBlockIds: params.selectedBlockIds,
    routeAtSubmit: params.route,
    createdAt: new Date().toISOString(),
  };
}

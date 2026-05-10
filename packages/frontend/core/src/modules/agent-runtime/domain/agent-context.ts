/**
 * Immutable snapshot of the user's AFFiNE context at the time a job was submitted.
 * This ensures the job can execute correctly even after the user navigates away.
 */
export interface AgentContextSnapshot {
  workspaceId: string;

  sourceDocId?: string;
  sourceDocTitle?: string;

  targetDocId?: string;
  targetDocTitle?: string;

  sourceView?: 'page' | 'database' | 'edgeless' | 'collection' | 'unknown';

  selectedBlockIds?: string[];
  selectedText?: string;

  routeAtSubmit?: string;

  /**
   * Optional lightweight text preview for stable execution.
   * Keep this small to avoid persisting huge document snapshots.
   */
  contextTextPreview?: string;

  createdAt: string;
}

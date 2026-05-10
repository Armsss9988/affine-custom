import { toast } from '@affine/component';
import {
  AgentRuntimeService,
  type AgentJob,
  type AgentJobStatus,
  type AgentStep,
  type AgentLog,
  type AgentArtifact,
  type ApprovalRequest,
  isActiveJobStatus,
} from '@affine/core/modules/agent-runtime';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { useLiveData, useService } from '@toeverything/infra';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

import * as styles from './styles.css';

const statusLabel: Record<AgentJobStatus, string> = {
  queued: 'Queued',
  planning: 'Planning',
  running: 'Running',
  waiting_approval: 'Needs Approval',
  paused: 'Paused',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
  succeeded: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

const stepStatusIcons: Record<AgentStep['status'], string> = {
  pending: '⏳',
  running: '🔄',
  waiting_approval: '⚠️',
  succeeded: '✅',
  failed: '❌',
  skipped: '⏭️',
};

const logLevelColors: Record<AgentLog['level'], string> = {
  debug: '#9ca3af',
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
};

function getStatusStyle(status: AgentJobStatus): string {
  switch (status) {
    case 'running':
    case 'planning':
      return styles.statusRunning;
    case 'succeeded':
      return styles.statusSucceeded;
    case 'failed':
    case 'interrupted':
      return styles.statusFailed;
    case 'waiting_approval':
      return styles.statusWaiting;
    default:
      return styles.statusQueued;
  }
}

function formatTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '--:--:--';
  }
}

function JobItem({
  job,
  onCancel,
  onRetry,
  onApprove,
  onReject,
  isSelected,
  onSelect,
}: {
  job: AgentJob;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  isSelected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const canCancel = isActiveJobStatus(job.status);
  const canRetry =
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'interrupted';
  const pendingApprovals = job.approvals.filter(a => a.status === 'pending');

  const handleItemClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't select if clicking on action buttons
      if (
        (e.target as HTMLElement).closest(`.${styles.jobActions}`) ||
        (e.target as HTMLElement).closest('button')
      ) {
        return;
      }
      onSelect?.(job.id);
    },
    [job.id, onSelect]
  );

  return (
    <div
      className={clsx(styles.jobItem, isSelected && styles.jobItemSelected)}
      onClick={handleItemClick}
    >
      <div className={styles.jobItemHeader}>
        <span className={styles.jobTitle} title={job.title}>
          {job.title}
        </span>
        <span className={clsx(styles.jobStatus, getStatusStyle(job.status))}>
          {statusLabel[job.status]}
        </span>
      </div>
      <div className={styles.jobProgress}>
        <div className={styles.progressBarContainer}>
          <div
            className={styles.progressBarFill}
            style={{ width: `${job.progress.percent}%` }}
          />
        </div>
        <span className={styles.progressText}>
          {job.progress.label} — {job.progress.percent}%
        </span>
      </div>
      <div className={styles.jobActions}>
        {canCancel && (
          <button className={styles.actionBtn} onClick={() => onCancel(job.id)}>
            Cancel
          </button>
        )}
        {canRetry && (
          <button className={styles.actionBtn} onClick={() => onRetry(job.id)}>
            Retry
          </button>
        )}
        {pendingApprovals.map(approval => (
          <span key={approval.id}>
            <button
              className={styles.actionBtn}
              onClick={() => onApprove(approval.id)}
            >
              Approve
            </button>
            <button
              className={styles.actionBtn}
              onClick={() => onReject(approval.id)}
            >
              Reject
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function StepItem({ step, index }: { step: AgentStep; index: number }) {
  return (
    <div className={styles.stepItem}>
      <span className={styles.stepIcon}>{stepStatusIcons[step.status]}</span>
      <div className={styles.stepContent}>
        <div className={styles.stepTitle}>
          {index + 1}. {step.title}
        </div>
        {step.description && (
          <div className={styles.stepDescription}>{step.description}</div>
        )}
        {step.error && (
          <div className={styles.stepError}>{step.error.message}</div>
        )}
      </div>
    </div>
  );
}

function LogItem({ log }: { log: AgentLog }) {
  return (
    <div className={styles.logItem}>
      <span className={styles.logTime}>[{formatTime(log.createdAt)}]</span>
      <span
        className={styles.logLevel}
        style={{ color: logLevelColors[log.level] }}
      >
        [{log.level.toUpperCase()}]
      </span>
      <span className={styles.logMessage}>{log.message}</span>
    </div>
  );
}

function LogList({ logs }: { logs: AgentLog[] }) {
  // Sort logs by creation time
  const sortedLogs = [...logs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <div className={styles.logList}>
      {sortedLogs.map(log => (
        <LogItem key={log.id} log={log} />
      ))}
    </div>
  );
}

function ArtifactItem({
  artifact,
  onOpenDoc,
}: {
  artifact: AgentArtifact;
  onOpenDoc?: (docId: string) => void;
}) {
  const handleOpen = () => {
    if (artifact.docId && onOpenDoc) {
      onOpenDoc(artifact.docId);
    }
  };

  return (
    <div className={styles.artifactItem}>
      <span className={styles.artifactIcon}>📄</span>
      <div className={styles.artifactContent}>
        <span className={styles.artifactTitle}>{artifact.title}</span>
        {artifact.docId && onOpenDoc && (
          <button className={styles.artifactOpenBtn} onClick={handleOpen}>
            Open
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalItem({
  approval,
  onApprove,
  onReject,
}: {
  approval: ApprovalRequest;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const hasDiff = approval.diffPreview?.before || approval.diffPreview?.after;

  if (approval.status !== 'pending') {
    return (
      <div className={styles.approvalItem}>
        <span className={styles.approvalIcon}>ℹ️</span>
        <span className={styles.approvalTitle}>
          {approval.title} — {approval.status}
        </span>
      </div>
    );
  }

  return (
    <div className={styles.approvalItem}>
      <span className={styles.approvalIcon}>⚠️</span>
      <div className={styles.approvalContent}>
        <div className={styles.approvalTitle}>{approval.title}</div>
        <div className={styles.approvalDescription}>{approval.description}</div>
        {hasDiff && approval.diffPreview && (
          <div className={styles.diffPreview}>
            {approval.diffPreview.before && (
              <div className={styles.diffSection}>
                <span className={styles.diffBeforeLabel}>Before</span>
                <pre className={styles.diffContent}>
                  {approval.diffPreview.before}
                </pre>
              </div>
            )}
            {approval.diffPreview.after && (
              <div className={styles.diffSection}>
                <span className={styles.diffAfterLabel}>After</span>
                <pre className={styles.diffContent}>
                  {approval.diffPreview.after}
                </pre>
              </div>
            )}
          </div>
        )}
        <div className={styles.approvalActions}>
          <button
            className={styles.approveBtn}
            onClick={() => onApprove(approval.id)}
          >
            Approve
          </button>
          <button
            className={styles.rejectBtn}
            onClick={() => onReject(approval.id)}
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

function JobDetailPanel({
  job,
  onClose,
  onApprove,
  onReject,
  onOpenDoc,
}: {
  job: AgentJob;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onOpenDoc?: (docId: string) => void;
}) {
  const context = job.context;
  const contextParts: string[] = [];
  if (context.sourceDocTitle) {
    contextParts.push(`Doc "${context.sourceDocTitle}"`);
  }
  if (context.sourceView) {
    contextParts.push(`view: ${context.sourceView}`);
  }
  contextParts.push(`workspace ${context.workspaceId.slice(0, 8)}...`);
  const contextLabel = contextParts.join(', ');

  return (
    <div className={styles.detailPanel}>
      <div className={styles.detailPanelHeader}>
        <span className={styles.detailPanelTitle}>{job.title}</span>
        <button className={styles.detailPanelClose} onClick={onClose}>
          ✕
        </button>
      </div>

      <div className={styles.detailPanelContent}>
        {/* Prompt & Context */}
        <div className={styles.detailSection}>
          <div className={styles.detailSectionTitle}>Prompt</div>
          <div className={styles.detailSectionContent}>
            <code className={styles.promptText}>{job.userPrompt}</code>
          </div>
        </div>

        {contextLabel && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>Context</div>
            <div className={styles.detailSectionContent}>{contextLabel}</div>
          </div>
        )}

        {/* Plan Steps */}
        {job.plan.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>Plan Steps</div>
            <div className={styles.stepList}>
              {job.plan.map((step, index) => (
                <StepItem key={step.id} step={step} index={index} />
              ))}
            </div>
          </div>
        )}

        {/* Logs */}
        {job.logs.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>
              Logs ({job.logs.length})
            </div>
            <LogList logs={job.logs} />
          </div>
        )}

        {/* Artifacts */}
        {job.artifacts.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>
              Artifacts ({job.artifacts.length})
            </div>
            <div className={styles.artifactList}>
              {job.artifacts.map(artifact => (
                <ArtifactItem
                  key={artifact.id}
                  artifact={artifact}
                  onOpenDoc={onOpenDoc}
                />
              ))}
            </div>
          </div>
        )}

        {/* Approvals */}
        {job.approvals.length > 0 && (
          <div className={styles.detailSection}>
            <div className={styles.detailSectionTitle}>Approval Requests</div>
            <div className={styles.approvalList}>
              {job.approvals.map(approval => (
                <ApprovalItem
                  key={approval.id}
                  approval={approval}
                  onApprove={onApprove}
                  onReject={onReject}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export const AgentJobDock = () => {
  const featureFlags = useService(FeatureFlagService).flags;
  const enabled = useLiveData(featureFlags.enable_agent_runtime.$);
  const agentRuntime = useService(AgentRuntimeService);
  const jobs = useLiveData(agentRuntime.jobs$);
  const activeCount = useLiveData(agentRuntime.activeJobCount$);
  const [open, setOpen] = useState(false);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const prevJobsRef = useRef<Map<string, AgentJobStatus>>(new Map());

  // Toast notifications for job status changes
  useEffect(() => {
    const current = new Map(jobs.map(j => [j.id, j.status]));
    for (const job of jobs) {
      const prev = prevJobsRef.current.get(job.id);
      if (prev && prev !== job.status) {
        if (job.status === 'succeeded') {
          toast(`✅ Job done: ${job.title}`, { portal: document.body });
        } else if (job.status === 'failed') {
          toast(`❌ Job failed: ${job.title}`, { portal: document.body });
        }
      }
    }
    prevJobsRef.current = current;
  }, [jobs]);

  const selectedJob = jobs.find(j => j.id === selectedJobId);

  const handleCancel = useCallback(
    (id: string) => agentRuntime.cancelJob(id),
    [agentRuntime]
  );
  const handleRetry = useCallback(
    (id: string) => agentRuntime.retryJob(id),
    [agentRuntime]
  );
  const handleApprove = useCallback(
    (id: string) => agentRuntime.approve(id),
    [agentRuntime]
  );
  const handleReject = useCallback(
    (id: string) => agentRuntime.reject(id),
    [agentRuntime]
  );
  const handleOpenDoc = useCallback((docId: string) => {
    // TODO: implement doc navigation - open doc with given ID
    console.log('[AgentJobDock] Open doc:', docId);
  }, []);

  const handleSelectJob = useCallback((id: string) => {
    setSelectedJobId(prev => (prev === id ? null : id));
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedJobId(null);
  }, []);

  if (!enabled || jobs.length === 0) {
    return null;
  }

  const hasActive = activeCount > 0;

  return (
    <div className={styles.agentJobDockWrapper}>
      {open && (
        <div className={styles.popover}>
          <div className={styles.popoverTitle}>AI Jobs</div>
          {jobs.length === 0 ? (
            <div className={styles.emptyState}>No jobs yet</div>
          ) : selectedJob ? (
            <JobDetailPanel
              job={selectedJob}
              onClose={handleCloseDetail}
              onApprove={handleApprove}
              onReject={handleReject}
              onOpenDoc={handleOpenDoc}
            />
          ) : (
            <div className={styles.jobList}>
              {jobs.map(job => (
                <JobItem
                  key={job.id}
                  job={job}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  onApprove={handleApprove}
                  onReject={handleReject}
                  isSelected={job.id === selectedJobId}
                  onSelect={handleSelectJob}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <div
        className={styles.dockBadge}
        onClick={() => setOpen(prev => !prev)}
        data-testid="agent-job-dock-badge"
      >
        <span
          className={
            hasActive ? styles.dockBadgeDot : styles.dockBadgeDotSuccess
          }
        />
        AI Jobs {activeCount > 0 ? `(${activeCount})` : '✓'}
      </div>
    </div>
  );
};

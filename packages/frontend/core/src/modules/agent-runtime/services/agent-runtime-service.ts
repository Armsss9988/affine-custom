import {
  CopilotClient,
  textToText,
  Endpoint,
} from '@affine/core/blocksuite/ai';
import {
  EventSourceService,
  GraphQLService,
  WorkspaceServerService,
} from '@affine/core/modules/cloud';
import { DocsService } from '@affine/core/modules/doc';
import { DocsSearchService } from '../../docs-search';
import { AIModelService } from '@affine/core/modules/ai-button';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { LiveData, Service } from '@toeverything/infra';
import { NetworkMonitor } from '../runtime/network-monitor';

import type {
  AgentArtifact,
  AgentErrorCode,
  AgentJob,
  AgentLog,
  AgentStep,
  EnqueueAgentJobInput,
} from '../domain/agent-job';
import { isActiveJobStatus } from '../domain/agent-job';
import { builtinChains } from '../chains/builtin-chains';
import { resolveChainParams } from '../domain/agent-chain';
import {
  generatePlanningPrompt,
  parsePlanningResponse,
} from '../domain/agent-planner';
import type {
  ApprovalDecision,
  ApprovalRequest,
  CreateApprovalRequest,
  ToolExecutionContext,
} from '../domain/agent-tool';
import { InMemoryJobQueue } from '../runtime/in-memory-queue';
import { AgentJobStore } from '../store/agent-job-store';
import type { ToolRegistry } from './tool-registry';

let jobIdCounter = 0;
function nextJobId(): string {
  return `agent-job-${Date.now()}-${++jobIdCounter}`;
}

let logIdCounter = 0;
function nextLogId(): string {
  return `log-${++logIdCounter}`;
}

let approvalIdCounter = 0;
function nextApprovalId(): string {
  return `approval-${++approvalIdCounter}`;
}

let artifactIdCounter = 0;
function nextArtifactId(): string {
  return `artifact-${++artifactIdCounter}`;
}

function createStep(
  jobId: string,
  title: string,
  toolName: string,
  toolInput: unknown,
  description?: string
): AgentStep {
  return {
    id: crypto.randomUUID(),
    jobId,
    title,
    description,
    status: 'pending',
    toolName,
    toolInput,
    toolInputPreview: toolInput,
  };
}

function getErrorCode(error: unknown): AgentErrorCode {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    switch (code) {
      case 'LLM_PROVIDER_ERROR':
      case 'TOOL_NOT_FOUND':
      case 'TOOL_EXECUTION_FAILED':
      case 'APPROVAL_REJECTED':
      case 'CONTEXT_CAPTURE_FAILED':
      case 'DOC_READ_FAILED':
      case 'DOC_WRITE_FAILED':
      case 'NETWORK_ERROR':
      case 'CANCELLED':
      case 'UNKNOWN':
        return code;
    }
  }
  return 'UNKNOWN';
}

/**
 * Central service for managing AI agent jobs within a workspace.
 * Lives at WorkspaceScope — one instance per opened workspace.
 */
export class AgentRuntimeService extends Service {
  private readonly jobMap = new Map<string, AgentJob>();
  private readonly queue = new InMemoryJobQueue(2);
  private emitTimeout: any = null;
  private readonly networkMonitor = new NetworkMonitor();
  private readonly networkWaiters = new Map<string, () => void>();

  getNetworkMonitor() {
    return this.networkMonitor;
  }
  private readonly approvalResolvers = new Map<
    string,
    { jobId: string; resolve: (decision: ApprovalDecision) => void }
  >();

  /** Reactive list of all jobs, newest first. */
  readonly jobs$ = new LiveData<AgentJob[]>([]);

  /** Count of active (non-terminal) jobs. */
  readonly activeJobCount$ = this.jobs$.map(
    jobs => jobs.filter(j => isActiveJobStatus(j.status)).length
  );

  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly workspaceService: WorkspaceService,
    private readonly workspaceServerService: WorkspaceServerService,
    private readonly docsService: DocsService,
    private readonly jobStore: AgentJobStore,
    private readonly docsSearchService: DocsSearchService
  ) {
    super();
    this.queue.setExecutor((jobId, signal) => this.executeJob(jobId, signal));
    this.hydrateJobs();
  }

  private hydrateJobs(): void {
    const workspaceId = this.workspaceService.workspace.id;
    this.jobStore.listJobs(workspaceId).then(jobs => {
      const mapped = jobs.map(job => {
        if (isActiveJobStatus(job.status)) {
          return {
            ...job,
            status: 'interrupted' as const,
            error: {
              code: 'UNKNOWN' as const,
              message: 'Job was interrupted by an application reload.',
            },
            updatedAt: new Date().toISOString(),
          };
        }
        return job;
      });

      for (const job of mapped) {
        this.jobMap.set(job.id, job);
      }
      this.emitJobs(true);
    });
  }

  // ─── Public API ────────────────────────────────────────────

  enqueue(input: EnqueueAgentJobInput): AgentJob {
    const now = new Date().toISOString();
    const job: AgentJob = {
      id: nextJobId(),
      workspaceId: input.workspaceId,
      title: input.title,
      userPrompt: input.userPrompt,
      context: input.context,
      workflow: input.workflow,
      status: 'queued',
      priority: input.priority ?? 'normal',
      progress: {
        currentStepIndex: 0,
        totalSteps: 0,
        percent: 0,
        label: 'Queued',
      },
      plan: [],
      logs: [],
      artifacts: [],
      approvals: [],
      createdAt: now,
      updatedAt: now,
      chatOptions: input.chatOptions,
      chainId: input.chainId,
    };

    this.jobMap.set(job.id, job);
    this.emitJobs(true);
    this.jobStore.saveJob(job);
    this.queue.enqueue(job.id);
    return job;
  }

  clearJobs(): void {
    for (const [id, job] of this.jobMap.entries()) {
      if (!isActiveJobStatus(job.status)) {
        this.jobMap.delete(id);
        this.jobStore.deleteJob(id);
      }
    }
    this.emitJobs(true);
  }

  cancelJob(jobId: string): void {
    const job = this.jobMap.get(jobId);
    if (!job) return;

    const waiter = this.networkWaiters.get(jobId);
    if (waiter) {
      waiter();
      this.networkWaiters.delete(jobId);
    }

    this.queue.cancel(jobId);
    for (const approval of job.approvals) {
      if (approval.status !== 'pending') {
        continue;
      }
      const resolver = this.approvalResolvers.get(approval.id);
      approval.status = 'rejected';
      approval.resolvedAt = new Date().toISOString();
      if (resolver) {
        resolver.resolve('rejected');
        this.approvalResolvers.delete(approval.id);
      }
    }

    if (isActiveJobStatus(job.status)) {
      this.patchJob(jobId, {
        status: 'cancelled',
        approvals: [...job.approvals],
        completedAt: new Date().toISOString(),
        progress: { ...job.progress, label: 'Cancelled' },
      });
    }
  }

  retryJob(jobId: string): void {
    const job = this.jobMap.get(jobId);
    if (!job) return;
    if (
      job.status !== 'failed' &&
      job.status !== 'cancelled' &&
      job.status !== 'interrupted'
    ) {
      return;
    }

    this.patchJob(jobId, {
      status: 'queued',
      error: undefined,
      completedAt: undefined,
      progress: {
        currentStepIndex: 0,
        totalSteps: 0,
        percent: 0,
        label: 'Queued (retry)',
      },
      plan: [],
      logs: [],
    });
    this.queue.enqueue(jobId);
  }

  approve(requestId: string): void {
    const resolver = this.approvalResolvers.get(requestId);
    if (resolver) {
      resolver.resolve('approved');
      this.approvalResolvers.delete(requestId);
    }
  }

  reject(requestId: string, _reason?: string): void {
    const resolver = this.approvalResolvers.get(requestId);
    if (resolver) {
      resolver.resolve('rejected');
      this.approvalResolvers.delete(requestId);
    }
  }

  getJob(jobId: string): AgentJob | undefined {
    return this.jobMap.get(jobId);
  }

  listJobs(): AgentJob[] {
    return Array.from(this.jobMap.values()).sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  listChains() {
    return builtinChains;
  }

  // ─── Job Execution ─────────────────────────────────────────

  private async executeJob(jobId: string, signal: AbortSignal): Promise<void> {
    const job = this.jobMap.get(jobId);
    if (!job) return;

    try {
      this.patchJob(jobId, {
        status: 'planning',
        startedAt: new Date().toISOString(),
        progress: { ...job.progress, label: 'Planning...' },
      });

      // Phase 2: LLM planning using Ephemeral Copilot Session
      const steps = await this.planJob(job, signal);
      this.patchJob(jobId, {
        status: 'running',
        plan: steps,
        progress: {
          currentStepIndex: 0,
          totalSteps: steps.length,
          percent: 0,
          label: steps[0]?.title ?? 'Running',
        },
      });

      // Execute steps sequentially
      let prevStepOutput: Record<string, unknown> | null = null;
      for (let i = 0; i < steps.length; i++) {
        if (signal.aborted) {
          throw new Error('Cancelled');
        }

        const step = steps[i];
        step.status = 'running';
        step.startedAt = new Date().toISOString();
        this.patchJob(jobId, {
          plan: [...steps],
          progress: {
            currentStepIndex: i,
            totalSteps: steps.length,
            percent: Math.round((i / steps.length) * 100),
            label: step.title,
          },
        });

        if (step.toolName) {
          const tool = this.toolRegistry.get(step.toolName);
          if (!tool) {
            step.status = 'failed';
            step.error = {
              code: 'TOOL_NOT_FOUND',
              message: `Tool not found: ${step.toolName}`,
            };
            throw new Error(`Tool not found: ${step.toolName}`);
          }

          // Network gate: if tool requires network and we're offline, wait
          if (tool.requiresNetwork && !this.networkMonitor.isOnline) {
            const currentProgress = this.jobMap.get(jobId)?.progress ?? {
              currentStepIndex: i,
              totalSteps: steps.length,
              percent: Math.round((i / steps.length) * 100),
              label: step.title,
            };

            step.status = 'pending'; // revert step status to pending
            this.patchJob(jobId, {
              status: 'waiting_network',
              plan: [...steps],
              progress: {
                ...currentProgress,
                label: 'Waiting for network...',
              },
            });

            // Wait for network to come back or cancellation
            await new Promise<void>((resolve, reject) => {
              if (signal.aborted) {
                reject(new Error('Cancelled'));
                return;
              }

              const sub = this.networkMonitor.online$.subscribe(online => {
                if (online) {
                  sub.unsubscribe();
                  this.networkWaiters.delete(jobId);
                  resolve();
                }
              });

              this.networkWaiters.set(jobId, () => {
                sub.unsubscribe();
                reject(new Error('Cancelled'));
              });

              signal.addEventListener('abort', () => {
                sub.unsubscribe();
                this.networkWaiters.delete(jobId);
                reject(new Error('Cancelled'));
              }, { once: true });
            });

            // Resume — update status back to running
            step.status = 'running';
            this.patchJob(jobId, {
              status: 'running',
              plan: [...steps],
              progress: { ...currentProgress, label: step.title },
            });
          }

          const toolCtx = this.createToolContext(jobId, step.id, signal);
          try {
            const isChain = job.workflow === 'chain';
            const resolvedInput = isChain
              ? resolveChainParams(
                  (step.toolInput ?? {}) as Record<string, unknown>,
                  prevStepOutput,
                  job.context
                )
              : step.toolInput ?? step.toolInputPreview ?? {};

            const result = await tool.execute(resolvedInput, toolCtx);
            step.toolOutputPreview = result;
            prevStepOutput = result as Record<string, unknown>;
            step.status = 'succeeded';
          } catch (err) {
            step.status = 'failed';
            step.error = {
              code:
                getErrorCode(err) === 'UNKNOWN'
                  ? 'TOOL_EXECUTION_FAILED'
                  : getErrorCode(err),
              message: err instanceof Error ? err.message : String(err),
            };
            throw err;
          } finally {
            step.completedAt = new Date().toISOString();
            this.patchJob(jobId, { plan: [...steps] });
          }
        } else {
          step.status = 'succeeded';
          step.completedAt = new Date().toISOString();
          this.patchJob(jobId, { plan: [...steps] });
        }
      }

      // All steps succeeded
      this.patchJob(jobId, {
        status: 'succeeded',
        completedAt: new Date().toISOString(),
        progress: {
          currentStepIndex: steps.length,
          totalSteps: steps.length,
          percent: 100,
          label: 'Completed',
        },
      });
    } catch (err) {
      if (signal.aborted) {
        this.patchJob(jobId, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          progress: {
            ...(this.jobMap.get(jobId)?.progress ?? {
              currentStepIndex: 0,
              totalSteps: 0,
              percent: 0,
              label: '',
            }),
            label: 'Cancelled',
          },
        });
      } else {
        this.patchJob(jobId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
          error: {
            code: getErrorCode(err),
            message: err instanceof Error ? err.message : String(err),
          },
          progress: {
            ...(this.jobMap.get(jobId)?.progress ?? {
              currentStepIndex: 0,
              totalSteps: 0,
              percent: 0,
              label: '',
            }),
            label: 'Failed',
          },
        });
      }
    }
  }

  /**
   * Phase 2 planner: LLM-driven planning using CopilotClient.
   * Creates an ephemeral session, queries the model, and cleans up the session.
   */
  private async planJob(
    job: AgentJob,
    signal: AbortSignal
  ): Promise<AgentStep[]> {
    if (job.workflow && job.workflow !== 'llm_planner') {
      return this.planDeterministicJob(job);
    }

    const server = this.workspaceServerService.server;
    if (!server) {
      throw new Error('Workspace is not bound to a server');
    }
    const graphqlService = server.scope.get(GraphQLService);
    const eventSourceService = server.scope.get(EventSourceService);

    const client = new CopilotClient(
      graphqlService.gql,
      eventSourceService.eventSource
    );

    let sessionId: string | undefined;

    try {
      const history = await client.createSessionWithHistory({
        workspaceId: job.workspaceId,
        docId: job.context.sourceDocId,
        promptName: 'Chat With AFFiNE AI',
      });
      sessionId = history.sessionId;

      if (signal.aborted) throw new Error('Aborted');

      const availableTools = this.toolRegistry.list();
      const prompt = generatePlanningPrompt(job, availableTools);

      const aiModelService = server.scope.get(AIModelService);
      const modelId = aiModelService.modelId.value;

      console.log(
        `[AgentPlanner] Starting planning with model: ${modelId || 'default'}`
      );

      const stream = textToText({
        client,
        sessionId,
        modelId,
        workspaceId: job.workspaceId,
        content: prompt,
        stream: true,
        timeout: 120000, // 2 minutes
        signal,
        endpoint: Endpoint.Chat,
      }) as AsyncIterable<string>;

      let rawResponse = '';
      for await (const chunk of stream) {
        rawResponse += chunk;
      }

      if (!rawResponse || typeof rawResponse !== 'string') {
        throw new Error('Invalid response from CopilotClient');
      }

      const steps = parsePlanningResponse(rawResponse);

      // Inject job id into steps
      return steps.map(step => ({
        ...step,
        jobId: job.id,
        title: `Run ${step.toolName}`,
        description: `Execute ${step.toolName} based on user prompt`,
      }));
    } finally {
      if (sessionId) {
        client
          .cleanupSessions({
            workspaceId: job.workspaceId,
            docId: job.context.sourceDocId,
            sessionIds: [sessionId],
          })
          .catch(err => {
            console.warn(
              '[AgentPlanner] Failed to cleanup ephemeral session:',
              err
            );
          });
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────

  private planDeterministicJob(job: AgentJob): AgentStep[] {
    const prompt = job.userPrompt.trim();
    switch (job.workflow) {
      case 'fake_long_running':
        return [
          createStep(job.id, 'Running background task', 'fake.wait', {
            durationMs: 200,
          }),
          createStep(
            job.id,
            'Create background result',
            'fake.create_artifact',
            {
              title: job.title,
              content: prompt || 'Background job completed.',
            }
          ),
        ];
      case 'create_doc_from_prompt':
        return [
          createStep(
            job.id,
            'Create document from prompt',
            'affine.create_doc_from_markdown',
            {
              title: job.title || 'AI Agent Result',
              markdown: `# ${job.title || 'AI Agent Result'}\n\n${prompt}`,
            }
          ),
        ];
      case 'append_to_current_doc':
        if (!job.context.sourceDocId) {
          throw new Error(
            'Cannot append because the source document is missing.'
          );
        }
        return [
          createStep(
            job.id,
            'Append result to source document',
            'affine.append_doc_markdown',
            {
              docId: job.context.sourceDocId,
              markdown: prompt,
            }
          ),
        ];
      case 'approval_demo':
        return [
          createStep(job.id, 'Request approval', 'fake.require_approval', {
            action: prompt || 'Run approval-protected action',
          }),
        ];
      case 'background_chat': {
        if (!job.chatOptions) {
          throw new Error('background_chat job is missing chatOptions');
        }
        return [
          createStep(
            job.id,
            'Sending chat in background',
            'affine.background_chat',
            job.chatOptions
          ),
        ];
      }
      case 'chain': {
        const chain = builtinChains.find(c => c.id === job.chainId);
        if (!chain) {
          throw new Error(`Chain template not found: ${job.chainId}`);
        }
        return chain.steps.map(stepTpl =>
          createStep(
            job.id,
            stepTpl.title,
            stepTpl.toolName,
            stepTpl.params
          )
        );
      }
      default:
        return [];
    }
  }

  private createToolContext(
    jobId: string,
    stepId: string,
    signal: AbortSignal
  ): ToolExecutionContext {
    const job = this.jobMap.get(jobId);
    return {
      jobId,
      workspaceId: job?.workspaceId ?? '',
      workspace: this.workspaceService.workspace,
      docsService: this.docsService,
      docsSearchService: this.docsSearchService,
      signal,
      addLog: log => {
        const fullLog: AgentLog = {
          ...log,
          id: nextLogId(),
          jobId,
          stepId,
          createdAt: new Date().toISOString(),
        };
        const currentJob = this.jobMap.get(jobId);
        if (currentJob) {
          this.patchJob(jobId, { logs: [...currentJob.logs, fullLog] });
        }
      },
      addArtifact: artifact => {
        const fullArtifact: AgentArtifact = {
          ...artifact,
          id: nextArtifactId(),
          jobId,
          createdAt: new Date().toISOString(),
        };
        const currentJob = this.jobMap.get(jobId);
        if (currentJob) {
          this.patchJob(jobId, {
            artifacts: [...currentJob.artifacts, fullArtifact],
          });
        }
      },
      requestApproval: (request: CreateApprovalRequest) => {
        return new Promise<ApprovalDecision>(resolve => {
          const approvalReq: ApprovalRequest = {
            ...request,
            id: nextApprovalId(),
            jobId,
            stepId,
            status: 'pending',
            createdAt: new Date().toISOString(),
          };

          const currentJob = this.jobMap.get(jobId);
          if (currentJob) {
            this.patchJob(jobId, {
              status: 'waiting_approval',
              approvals: [...currentJob.approvals, approvalReq],
              progress: {
                ...currentJob.progress,
                label: 'Waiting for approval...',
              },
            });
          }

          let settled = false;
          const resolveApproval = (decision: ApprovalDecision) => {
            if (settled) {
              return;
            }
            settled = true;
            approvalReq.status =
              decision === 'approved' ? 'approved' : 'rejected';
            approvalReq.resolvedAt = new Date().toISOString();
            const latestJob = this.jobMap.get(jobId);
            if (latestJob) {
              const patch: Partial<AgentJob> = {
                approvals: [...latestJob.approvals],
              };
              if (latestJob.status !== 'cancelled' && decision === 'approved') {
                patch.status = 'running';
              }
              this.patchJob(jobId, patch);
            }
            resolve(decision);
          };

          this.approvalResolvers.set(approvalReq.id, {
            jobId,
            resolve: resolveApproval,
          });

          if (signal.aborted) {
            this.approvalResolvers.delete(approvalReq.id);
            resolveApproval('rejected');
            return;
          }

          const onAbort = () => {
            this.approvalResolvers.delete(approvalReq.id);
            resolveApproval('rejected');
          };
          signal.addEventListener('abort', onAbort, { once: true });
        });
      },
    };
  }

  private patchJob(jobId: string, patch: Partial<AgentJob>): void {
    const job = this.jobMap.get(jobId);
    if (!job) return;

    const updated = { ...job, ...patch, updatedAt: new Date().toISOString() };
    this.jobMap.set(jobId, updated);

    // Sync emission for terminal or critical user-interactive states
    const isTerminal =
      patch.status &&
      [
        'succeeded',
        'failed',
        'cancelled',
        'waiting_approval',
        'paused',
        'interrupted',
      ].includes(patch.status);
    this.emitJobs(!!isTerminal);

    // Persist to IndexedDB
    this.jobStore.saveJob(updated);
  }

  private emitJobs(sync = false): void {
    if (sync) {
      if (this.emitTimeout) {
        clearTimeout(this.emitTimeout);
        this.emitTimeout = null;
      }
      this.jobs$.next(this.listJobs());
      return;
    }

    if (this.emitTimeout) return;

    this.emitTimeout = setTimeout(() => {
      this.emitTimeout = null;
      this.jobs$.next(this.listJobs());
    }, 80);
  }

  override dispose(): void {
    if (this.emitTimeout) {
      clearTimeout(this.emitTimeout);
      this.emitTimeout = null;
    }
    this.networkMonitor.dispose();
    this.networkWaiters.clear();
    this.queue.dispose();
    this.approvalResolvers.clear();
    super.dispose();
  }
}

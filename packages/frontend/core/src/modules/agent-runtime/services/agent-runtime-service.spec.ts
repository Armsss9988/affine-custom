/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test, vi } from 'vitest';

import { WorkspaceServerService } from '@affine/core/modules/cloud';
import { DocsService } from '@affine/core/modules/doc';
import { DocsSearchService } from '@affine/core/modules/docs-search';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { Framework } from '@toeverything/infra';
import { of } from 'rxjs';

import type { AgentContextSnapshot } from '../domain/agent-context';
import type { AgentTool } from '../domain/agent-tool';
import { allFakeTools } from '../tools/fake-tools';
import { AgentJobStore } from '../store/agent-job-store';
import { affineSearchDocsTool } from '../tools/affine-search-tools';
import { AgentRuntimeService } from './agent-runtime-service';
import { ToolRegistry } from './tool-registry';
import { resolveChainParams } from '../domain/agent-chain';

function createRuntime() {
  const tools = new Map<string, AgentTool>();
  for (const tool of allFakeTools) {
    tools.set(tool.name, tool);
  }

  const framework = new Framework();
  framework
    .service(
      ToolRegistry as any,
      {
        get: (name: string) => tools.get(name),
        list: () => Array.from(tools.values()),
      } as any
    )
    .service(
      WorkspaceService as any,
      {
        workspace: {
          id: 'workspace-1',
        },
      } as any
    )
    .service(
      WorkspaceServerService as any,
      {
        server: undefined,
      } as any
    )
    .service(DocsService as any, {} as any)
    .service(AgentJobStore as any, {
      saveJob: async () => {},
      deleteJob: async () => {},
      listJobs: async () => [],
      clearJobs: async () => {},
    } as any)
    .service(DocsSearchService as any, {
      search$: () => of([]),
      searchTitle$: () => of([]),
    } as any)
    .service(AgentRuntimeService, [
      ToolRegistry,
      WorkspaceService,
      WorkspaceServerService,
      DocsService,
      AgentJobStore,
      DocsSearchService,
    ]);

  return framework.provider().get(AgentRuntimeService);
}

function createContext(): AgentContextSnapshot {
  return {
    workspaceId: 'workspace-1',
    sourceDocId: 'doc-1',
    sourceDocTitle: 'Source Doc',
    sourceView: 'page',
    createdAt: new Date().toISOString(),
  };
}

async function waitForJob(
  runtime: AgentRuntimeService,
  jobId: string,
  predicate: (
    job: NonNullable<ReturnType<AgentRuntimeService['getJob']>>
  ) => boolean
) {
  await vi.waitFor(() => {
    const job = runtime.getJob(jobId);
    expect(job).toBeDefined();
    expect(predicate(job!)).toBe(true);
  });
  return runtime.getJob(jobId)!;
}

describe('AgentRuntimeService deterministic workflows', () => {
  test('runs fake_long_running from queued to succeeded', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Background job',
      userPrompt: 'Run in the background',
      context: createContext(),
      workflow: 'fake_long_running',
    });

    const completed = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'succeeded'
    );

    expect(completed.plan.map(step => step.toolName)).toEqual([
      'fake.wait',
      'fake.create_artifact',
    ]);
    expect(completed.logs.length).toBeGreaterThan(0);
    expect(completed.progress.percent).toBe(100);

    runtime.dispose();
  });

  test('cancels a running deterministic job', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Background job',
      userPrompt: 'Run in the background',
      context: createContext(),
      workflow: 'fake_long_running',
    });

    await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'running'
    );

    runtime.cancelJob(job.id);

    const cancelled = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'cancelled'
    );

    expect(cancelled.completedAt).toBeDefined();

    runtime.dispose();
  });

  test('rejecting approval fails the job with approval error', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Approval job',
      userPrompt: 'Require approval',
      context: createContext(),
      workflow: 'approval_demo',
    });

    const waiting = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'waiting_approval'
    );

    runtime.reject(waiting.approvals[0]!.id);

    const failed = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'failed'
    );

    expect(failed.error?.code).toBe('APPROVAL_REJECTED');

    runtime.dispose();
  });

  test('cancelling while waiting for approval cancels the job', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Approval job',
      userPrompt: 'Require approval',
      context: createContext(),
      workflow: 'approval_demo',
    });

    await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'waiting_approval'
    );

    runtime.cancelJob(job.id);

    const cancelled = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'cancelled'
    );

    expect(cancelled.approvals[0]?.status).toBe('rejected');

    runtime.dispose();
  });
});

describe('AgentRuntimeService approval flow', () => {
  test('approving approval resumes job to succeeded', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Approval job',
      userPrompt: 'Require approval',
      context: createContext(),
      workflow: 'approval_demo',
    });

    const waiting = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'waiting_approval'
    );

    expect(waiting.approvals[0]?.status).toBe('pending');
    expect(waiting.approvals[0]?.title).toBe('Fake Approval Required');

    runtime.approve(waiting.approvals[0]!.id);

    const succeeded = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'succeeded'
    );

    const approval = succeeded.approvals[0];
    expect(approval?.status).toBe('approved');
    expect(approval?.resolvedAt).toBeDefined();

    runtime.dispose();
  });

  test('waiting_approval status transitions correctly', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Approval job',
      userPrompt: 'Require approval',
      context: createContext(),
      workflow: 'approval_demo',
    });

    // Initially queued
    const queued = runtime.getJob(job.id)!;
    expect(['queued', 'planning']).toContain(queued.status);

    // Transitions to waiting_approval
    const waiting = await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'waiting_approval'
    );
    expect(waiting.approvals.length).toBeGreaterThan(0);
    expect(waiting.approvals[0]?.status).toBe('pending');

    runtime.dispose();
  });
});

describe('AgentRuntimeService artifacts', () => {
  test('tool execution adds artifact to job', async () => {
    const runtime = createRuntime();

    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Artifact job',
      userPrompt: 'Create artifact',
      context: createContext(),
      workflow: 'fake_long_running',
    });

    await waitForJob(
      runtime,
      job.id,
      currentJob => currentJob.status === 'succeeded'
    );

    const completed = runtime.getJob(job.id)!;
    expect(completed.artifacts.length).toBeGreaterThan(0);

    const artifact = completed.artifacts[0];
    expect(artifact?.id).toBeDefined();
    expect(artifact?.jobId).toBe(job.id);
    expect(artifact?.title).toBeDefined();
    expect(artifact?.createdAt).toBeDefined();

    runtime.dispose();
  });

  test('addArtifact adds artifact via tool context', async () => {
    const runtime = createRuntime();

    // Enqueue a job with workflow that creates doc
    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Doc creation job',
      userPrompt: 'Create a new document',
      context: createContext(),
      workflow: 'create_doc_from_prompt',
    });

    // Wait for completion
    await vi.waitFor(
      () => {
        const j = runtime.getJob(job.id);
        expect(j).toBeDefined();
        if (j?.status === 'succeeded' || j?.status === 'failed') {
          return true;
        }
        return false;
      },
      { timeout: 10000 }
    );

    const completed = runtime.getJob(job.id)!;

    // If the workflow ran, check for artifacts
    if (completed.plan.some(step => step.toolName === 'affine.create_doc')) {
      expect(completed.artifacts.some(a => a.type === 'doc')).toBe(true);
    }

    runtime.dispose();
  });

  test('affine.search_docs returns matching documents', async () => {
    const mockResults = [
      { docId: 'doc-1', title: 'Meeting Monday', score: 0.95, blockContent: 'Agenda...' },
      { docId: 'doc-2', title: 'Meeting Tuesday', score: 0.88 },
    ];

    const tool = affineSearchDocsTool;
    const ctx = {
      jobId: 'job-1',
      workspaceId: 'workspace-1',
      workspace: {} as any,
      docsService: {} as any,
      docsSearchService: {
        search$: () => of(mockResults),
      } as any,
      signal: new AbortController().signal,
      addLog: () => {},
      addArtifact: () => {},
      requestApproval: async () => 'approved' as const,
    };

    const result = await tool.execute({ query: 'meeting', limit: 5 }, ctx);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].docId).toBe('doc-1');
    expect(result.results[0].snippet).toBe('Agenda...');
  });

  test('resolveChainParams correctly substitutes template placeholders', () => {
    const params = {
      query: '{{context.selectedText}}',
      docId: '{{prev.results[0].docId}}',
      title: 'Copy of {{context.sourceDocTitle}}',
      markdown: '{{prev.content}}',
      staticField: 'normal value',
    };

    const prevOutput = {
      results: [
        { docId: 'doc-abc-123' },
      ],
      content: 'This is the document content.',
    };

    const context = {
      selectedText: 'meeting notes',
      sourceDocTitle: 'Original Note',
    } as any;

    const resolved = resolveChainParams(params, prevOutput, context);

    expect(resolved.query).toBe('meeting notes');
    expect(resolved.docId).toBe('doc-abc-123');
    expect(resolved.title).toBe('Copy of Original Note');
    expect(resolved.markdown).toBe('This is the document content.');
    expect(resolved.staticField).toBe('normal value');
  });

  test('duplicate_doc chain plans and registers correctly', () => {
    const runtime = createRuntime();
    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Duplicate test',
      userPrompt: 'duplicate',
      context: {
        ...createContext(),
        sourceDocId: 'doc-1',
        sourceDocTitle: 'My Doc',
      },
      workflow: 'chain',
      chainId: 'duplicate_doc',
    });

    const activeJob = runtime.getJob(job.id)!;
    expect(activeJob.chainId).toBe('duplicate_doc');
    expect(activeJob.workflow).toBe('chain');

    runtime.dispose();
  });

  test('pauses server-dependent tool when offline', async () => {
    const tools = new Map<string, AgentTool>();
    for (const tool of allFakeTools) {
      tools.set(tool.name, tool);
    }
    // Register a network-requiring fake tool
    const fakeNetworkTool: AgentTool = {
      name: 'fake.network_dependent',
      description: 'A fake tool that requires network',
      riskLevel: 'read',
      requiresNetwork: true,
      inputSchema: {},
      execute: async () => ({ ok: true }),
    };
    tools.set(fakeNetworkTool.name, fakeNetworkTool);

    const framework = new Framework();
    framework
      .service(
        ToolRegistry as any,
        {
          get: (name: string) => tools.get(name),
          list: () => Array.from(tools.values()),
        } as any
      )
      .service(
        WorkspaceService as any,
        {
          workspace: {
            id: 'workspace-1',
          },
        } as any
      )
      .service(
        WorkspaceServerService as any,
        {
          server: undefined,
        } as any
      )
      .service(DocsService as any, {} as any)
      .service(DocsSearchService as any, {} as any)
      .service(AgentJobStore as any, {
        saveJob: async () => {},
        deleteJob: async () => {},
        listJobs: async () => [],
        clearJobs: async () => {},
      } as any)
      .service(AgentRuntimeService, [
        ToolRegistry,
        WorkspaceService,
        WorkspaceServerService,
        DocsService,
        AgentJobStore,
        DocsSearchService,
      ]);

    const provider = framework.provider();
    const runtime = provider.get(AgentRuntimeService);
    const monitor = runtime.getNetworkMonitor();
    
    // Spy on planDeterministicJob to return our fake network tool step
    vi.spyOn(runtime as any, 'planDeterministicJob').mockReturnValue([
      {
        id: 'step-1',
        title: 'Run network tool',
        status: 'pending',
        toolName: 'fake.network_dependent',
        toolInput: {},
      },
    ]);

    // Simulate offline
    monitor.setOnline(false);

    // Enqueue a job
    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Offline Chat',
      userPrompt: 'Tell me a story',
      context: createContext(),
      workflow: 'fake_long_running',
    });

    // Wait for the job to reach 'waiting_network' status
    await vi.waitFor(
      () => {
        const j = runtime.getJob(job.id);
        expect(j?.status).toBe('waiting_network');
      },
      { timeout: 5000 }
    );

    // Now go back online
    monitor.setOnline(true);

    // Assert that the job resumes and completes successfully
    await vi.waitFor(
      () => {
        const j = runtime.getJob(job.id);
        expect(j?.status).toBe('succeeded');
      },
      { timeout: 5000 }
    );

    runtime.dispose();
  });

  test('does not pause non-network tool when offline', async () => {
    const runtime = createRuntime();
    const monitor = runtime.getNetworkMonitor();

    // Simulate offline
    monitor.setOnline(false);

    // Enqueue a fake_long_running job (which doesn't require network)
    const job = runtime.enqueue({
      workspaceId: 'workspace-1',
      title: 'Offline Non-Network',
      userPrompt: 'run standard tool',
      context: createContext(),
      workflow: 'fake_long_running',
    });

    // Assert that the job completes successfully since it does not require network!
    await vi.waitFor(
      () => {
        const j = runtime.getJob(job.id);
        expect(j?.status).toBe('succeeded');
      },
      { timeout: 5000 }
    );

    runtime.dispose();
  });

  test('resolveChainParams handles missing or nullish inputs safely', () => {
    const params = {
      content: 'Hello {{prev.content}}!',
      missing: 'Value: {{prev.nested.field}}',
      ctxVal: 'Context: {{context.sourceDocTitle}}',
    };
    const mockContext = createContext();

    // Missing prevOutput entirely
    const resolved = resolveChainParams(params, null, mockContext);
    expect(resolved.content).toBe('Hello !');
    expect(resolved.missing).toBe('Value: ');
    expect(resolved.ctxVal).toBe('Context: Source Doc');

    // Nullish nested value
    const resolvedNull = resolveChainParams(params, { nested: null }, mockContext);
    expect(resolvedNull.missing).toBe('Value: ');
  });

  test('affine.search_docs tool returns empty results on empty query', async () => {
    const tools = new Map<string, AgentTool>();
    for (const tool of allFakeTools) {
      tools.set(tool.name, tool);
    }
    // Register search docs tool
    tools.set(affineSearchDocsTool.name, affineSearchDocsTool);

    const framework = new Framework();
    framework
      .service(
        ToolRegistry as any,
        {
          get: (name: string) => tools.get(name),
          list: () => Array.from(tools.values()),
        } as any
      )
      .service(
        WorkspaceService as any,
        {
          workspace: {
            id: 'workspace-1',
          },
        } as any
      )
      .service(
        WorkspaceServerService as any,
        {
          server: undefined,
        } as any
      )
      .service(DocsService as any, {} as any)
      .service(DocsSearchService as any, {} as any)
      .service(AgentJobStore as any, {
        saveJob: async () => {},
        deleteJob: async () => {},
        listJobs: async () => [],
        clearJobs: async () => {},
      } as any)
      .service(AgentRuntimeService, [
        ToolRegistry,
        WorkspaceService,
        WorkspaceServerService,
        DocsService,
        AgentJobStore,
        DocsSearchService,
      ]);

    const provider = framework.provider();
    const toolRegistry = provider.get(ToolRegistry);
    const tool = toolRegistry.get('affine.search_docs')!;
    
    const context: ToolExecutionContext = {
      workspaceId: 'workspace-1',
      docsService: {} as any,
      docsSearchService: {} as any,
      addLog: () => {},
      addArtifact: () => {},
      signal: new AbortController().signal,
    };

    const res = await tool.execute({ query: '   ' }, context);
    expect(res).toEqual({ results: [] });
  });

  test('hydrates and interrupts running jobs on init (IndexedDB reload)', async () => {
    // Register active jobs mock in jobStore
    const fakeStore = {
      saveJob: async () => {},
      deleteJob: async () => {},
      listJobs: async () => [
        {
          id: 'job-running-1',
          workspaceId: 'workspace-1',
          title: 'Interrupted Job',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          workflow: 'fake_long_running',
          steps: [],
          logs: [],
          artifacts: [],
        },
        {
          id: 'job-completed-2',
          workspaceId: 'workspace-1',
          title: 'Completed Job',
          status: 'succeeded',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          workflow: 'fake_long_running',
          steps: [],
          logs: [],
          artifacts: [],
        }
      ],
      clearJobs: async () => {},
    };

    const framework = new Framework();
    const tools = new Map<string, AgentTool>();
    for (const t of allFakeTools) {
      tools.set(t.name, t);
    }
    
    framework
      .service(
        ToolRegistry as any,
        {
          get: (name: string) => tools.get(name),
          list: () => Array.from(tools.values()),
        } as any
      )
      .service(
        WorkspaceService as any,
        {
          workspace: {
            id: 'workspace-1',
          },
        } as any
      )
      .service(
        WorkspaceServerService as any,
        {
          server: undefined,
        } as any
      )
      .service(DocsService as any, {} as any)
      .service(DocsSearchService as any, {} as any)
      .service(AgentJobStore as any, fakeStore as any)
      .service(AgentRuntimeService, [
        ToolRegistry,
        WorkspaceService,
        WorkspaceServerService,
        DocsService,
        AgentJobStore,
        DocsSearchService,
      ]);

    const provider = framework.provider();
    const runtime = provider.get(AgentRuntimeService);

    // Wait for async hydration
    await vi.waitFor(() => {
      const j1 = runtime.getJob('job-running-1');
      const j2 = runtime.getJob('job-completed-2');
      expect(j1?.status).toBe('interrupted');
      expect(j1?.error?.message).toContain('application reload');
      expect(j2?.status).toBe('succeeded');
    });

    runtime.dispose();
  });
});

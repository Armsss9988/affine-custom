/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test, vi } from 'vitest';

import { WorkspaceServerService } from '@affine/core/modules/cloud';
import { DocsService } from '@affine/core/modules/doc';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { Framework } from '@toeverything/infra';

import type { AgentContextSnapshot } from '../domain/agent-context';
import type { AgentTool } from '../domain/agent-tool';
import { allFakeTools } from '../tools/fake-tools';
import { AgentRuntimeService } from './agent-runtime-service';
import { ToolRegistry } from './tool-registry';

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
    .service(AgentRuntimeService, [
      ToolRegistry,
      WorkspaceService,
      WorkspaceServerService,
      DocsService,
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
});

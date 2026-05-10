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

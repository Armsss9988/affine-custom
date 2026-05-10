import type { AgentTool, ToolExecutionContext } from '../domain/agent-tool';

/**
 * Fake tool that waits for a specified duration. Useful for testing job lifecycle.
 */
export const fakeWaitTool: AgentTool<
  { durationMs: number },
  { waited: number }
> = {
  name: 'fake.wait',
  description: 'Waits for a specified duration (testing only)',
  riskLevel: 'read',
  inputSchema: { durationMs: 'number' },
  async execute(input, ctx: ToolExecutionContext) {
    const { durationMs } = input;
    const steps = 10;
    const stepDuration = durationMs / steps;

    for (let i = 0; i < steps; i++) {
      if (ctx.signal.aborted) {
        throw new Error('Cancelled');
      }
      ctx.addLog({
        level: 'info',
        message: `Waiting... ${Math.round(((i + 1) / steps) * 100)}%`,
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stepDuration);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
          },
          { once: true }
        );
      });
    }

    return { waited: durationMs };
  },
};

/**
 * Fake tool that creates a text artifact.
 */
export const fakeCreateArtifactTool: AgentTool<
  { title: string; content: string },
  { artifactId: string }
> = {
  name: 'fake.create_artifact',
  description: 'Creates a fake text artifact (testing only)',
  riskLevel: 'create',
  inputSchema: { title: 'string', content: 'string' },
  async execute(input, ctx: ToolExecutionContext) {
    const artifactId = `artifact-${Date.now()}`;
    ctx.addLog({
      level: 'info',
      message: `Creating artifact: ${input.title}`,
    });
    // Add artifact to job (mirrors real tool behavior)
    ctx.addArtifact({
      type: 'text',
      title: input.title,
      content: input.content,
    });
    return { artifactId };
  },
};

/**
 * Fake tool that always fails. Used to test error handling.
 */
export const fakeFailTool: AgentTool<{ message?: string }, never> = {
  name: 'fake.fail',
  description: 'Always throws an error (testing only)',
  riskLevel: 'read',
  inputSchema: { message: 'string?' },
  async execute(input) {
    throw new Error(input.message ?? 'Intentional failure from fake.fail tool');
  },
};

/**
 * Fake tool that requires user approval before proceeding.
 */
export const fakeRequireApprovalTool: AgentTool<
  { action: string },
  { approved: boolean }
> = {
  name: 'fake.require_approval',
  description: 'Requires approval before proceeding (testing only)',
  riskLevel: 'modify',
  inputSchema: { action: 'string' },
  async execute(input, ctx: ToolExecutionContext) {
    const decision = await ctx.requestApproval({
      title: 'Fake Approval Required',
      description: `The agent wants to: ${input.action}`,
      riskLevel: 'modify',
      proposedAction: {
        toolName: 'fake.require_approval',
        input,
        summary: input.action,
      },
    });

    if (decision === 'rejected') {
      const error = new Error('Approval rejected') as Error & {
        code: 'APPROVAL_REJECTED';
      };
      error.code = 'APPROVAL_REJECTED';
      throw error;
    }

    return { approved: true };
  },
};

/**
 * All fake tools for easy registration.
 */
export const allFakeTools: AgentTool[] = [
  fakeWaitTool,
  fakeCreateArtifactTool,
  fakeFailTool,
  fakeRequireApprovalTool,
];

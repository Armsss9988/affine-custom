import { AIProvider } from '@affine/core/blocksuite/ai/provider';
import type { AIToolsConfig } from '@affine/core/modules/ai-button';
import type { BackgroundChatOptions } from '../domain/agent-job';
import type { AgentTool, ToolExecutionContext } from '../domain/agent-tool';

/**
 * Streams a chat response to an existing Copilot session.
 * The server automatically persists the assistant message when the stream completes.
 * This tool is used by the `background_chat` workflow so the stream survives
 * when the user navigates away from the chat panel.
 */
export const affineChatTool: AgentTool<
  BackgroundChatOptions,
  { done: boolean }
> = {
  name: 'affine.background_chat',
  description:
    'Streams a chat response in the background via an existing session',
  riskLevel: 'read',
  requiresNetwork: true,
  inputSchema: {},

  async execute(input: BackgroundChatOptions, ctx: ToolExecutionContext) {
    if (!AIProvider.actions.chat) {
      throw new Error('AIProvider.actions.chat is not registered');
    }

    ctx.addLog({
      level: 'info',
      message: 'Starting background chat stream...',
    });

    let chunkCount = 0;
    const stream = await AIProvider.actions.chat({
      sessionId: input.sessionId,
      input: input.userInput,
      docId: input.docId,
      workspaceId: ctx.workspaceId,
      stream: true,
      signal: ctx.signal,
      isRootSession: input.isRootSession ?? true,
      reasoning: input.reasoning ?? false,
      modelId: input.modelId,
      contexts: {
        docs: (input.docs ?? []) as BlockSuitePresets.AIDocContextOption[],
        files: (input.files ?? []) as BlockSuitePresets.AIFileContextOption[],
      },
      toolsConfig: input.toolsConfig as AIToolsConfig | undefined,
    });

    for await (const _chunk of stream) {
      if (ctx.signal.aborted) break;
      chunkCount++;
    }

    ctx.addLog({
      level: 'info',
      message: `Chat stream completed (${chunkCount} chunks). Server has saved the response.`,
    });

    return { done: true };
  },
};

export const allChatTools: AgentTool[] = [affineChatTool];

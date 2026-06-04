import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import type { PromptMessage, PromptParams } from '../providers/types';
import {
  collectPromptMetadataNative,
  countPromptTokensNative,
  getBuiltInPromptSpecNative,
  renderBuiltInPromptNative,
  renderBuiltInPromptSessionNative,
  renderPromptNative,
  renderPromptSessionNative,
} from './native-contract';
import type { Prompt, PromptSpec, ResolvedPrompt } from './spec';

@Injectable()
export class PromptService {
  protected readonly logger = new Logger(PromptService.name);
  constructor(@Optional() protected readonly prisma?: PrismaClient) {
    this.logger.log(
      'Using native built-in prompt catalog with db-backed lookupCompatPrompt.'
    );
  }

  async get(name: string): Promise<ResolvedPrompt | null> {
    const compatPrompt = await this.lookupCompatPrompt(name);
    const builtInPromptSpec = this.lookupBuiltInPromptSpec(name);

    if (builtInPromptSpec) {
      if (compatPrompt && compatPrompt.modified) {
        return this.describeCompatPrompt(this.clonePrompt(compatPrompt));
      }
      return this.describeBuiltInPromptSpec(builtInPromptSpec);
    }

    if (compatPrompt) {
      return this.describeCompatPrompt(this.clonePrompt(compatPrompt));
    }

    return null;
  }

  finish(
    prompt: ResolvedPrompt,
    params: PromptParams,
    sessionId?: string
  ): PromptMessage[] {
    const rendered =
      prompt.source === 'built_in'
        ? renderBuiltInPromptNative({
            name: prompt.name,
            renderParams: params,
          })
        : renderPromptNative({
            messages: this.requireCompatMessages(prompt),
            templateParams: prompt.params,
            renderParams: params,
          });

    this.logWarnings(rendered.warnings, sessionId);
    return this.injectClientContext(rendered.messages, params);
  }

  renderSession(
    prompt: ResolvedPrompt,
    turns: PromptMessage[],
    params: PromptParams,
    maxTokenSize = prompt.config?.maxTokens || 128 * 1024,
    sessionId?: string
  ): PromptMessage[] {
    const rendered =
      prompt.source === 'built_in'
        ? renderBuiltInPromptSessionNative({
            name: prompt.name,
            turns,
            renderParams: params,
            maxTokenSize,
          })
        : renderPromptSessionNative({
            prompt: {
              action: prompt.action,
              model: prompt.model,
              promptTokens: this.countCompatPromptTokens(prompt),
              templateParams: prompt.params,
              messages: this.requireCompatMessages(prompt),
            },
            turns,
            renderParams: params,
            maxTokenSize,
          });

    this.logWarnings(rendered.warnings, sessionId);
    return this.injectClientContext(rendered.messages, params);
  }

  protected async lookupCompatPrompt(name: string): Promise<Prompt | null> {
    if (!this.prisma) return null;
    const prompt = await this.prisma.aiPrompt.findUnique({
      where: { name },
      include: { messages: { orderBy: { idx: 'asc' } } },
    });
    if (!prompt) return null;
    return {
      name: prompt.name,
      model: prompt.model,
      optionalModels: prompt.optionalModels,
      action: prompt.action ?? undefined,
      config: (prompt.config as any) ?? undefined,
      modified: prompt.modified,
      messages: prompt.messages.map(msg => ({
        role: msg.role.toLowerCase() as any,
        content: msg.content ?? '',
        attachments: (msg.attachments as any) ?? undefined,
        params: (msg.params as any) ?? undefined,
      })),
    };
  }

  protected lookupBuiltInPromptSpec(name: string): PromptSpec | null {
    const spec = getBuiltInPromptSpecNative(name);
    return spec ? this.clonePromptSpec(spec) : null;
  }

  protected cloneMessages(messages: PromptMessage[]) {
    return messages.map(message => ({
      ...message,
      attachments: message.attachments ? [...message.attachments] : undefined,
      params: message.params ? structuredClone(message.params) : undefined,
      responseFormat: message.responseFormat
        ? structuredClone(message.responseFormat)
        : undefined,
    }));
  }

  protected clonePrompt(prompt: Prompt): Prompt {
    return {
      ...prompt,
      optionalModels: prompt.optionalModels
        ? [...prompt.optionalModels]
        : undefined,
      config: prompt.config ? structuredClone(prompt.config) : undefined,
      messages: this.cloneMessages(prompt.messages),
    };
  }

  protected clonePromptSpec(spec: PromptSpec): PromptSpec {
    return {
      ...spec,
      optionalModels: spec.optionalModels
        ? [...spec.optionalModels]
        : undefined,
      config: spec.config ? structuredClone(spec.config) : undefined,
      params: spec.params ? structuredClone(spec.params) : undefined,
      messages: spec.messages.map(message => ({ ...message })),
    };
  }

  private describeBuiltInPromptSpec(spec: PromptSpec): ResolvedPrompt {
    const params = this.normalizePromptSpecParams(spec.params);
    return {
      name: spec.name,
      action: spec.action,
      model: spec.model,
      optionalModels: spec.optionalModels ?? [],
      config: spec.config ? structuredClone(spec.config) : undefined,
      paramKeys: Object.keys(params),
      params,
      source: 'built_in',
    };
  }

  private describeCompatPrompt(prompt: Prompt): ResolvedPrompt {
    const metadata = collectPromptMetadataNative({ messages: prompt.messages });
    return {
      name: prompt.name,
      action: prompt.action,
      model: prompt.model,
      optionalModels: prompt.optionalModels ?? [],
      config: prompt.config ? structuredClone(prompt.config) : undefined,
      paramKeys: metadata.paramKeys,
      params: metadata.templateParams,
      source: 'compat',
      messages: prompt.messages,
    };
  }

  private normalizePromptSpecParams(
    params?: PromptSpec['params']
  ): PromptParams {
    if (!params) return {};

    return Object.fromEntries(
      Object.entries(params).map(([key, value]) => {
        if (value.enum?.length) {
          const normalized = value.default
            ? [
                value.default,
                ...value.enum.filter(option => option !== value.default),
              ]
            : [...value.enum];
          return [key, normalized];
        }

        return [key, value.default ?? ''];
      })
    );
  }

  private countCompatPromptTokens(prompt: ResolvedPrompt): number {
    return countPromptTokensNative({
      model: prompt.model,
      messages: this.requireCompatMessages(prompt).map(message => ({
        content: message.content,
      })),
    }).tokens;
  }

  private requireCompatMessages(prompt: ResolvedPrompt): PromptMessage[] {
    if (prompt.source === 'compat' && prompt.messages) {
      return this.cloneMessages(prompt.messages);
    }

    throw new Error(`Prompt ${prompt.name} does not expose compat messages`);
  }

  private logWarnings(warnings: string[], sessionId?: string) {
    if (!sessionId) {
      return;
    }

    for (const warning of warnings) {
      this.logger.warn(`${warning} in session ${sessionId}`);
    }
  }

  private injectClientContext(
    messages: PromptMessage[],
    params: PromptParams
  ): PromptMessage[] {
    if (!params || !params.clientContext) {
      return messages;
    }

    const ctx = params.clientContext as any;
    const currentRoute = ctx.currentRoute ?? 'unknown';
    const allDocsCount = ctx.allDocsCount ?? 0;
    const platform = ctx.platform ?? 'web';
    const isMac = !!ctx.isMac;
    const isMobile = !!ctx.isMobile;
    const selectMode = !!ctx.selectMode;

    const contextBlock = `

---
### USER CLIENT SIDE CONTEXT (THÔNG TIN NGỮ CẢNH CỦA NGƯỜI DÙNG)
- Current Route/URL Path: ${currentRoute}
- Total Documents in Workspace: ${allDocsCount}
- Client Platform: ${platform}
- Operating System: ${isMac ? 'macOS' : 'Windows/Linux/Other'}
- Device Type: ${isMobile ? 'Mobile' : 'Desktop/Tablet'}
- Selection/Checkbox Mode Active: ${selectMode ? 'Yes' : 'No'}

### ASSISTANT INSTRUCTIONS FOR CLIENT CONTEXT
Use the above "USER CLIENT SIDE CONTEXT" to provide highly relevant and context-aware responses:
1. If the user asks about selecting multiple documents, check if "Selection/Checkbox Mode Active" is "Yes".
   - If it is "No" (false), explain that they can enable selection/checkbox mode by clicking the checkbox icon (multiselect button) at the top of the document list (in the sub-header) or by right-clicking any document in the list to reveal the context menu.
   - If it is "Yes" (true), explain that checkboxes are already active next to each document. They can check the documents they want and use the bulk action bar at the bottom to delete or export.
2. If explaining keyboard shortcuts:
   - If the user's OS is macOS, prioritize macOS shortcut keys: Command (⌘) and Option (⌥) (e.g. ⌘+K for search, ⌘+/ for AI, ⌘+N for new page).
   - If the user's OS is Windows/Linux/Other, prioritize standard keyboard shortcuts: Ctrl and Alt (e.g. Ctrl+K, Ctrl+/, Ctrl+N).
3. If they ask about creating pages or templates:
   - Mention that they currently have ${allDocsCount} documents in their workspace.
   - If their current view is a doc or all-page, tailor references accordingly.
4. Respond in the same language as the user (e.g. if the user asks in Vietnamese, respond in Vietnamese).
`;

    // Try to find the system message and append the context
    const systemMessage = messages.find(msg => msg.role === 'system');
    if (systemMessage) {
      systemMessage.content = (systemMessage.content ?? '') + contextBlock;
    } else {
      // If there's no system message, we can prepend a new one
      messages.unshift({
        role: 'system',
        content: contextBlock,
      });
    }

    return messages;
  }
}

import { Service } from '@toeverything/infra';

import type { AgentTool, ToolRiskLevel } from '../domain/agent-tool';
import { allChatTools } from '../tools/affine-chat-tools';
import { allDocTools } from '../tools/affine-doc-tools';
import { allFakeTools } from '../tools/fake-tools';

/**
 * Central registry for all agent tools.
 * Tools are registered at module init and looked up at runtime by name.
 */
export class ToolRegistry extends Service {
  private readonly tools = new Map<string, AgentTool>();

  constructor() {
    super();
    for (const tool of allFakeTools) {
      this.register(tool);
    }
    for (const tool of allDocTools) {
      this.register(tool);
    }
    for (const tool of allChatTools) {
      this.register(tool);
    }
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  listByRisk(risk: ToolRiskLevel): AgentTool[] {
    return this.list().filter(t => t.riskLevel === risk);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}

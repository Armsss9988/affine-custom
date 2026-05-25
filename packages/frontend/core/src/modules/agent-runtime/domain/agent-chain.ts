export interface ChainStepTemplate {
  toolName: string;
  title: string;
  description?: string;
  /** 
   * Input params. Values can contain {{prev.fieldName}} to reference
   * the previous step's output, or {{context.fieldName}} for job context.
   */
  params: Record<string, unknown>;
  /** If true, requires user approval before executing */
  requiresApproval?: boolean;
}

export interface ChainTemplate {
  id: string;
  name: string;
  description: string;
  /** Icon emoji for UI */
  icon: string;
  steps: ChainStepTemplate[];
  /** Required context fields for this chain */
  requiredContext?: ('sourceDocId' | 'selectedText')[];
}

/**
 * Helper function to deep substitute string placeholders.
 */
function substitute(
  val: any,
  prevOutput: Record<string, unknown> | null,
  context: import('./agent-context').AgentContextSnapshot
): any {
  if (typeof val === 'string') {
    return val
      .replace(/\{\{prev\.([\w\.\[\]]+)\}\}/g, (_, path) => {
        // Resolve nested paths like results[0].docId or simple keys
        return getNestedValue(prevOutput, path);
      })
      .replace(/\{\{context\.([\w\.\[\]]+)\}\}/g, (_, path) => {
        return getNestedValue(context, path);
      });
  }
  if (Array.isArray(val)) {
    return val.map(item => substitute(item, prevOutput, context));
  }
  if (val !== null && typeof val === 'object') {
    const resolvedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      resolvedObj[k] = substitute(v, prevOutput, context);
    }
    return resolvedObj;
  }
  return val;
}

function getNestedValue(obj: any, path: string): string {
  if (!obj) return '';
  const parts = path.replace(/\]/g, '').split(/[\.\[]/);
  let curr = obj;
  for (const part of parts) {
    if (curr == null) return '';
    curr = curr[part];
  }
  return curr != null ? String(curr) : '';
}

/**
 * Resolves {{prev.xxx}} and {{context.xxx}} placeholders in params.
 */
export function resolveChainParams(
  params: Record<string, unknown>,
  prevOutput: Record<string, unknown> | null,
  context: import('./agent-context').AgentContextSnapshot
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    resolved[key] = substitute(value, prevOutput, context);
  }
  return resolved;
}

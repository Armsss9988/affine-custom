import type { AgentJob } from './agent-job';
import type { AgentTool } from './agent-tool';

export function generatePlanningPrompt(
  job: AgentJob,
  tools: AgentTool[]
): string {
  const toolsDescription = tools
    .map(
      tool => `
Tool: ${tool.name}
Description: ${tool.description}
`
    )
    .join('\n');

  return `You are AFFiNE Agent, an autonomous AI assistant operating within the AFFiNE workspace.
Your task is to analyze the user's prompt and create a detailed execution plan consisting of sequential steps.

Available Context:
- Workspace ID: ${job.context.workspaceId}
- Current Document ID: ${job.context.sourceDocId || 'None'}
- Current Document Title: ${job.context.sourceDocTitle || 'None'}

Available Tools:
${toolsDescription}

User Prompt: "${job.userPrompt}"

Instructions:
1. Break down the user's request into logical, sequential steps.
2. For each step, select the most appropriate tool from the "Available Tools" list.
3. You MUST output your plan as a raw JSON array of objects. Do not include any markdown formatting (like \`\`\`json) or conversational text.
4. Each step object MUST have the following schema:
   {
     "toolName": "string", // Must be exactly one of the tool names provided above
     "params": { ... } // An object containing any parameters the tool might need (you can infer from context or leave empty if not needed)
   }

Example output:
[
  {
    "toolName": "affine.read_doc",
    "params": {}
  },
  {
    "toolName": "affine.create_doc",
    "params": { "title": "Summary" }
  }
]

Start your response with the JSON array now:`;
}

export function parsePlanningResponse(response: string) {
  try {
    const start = response.indexOf('[');
    const end = response.lastIndexOf(']');
    if (start === -1 || end === -1) {
      // Try parsing the whole thing if no brackets found (legacy behavior)
      const cleanJson = response
        .replace(/^```json\s*/, '')
        .replace(/```\s*$/, '')
        .trim();
      const parsed = JSON.parse(cleanJson);
      return processParsedPlan(parsed);
    }

    const jsonStr = response.substring(start, end + 1);
    const parsed = JSON.parse(jsonStr);
    return processParsedPlan(parsed);
  } catch (error) {
    console.error('Failed to parse Agent Planner response:', error, response);
    throw new Error('Failed to generate a valid plan from the LLM.');
  }
}

function processParsedPlan(parsed: any) {
  if (!Array.isArray(parsed)) {
    throw new Error('Response is not a JSON array');
  }

  return parsed.map((step, index) => {
    if (!step.toolName) {
      throw new Error(`Step ${index} is missing toolName`);
    }
    return {
      id: crypto.randomUUID(),
      toolName: step.toolName,
      toolInput: step.params || {},
      toolInputPreview: step.params || {},
      status: 'pending' as const,
    };
  });
}

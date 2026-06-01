import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

type RunPromptText = (
  promptName: string,
  params: Record<string, unknown>
) => Promise<string>;

const logger = new Logger('CodeArtifactTool');
/**
 * A copilot tool that produces a completely self-contained HTML artifact.
 * The returned HTML must include <style> and <script> tags directly so that
 * it can be saved as a single .html file and opened in any browser with no
 * external dependencies.
 */
export const createCodeArtifactTool = (prompt: RunPromptText) => {
  return defineTool({
    description:
      'Generate an interactive visual dashboard, webpage mockup, or standalone single-page visual utility in a single HTML file (with Tailwind CSS, inline <style>, and <script>). ONLY use this tool when the user explicitly requests a visual application, user interface (UI), interactive page, or web dashboard mockup. DO NOT use this tool for writing generic backend scripts, python programs, command-line utilities, or snippets of programming code (like a sorting algorithm or simple utility function). For generic code, return it as standard markdown text code blocks.',
    inputSchema: z.object({
      /**
       * The <title> text that will appear in the browser tab.
       */
      title: z.string().describe('The title of the HTML page'),
      /**
       * The optimized user prompt
       */
      userPrompt: z
        .string()
        .describe(
          'The user description of the code artifact, will be used to generate the code artifact'
        ),
    }),
    execute: async ({ title, userPrompt }) => {
      try {
        const content = await prompt('Code Artifact', { content: userPrompt });
        // Remove surrounding ``` or ```html fences if present
        let stripped = content.trim();
        if (stripped.startsWith('```')) {
          const firstNewline = stripped.indexOf('\n');
          if (firstNewline !== -1) {
            stripped = stripped.slice(firstNewline + 1);
          }
          if (stripped.endsWith('```')) {
            stripped = stripped.slice(0, -3);
          }
        }
        return {
          title,
          html: stripped,
          size: stripped.length,
        };
      } catch (err: any) {
        logger.error(`Failed to compose code artifact (${title})`, err);
        return toolError('Code Artifact Failed', err.message ?? String(err));
      }
    },
  });
};

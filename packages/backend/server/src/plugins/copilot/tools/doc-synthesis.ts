import { z } from 'zod';

import type { PromptMessage } from '../providers/types';
import type { ToolError } from './error';
import { toolError } from './error';
import { defineTool } from './tool';

type DocContentGetterResult = {
  docId: string;
  title: string;
  markdown: string;
  [key: string]: unknown;
};

type DocContentGetter = (
  docId?: string
) => Promise<ToolError | DocContentGetterResult>;

type RunPromptText = (
  promptName: string,
  params: Record<string, unknown>,
  options?: { appendMessages?: PromptMessage[] }
) => Promise<string>;

export const createDocSynthesisTool = (
  getDocContent: DocContentGetter,
  runPromptText: RunPromptText
) => {
  return defineTool({
    description:
      'Read multiple documents from the workspace and synthesize a cross-document analysis. Can compare documents, extract common themes, create timelines, or generate comprehensive summaries across multiple sources. Use this when the user asks to compare, synthesize, or analyze multiple documents together.',
    inputSchema: z.object({
      docIds: z
        .array(z.string())
        .min(2)
        .max(10)
        .describe('IDs of the documents to synthesize (2-10 documents)'),
      focusQuery: z
        .string()
        .optional()
        .describe('Specific question or topic to focus the synthesis on'),
      outputFormat: z
        .enum(['summary', 'comparison', 'timeline', 'themes'])
        .optional()
        .describe(
          'Output format: summary (default), comparison (side-by-side), timeline (chronological), themes (thematic grouping)'
        ),
    }),
    execute: async ({ docIds, focusQuery, outputFormat = 'summary' }) => {
      try {
        // Read all documents
        const docs = await Promise.all(
          docIds.map(async id => {
            try {
              const result = await getDocContent(id);
              if ('type' in result && result.type === 'error') {
                return {
                  id,
                  title: 'Not Found',
                  markdown: '',
                  error: `Document ${id}: ${(result as ToolError).message}`,
                };
              }
              const doc = result as DocContentGetterResult;
              return {
                id: doc.docId,
                title: doc.title,
                markdown: doc.markdown,
                error: null,
              };
            } catch {
              return {
                id,
                title: 'Not Found',
                markdown: '',
                error: `Document ${id} not found or inaccessible`,
              };
            }
          })
        );

        const foundDocs = docs.filter(d => !d.error);
        const notFoundDocs = docs.filter(d => d.error);

        if (foundDocs.length < 2) {
          return toolError(
            'Document Synthesis Failed',
            `Need at least 2 readable documents. Found ${foundDocs.length}. Errors: ${notFoundDocs.map(d => d.error).join('; ')}`
          );
        }

        // Build document content for synthesis
        const docContents = foundDocs
          .map((doc, i) => {
            // Truncate each doc to ~15000 chars to fit in context
            const content =
              doc.markdown.length > 15000
                ? doc.markdown.slice(0, 15000) + '\n[... content truncated ...]'
                : doc.markdown;
            return `=== DOCUMENT ${i + 1}: "${doc.title}" (ID: ${doc.id}) ===\n${content}\n`;
          })
          .join('\n');

        const formatInstructions: Record<string, string> = {
          summary:
            'Create a comprehensive synthesis that integrates the key ideas, findings, and arguments from all documents. Highlight agreements, contradictions, and complementary information.',
          comparison:
            'Create a structured comparison of the documents. For each major topic or aspect, show how each document addresses it. Use a clear structure with headers for each comparison point.',
          timeline:
            'Extract all date-referenced events, developments, and milestones from the documents and organize them chronologically. Create a clear timeline showing the progression of events.',
          themes:
            'Identify the major themes that appear across the documents. For each theme, synthesize what the documents collectively say about it, noting where they agree or differ.',
        };

        const focusInstr = focusQuery
          ? `\nFocus specifically on: ${focusQuery}`
          : '';

        const prompt = `You are analyzing ${foundDocs.length} documents. ${formatInstructions[outputFormat]}${focusInstr}\n\n${docContents}`;

        const synthesis = await runPromptText(
          'chat:general',
          {},
          {
            appendMessages: [
              {
                role: 'user',
                content: prompt,
              },
            ],
          }
        );

        return {
          synthesis,
          outputFormat,
          documentsAnalyzed: foundDocs.map(d => ({
            id: d.id,
            title: d.title,
          })),
          documentsNotFound: notFoundDocs.map(d => ({
            id: d.id,
            error: d.error,
          })),
          focusQuery: focusQuery || null,
        };
      } catch (e: any) {
        return toolError('Document Synthesis Failed', e.message);
      }
    },
  });
};

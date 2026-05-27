import { z } from 'zod';

import type { PromptMessage } from '../providers/types';
import { toolError } from './error';
import { defineTool } from './tool';

type RunPromptText = (
  promptName: string,
  params: Record<string, unknown>,
  options?: { appendMessages?: PromptMessage[] }
) => Promise<string>;

export const createTranslateTextTool = (runPromptText: RunPromptText) => {
  return defineTool({
    description:
      'Translate text between languages. Supports all major languages including English, Vietnamese, Chinese, Japanese, Korean, French, German, Spanish, etc. Preserves markdown formatting by default. Use this when the user asks to translate text, documents, or passages.',
    inputSchema: z.object({
      text: z.string().describe('The text to translate'),
      targetLanguage: z
        .string()
        .describe(
          'The target language to translate to, e.g. "English", "Vietnamese", "Chinese", "Japanese", "Korean", "French"'
        ),
      sourceLanguage: z
        .string()
        .optional()
        .describe('The source language. Leave empty to auto-detect.'),
      preserveFormatting: z
        .boolean()
        .optional()
        .describe(
          'Whether to preserve markdown formatting in the translation. Default: true'
        ),
    }),
    execute: async ({
      text,
      targetLanguage,
      sourceLanguage,
      preserveFormatting = true,
    }) => {
      try {
        const fromLang = sourceLanguage ? ` from ${sourceLanguage}` : '';
        const formatInstruction = preserveFormatting
          ? ' Preserve all markdown formatting, code blocks, links, and structure.'
          : '';

        const prompt = `Translate the following text${fromLang} to ${targetLanguage}.${formatInstruction} Only output the translated text, nothing else.`;

        const result = await runPromptText(
          'chat:general',
          {},
          {
            appendMessages: [
              {
                role: 'user',
                content: `${prompt}\n\n---\n\n${text}`,
              },
            ],
          }
        );

        return {
          originalText: text.length > 200 ? text.slice(0, 200) + '...' : text,
          translatedText: result,
          targetLanguage,
          sourceLanguage: sourceLanguage || 'auto-detected',
        };
      } catch (e: any) {
        return toolError('Translation Failed', e.message);
      }
    },
  });
};

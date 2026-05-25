import type { AgentTool, ToolExecutionContext } from '../domain/agent-tool';
import { firstValueFrom, timeout } from 'rxjs';

export interface SearchDocsInput {
  query: string;
  limit?: number;
}

export interface SearchDocsOutput {
  results: Array<{
    docId: string;
    title: string;
    score: number;
    snippet?: string;
  }>;
}

/**
 * Searches workspace documents by keyword using the local indexer.
 * Works offline — uses the same index as Quick Search.
 */
export const affineSearchDocsTool: AgentTool<SearchDocsInput, SearchDocsOutput> = {
  name: 'affine.search_docs',
  description:
    'Searches workspace documents by keyword. Returns matching doc IDs, titles, relevance scores, and content snippets. Use this to find documents before reading them.',
  riskLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query keywords' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['query'],
  },

  async execute(input: SearchDocsInput, ctx: ToolExecutionContext) {
    const { query, limit = 10 } = input;

    if (!query.trim()) {
      return { results: [] };
    }

    ctx.addLog({
      level: 'info',
      message: `Searching workspace for: "${query}" (limit: ${limit})`,
    });

    const docsSearchService = ctx.docsSearchService;
    if (!docsSearchService) {
      throw new Error('DocsSearchService not available in tool context');
    }

    const results = await firstValueFrom(
      docsSearchService.search$(query).pipe(
        timeout(10000) // 10s timeout
      )
    );

    const trimmed = results.slice(0, limit).map(r => ({
      docId: r.docId,
      title: r.title,
      score: r.score,
      snippet: r.blockContent || undefined,
    }));

    ctx.addLog({
      level: 'info',
      message: `Found ${trimmed.length} document(s) matching "${query}"`,
    });

    return { results: trimmed };
  },
};

export const allSearchTools: AgentTool[] = [affineSearchDocsTool];

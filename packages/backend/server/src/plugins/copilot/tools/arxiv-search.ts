import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

export const createArxivSearchTool = () => {
  return defineTool({
    description:
      'Search arXiv for preprints and research papers. Returns titles, authors, abstracts, arXiv IDs, categories, and PDF links. Use this when the user asks about preprints, recent research, or arXiv papers.',
    inputSchema: z.object({
      query: z.string().describe('Search query for arXiv papers'),
      category: z
        .string()
        .optional()
        .describe(
          'arXiv category filter, e.g. cs.AI, cs.CL, cs.LG, math.CO, physics.hep-th, stat.ML'
        ),
      maxResults: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Maximum number of results. Default: 10'),
      sortBy: z
        .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
        .optional()
        .describe('Sort order. Default: relevance'),
    }),
    execute: async ({
      query,
      category,
      maxResults = 10,
      sortBy = 'relevance',
    }) => {
      try {
        let searchQuery = `all:${query}`;
        if (category) {
          searchQuery = `cat:${category} AND all:${query}`;
        }

        const params = new URLSearchParams({
          search_query: searchQuery,
          start: '0',
          max_results: String(maxResults),
          sortBy,
          sortOrder: 'descending',
        });

        const res = await fetch(`http://export.arxiv.org/api/query?${params}`);
        if (!res.ok) throw new Error(`arXiv API returned ${res.status}`);
        const xml = await res.text();
        return parseArxivXml(xml);
      } catch (e: any) {
        return toolError('arXiv Search Failed', e.message);
      }
    },
  });
};

function parseArxivXml(xml: string) {
  const entries: any[] = [];
  const entryRegex = /<entry>(.*?)<\/entry>/gs;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[1];
    const getTag = (tag: string) => {
      const m = entry.match(new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 's'));
      return m ? m[1].trim() : '';
    };

    // Extract authors
    const authors: string[] = [];
    const authorRegex = /<author>\s*<name>(.*?)<\/name>/g;
    let authorMatch;
    while ((authorMatch = authorRegex.exec(entry)) !== null) {
      authors.push(authorMatch[1].trim());
    }

    // Extract categories
    const categories: string[] = [];
    const catRegex = /<category[^>]*term="([^"]*)"/g;
    let catMatch;
    while ((catMatch = catRegex.exec(entry)) !== null) {
      categories.push(catMatch[1]);
    }

    // Extract PDF link
    const pdfMatch = entry.match(/<link[^>]*title="pdf"[^>]*href="([^"]*)"/);
    const pdfUrl = pdfMatch ? pdfMatch[1] : '';

    const id = getTag('id');
    const arxivId = id.replace('http://arxiv.org/abs/', '');

    entries.push({
      title: getTag('title').replace(/\s+/g, ' '),
      authors: authors.join(', '),
      abstract: getTag('summary').replace(/\s+/g, ' '),
      arxivId,
      categories,
      pdfUrl: pdfUrl || `https://arxiv.org/pdf/${arxivId}`,
      url: `https://arxiv.org/abs/${arxivId}`,
      published: getTag('published'),
      updated: getTag('updated'),
      comment: getTag('comment') || null,
    });
  }
  return entries;
}

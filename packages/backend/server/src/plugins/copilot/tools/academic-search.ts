import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

export const createAcademicSearchTool = () => {
  return defineTool({
    description:
      'Search for academic research papers, journal articles, and scientific publications. Returns paper titles, authors, abstracts, citation counts, DOIs, and open access PDF links. Use this when the user asks about research papers, scientific studies, or academic literature.',
    inputSchema: z.object({
      query: z.string().describe('Search query for academic papers'),
      source: z
        .enum(['semanticScholar', 'crossref'])
        .optional()
        .describe('Which database to search. Default: semanticScholar'),
      limit: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of results to return. Default: 10'),
      year: z
        .string()
        .optional()
        .describe('Filter by year range, e.g. "2020-2024" or "2023"'),
      fieldsOfStudy: z
        .array(z.string())
        .optional()
        .describe(
          'Filter by field of study: Computer Science, Medicine, Biology, Physics, etc.'
        ),
    }),
    execute: async ({
      query,
      source = 'semanticScholar',
      limit = 10,
      year,
      fieldsOfStudy,
    }) => {
      try {
        if (source === 'crossref') {
          return await searchCrossRef(query, limit, year);
        }
        return await searchSemanticScholar(query, limit, year, fieldsOfStudy);
      } catch (e: any) {
        // Fallback to CrossRef if Semantic Scholar fails
        if (source === 'semanticScholar') {
          try {
            return await searchCrossRef(query, limit, year);
          } catch (fallbackError: any) {
            return toolError(
              'Academic Search Failed',
              `Primary: ${e.message}, Fallback: ${fallbackError.message}`
            );
          }
        }
        return toolError('Academic Search Failed', e.message);
      }
    },
  });
};

async function searchSemanticScholar(
  query: string,
  limit: number,
  year?: string,
  fieldsOfStudy?: string[]
) {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    fields:
      'title,authors,year,abstract,citationCount,url,venue,externalIds,isOpenAccess,openAccessPdf',
  });
  if (year) params.set('year', year);
  if (fieldsOfStudy?.length)
    params.set('fieldsOfStudy', fieldsOfStudy.join(','));

  const res = await fetch(
    `https://api.semanticscholar.org/graph/v1/paper/search?${params}`,
    {
      headers: { 'User-Agent': 'AFFiNE-Research-Assistant/1.0' },
    }
  );
  if (!res.ok) throw new Error(`Semantic Scholar API returned ${res.status}`);
  const data = (await res.json()) as any;
  return (data.data || []).map((paper: any) => ({
    title: paper.title,
    authors: (paper.authors || []).map((a: any) => a.name).join(', '),
    year: paper.year,
    abstract: paper.abstract || '',
    citationCount: paper.citationCount || 0,
    doi: paper.externalIds?.DOI || null,
    url: paper.url,
    venue: paper.venue || '',
    pdfUrl: paper.openAccessPdf?.url || null,
    isOpenAccess: paper.isOpenAccess || false,
  }));
}

async function searchCrossRef(query: string, limit: number, year?: string) {
  const params = new URLSearchParams({
    query,
    rows: String(limit),
    select:
      'DOI,title,author,published-print,abstract,is-referenced-by-count,container-title,link',
  });
  if (year) {
    const [from, to] = year.includes('-') ? year.split('-') : [year, year];
    params.set('filter', `from-pub-date:${from},until-pub-date:${to}`);
  }

  const res = await fetch(`https://api.crossref.org/works?${params}`, {
    headers: {
      'User-Agent': 'AFFiNE-Research-Assistant/1.0 (mailto:support@affine.pro)',
    },
  });
  if (!res.ok) throw new Error(`CrossRef API returned ${res.status}`);
  const data = (await res.json()) as any;
  return (data.message?.items || []).map((item: any) => ({
    title: Array.isArray(item.title) ? item.title[0] : item.title || '',
    authors: (item.author || [])
      .map((a: any) => `${a.given || ''} ${a.family || ''}`.trim())
      .join(', '),
    year: item['published-print']?.['date-parts']?.[0]?.[0] || null,
    abstract: (item.abstract || '').replace(/<[^>]*>/g, ''),
    citationCount: item['is-referenced-by-count'] || 0,
    doi: item.DOI,
    url: `https://doi.org/${item.DOI}`,
    venue: Array.isArray(item['container-title'])
      ? item['container-title'][0]
      : item['container-title'] || '',
    pdfUrl: item.link?.[0]?.URL || null,
    isOpenAccess: false,
  }));
}

import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

export const createWikipediaSearchTool = () => {
  return defineTool({
    description:
      'Search and read Wikipedia articles. Can search for articles by topic or read the full content of a specific article. Supports multiple languages. Use this when the user asks about general knowledge, definitions, historical facts, or wants information from Wikipedia.',
    inputSchema: z.object({
      query: z.string().describe('Search query or article title'),
      action: z
        .enum(['search', 'read'])
        .optional()
        .describe(
          'search = find matching articles, read = get full article content. Default: search'
        ),
      language: z
        .string()
        .optional()
        .describe(
          'Wikipedia language code, e.g. "en", "vi", "zh", "ja", "ko", "fr", "de". Default: "en"'
        ),
    }),
    execute: async ({ query, action = 'search', language = 'en' }) => {
      try {
        const baseUrl = `https://${language}.wikipedia.org`;

        if (action === 'read') {
          return await readWikipediaArticle(baseUrl, query);
        }
        return await searchWikipedia(baseUrl, query);
      } catch (e: any) {
        return toolError('Wikipedia Search Failed', e.message);
      }
    },
  });
};

async function searchWikipedia(baseUrl: string, query: string) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '10',
    format: 'json',
    origin: '*',
  });

  const res = await fetch(`${baseUrl}/w/api.php?${params}`, {
    headers: { 'User-Agent': 'AFFiNE-Research-Assistant/1.0' },
  });
  if (!res.ok) throw new Error(`Wikipedia API returned ${res.status}`);
  const data = (await res.json()) as any;

  return (data.query?.search || []).map((item: any) => ({
    title: item.title,
    snippet: (item.snippet || '').replace(/<[^>]*>/g, ''),
    pageId: item.pageid,
    wordCount: item.wordcount || 0,
    url: `${baseUrl}/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
  }));
}

async function readWikipediaArticle(baseUrl: string, title: string) {
  const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));

  // Get summary first for a clean abstract
  let summary = '';
  try {
    const summaryRes = await fetch(
      `${baseUrl}/api/rest_v1/page/summary/${encodedTitle}`,
      {
        headers: {
          'User-Agent': 'AFFiNE-Research-Assistant/1.0',
        },
      }
    );
    if (summaryRes.ok) {
      const summaryData = (await summaryRes.json()) as any;
      summary = summaryData.extract || '';
    }
  } catch {
    // summary is optional
  }

  // Get full article HTML
  const res = await fetch(`${baseUrl}/api/rest_v1/page/html/${encodedTitle}`, {
    headers: {
      'User-Agent': 'AFFiNE-Research-Assistant/1.0',
      Accept: 'text/html',
    },
  });

  if (!res.ok) {
    if (res.status === 404) {
      // Try search instead
      const searchResults = await searchWikipedia(baseUrl, title);
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        return await readWikipediaArticle(baseUrl, searchResults[0].title);
      }
      throw new Error(`Article "${title}" not found`);
    }
    throw new Error(`Wikipedia API returned ${res.status}`);
  }

  const html = await res.text();
  const content = wikiHtmlToText(html);

  return {
    title,
    summary,
    content: content.slice(0, 80000),
    url: `${baseUrl}/wiki/${encodedTitle}`,
    contentLength: content.length,
  };
}

function wikiHtmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<sup[^>]*class="reference"[\s\S]*?<\/sup>/gi, '')
    .replace(/<span[^>]*class="mw-editsection"[\s\S]*?<\/span>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  text = text
    .replace(
      /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi,
      (_: string, level: string, c: string) => {
        return (
          '\n' +
          '#'.repeat(Number(level)) +
          ' ' +
          c.replace(/<[^>]*>/g, '').trim() +
          '\n'
        );
      }
    )
    .replace(/<p[^>]*>(.*?)<\/p>/gi, (_: string, c: string) => '\n' + c + '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '$2')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*');

  text = text.replace(/<[^>]*>/g, '');
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text;
}

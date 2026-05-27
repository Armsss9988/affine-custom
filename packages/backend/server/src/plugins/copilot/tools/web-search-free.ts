import { z } from 'zod';

import { Config } from '../../../base';
import { toolError } from './error';
import { defineTool } from './tool';

export const createFreeWebSearchTool = (_config: Config) => {
  return defineTool({
    description:
      'Search the web for current information using a free search engine. Returns web page titles, URLs, and snippets. Use this when the user asks about current events, needs to look something up online, or when web search is needed.',
    inputSchema: z.object({
      query: z.string().describe('The search query'),
      numResults: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe('Number of results to return. Default: 10'),
    }),
    execute: async ({ query, numResults = 10 }) => {
      try {
        // Try SearXNG first if configured
        const searxngUrl = process.env.AFFINE_SEARXNG_URL;
        if (searxngUrl) {
          return await searchSearXNG(searxngUrl, query, numResults);
        }

        // Fallback: DuckDuckGo
        return await searchDuckDuckGo(query, numResults);
      } catch (e: any) {
        return toolError('Web Search Failed', e.message);
      }
    },
  });
};

async function searchSearXNG(
  baseUrl: string,
  query: string,
  numResults: number
) {
  const url = new URL('/search', baseUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'general');

  const res = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'AFFiNE-Research-Assistant/1.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);
  const data = (await res.json()) as any;

  return (data.results || []).slice(0, numResults).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    content: r.content || '',
    engine: r.engine || 'searxng',
    publishedDate: r.publishedDate || null,
  }));
}

async function searchDuckDuckGo(query: string, numResults: number) {
  // Use DuckDuckGo Lite (HTML version)
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; AFFiNE-Research-Bot/1.0)',
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();

  // Parse results from DuckDuckGo Lite HTML
  const results: Array<{
    title: string;
    url: string;
    content: string;
    engine: string;
  }> = [];

  const linkRegex =
    /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({
      url: linkMatch[1],
      title: linkMatch[2].replace(/<[^>]*>/g, '').trim(),
    });
  }

  const snippets: string[] = [];
  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').trim());
  }

  // If DDG Lite parsing fails, try instant answer API
  if (links.length === 0) {
    return await searchDuckDuckGoInstant(query, numResults);
  }

  for (let i = 0; i < Math.min(links.length, numResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      content: snippets[i] || '',
      engine: 'duckduckgo',
    });
  }

  return results;
}

async function searchDuckDuckGoInstant(query: string, numResults: number) {
  // DDG Instant Answer API (limited but free)
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
    {
      headers: {
        'User-Agent': 'AFFiNE-Research-Assistant/1.0',
      },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`DuckDuckGo API returned ${res.status}`);
  const data = (await res.json()) as any;

  const results: Array<{
    title: string;
    url: string;
    content: string;
    engine: string;
  }> = [];

  // Abstract result
  if (data.Abstract) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || '',
      content: data.Abstract,
      engine: 'duckduckgo',
    });
  }

  // Related topics
  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics.slice(
      0,
      numResults - results.length
    )) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] || '',
          url: topic.FirstURL,
          content: topic.Text,
          engine: 'duckduckgo',
        });
      }
    }
  }

  return results;
}

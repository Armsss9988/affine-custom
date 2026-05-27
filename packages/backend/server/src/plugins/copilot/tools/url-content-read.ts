import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

export const createUrlContentReadTool = () => {
  return defineTool({
    description:
      'Fetch and read the content of any web page URL. Extracts clean text content from HTML pages, removing navigation, ads, and scripts. Returns the page title, clean content in markdown format, and metadata. Use this when the user provides a URL and wants to read or analyze its content.',
    inputSchema: z.object({
      url: z
        .string()
        .describe('The URL to read (including http:// or https://)'),
      maxLength: z
        .number()
        .optional()
        .describe(
          'Maximum characters to extract from the page. Default: 50000'
        ),
    }),
    execute: async ({ url, maxLength = 50000 }) => {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; AFFiNE-Research-Bot/1.0)',
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

        const contentType = res.headers.get('content-type') || '';
        const html = await res.text();

        if (contentType.includes('application/json')) {
          const content = html.slice(0, maxLength);
          return {
            title: url,
            url,
            content,
            contentType: 'json',
            wordCount: content.split(/\s+/).length,
          };
        }

        if (contentType.includes('text/plain')) {
          const content = html.slice(0, maxLength);
          return {
            title: url,
            url,
            content,
            contentType: 'text',
            wordCount: content.split(/\s+/).length,
          };
        }

        // Extract from HTML
        const title = extractHtmlTag(html, 'title') || url;
        const content = htmlToCleanText(html, maxLength);
        const author = extractMeta(html, 'author');
        const description = extractMeta(html, 'description');
        const publishedDate =
          extractMeta(html, 'article:published_time') ||
          extractMeta(html, 'date') ||
          null;

        return {
          title,
          url,
          description,
          author: author || null,
          publishedDate,
          content,
          contentType: 'html',
          wordCount: content.split(/\s+/).length,
        };
      } catch (e: any) {
        return toolError('URL Content Read Failed', e.message);
      }
    },
  });
};

function extractHtmlTag(html: string, tag: string): string {
  const match = html.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  );
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : '';
}

function extractMeta(html: string, name: string): string {
  const match =
    html.match(
      new RegExp(
        `<meta[^>]*(?:name|property)=["'](?:og:)?${name}["'][^>]*content=["']([^"']*)["']`,
        'i'
      )
    ) ||
    html.match(
      new RegExp(
        `<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:)?${name}["']`,
        'i'
      )
    );
  return match ? match[1].trim() : '';
}

function htmlToCleanText(html: string, maxLength: number): string {
  // Remove unwanted elements
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Try to extract main content areas
  const mainMatch = text.match(
    /<(?:main|article)[\s\S]*?>([\s\S]*?)<\/(?:main|article)>/i
  );
  if (mainMatch) {
    text = mainMatch[1];
  }

  // Convert common HTML to markdown-like text
  text = text
    .replace(
      /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi,
      (_: string, level: string, content: string) => {
        return (
          '\n' +
          '#'.repeat(Number(level)) +
          ' ' +
          content.replace(/<[^>]*>/g, '').trim() +
          '\n'
        );
      }
    )
    .replace(
      /<p[^>]*>(.*?)<\/p>/gi,
      (_: string, content: string) => '\n' + content + '\n'
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n');

  // Remove remaining HTML tags
  text = text.replace(/<[^>]*>/g, '');

  // Clean up whitespace and HTML entities
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text.slice(0, maxLength);
}

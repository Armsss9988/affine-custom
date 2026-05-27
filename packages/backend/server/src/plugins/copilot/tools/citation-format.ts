import { z } from 'zod';

import { toolError } from './error';
import { defineTool } from './tool';

export const createCitationFormatTool = () => {
  return defineTool({
    description:
      'Look up a research paper by DOI or title and format it as a proper citation in various styles (APA, MLA, Chicago, BibTeX, IEEE, Harvard, Vancouver). Also generates BibTeX entries. Use this when the user asks to cite a paper, format a reference, or create a bibliography.',
    inputSchema: z.object({
      doi: z
        .string()
        .optional()
        .describe('DOI of the paper to cite, e.g. "10.1145/3442188.3445922"'),
      title: z
        .string()
        .optional()
        .describe('Paper title to search for if DOI is not known'),
      style: z
        .enum([
          'apa',
          'mla',
          'chicago',
          'bibtex',
          'ieee',
          'harvard',
          'vancouver',
        ])
        .optional()
        .describe('Citation style format. Default: apa'),
      multiple: z
        .array(z.string())
        .optional()
        .describe('Multiple DOIs to format as a bibliography'),
    }),
    execute: async ({ doi, title, style = 'apa', multiple }) => {
      try {
        if (multiple?.length) {
          const citations = await Promise.all(
            multiple.map(d => formatSingleCitation(d, style))
          );
          return {
            bibliography: citations
              .filter(c => !c.error)
              .map(c => c.formatted)
              .join('\n\n'),
            entries: citations,
          };
        }

        if (doi) {
          return await formatSingleCitation(doi, style);
        }

        if (title) {
          // Search CrossRef for DOI by title
          const searchRes = await fetch(
            `https://api.crossref.org/works?query=${encodeURIComponent(title)}&rows=1`,
            {
              headers: {
                'User-Agent':
                  'AFFiNE-Research-Assistant/1.0 (mailto:support@affine.pro)',
              },
            }
          );
          if (!searchRes.ok)
            throw new Error(`CrossRef search returned ${searchRes.status}`);
          const searchData = (await searchRes.json()) as any;
          const foundDoi = searchData.message?.items?.[0]?.DOI;
          if (!foundDoi) {
            return toolError(
              'Citation Format Failed',
              `No paper found matching title: "${title}"`
            );
          }
          return await formatSingleCitation(foundDoi, style);
        }

        return toolError(
          'Citation Format Failed',
          'Please provide either a DOI or a paper title'
        );
      } catch (e: any) {
        return toolError('Citation Format Failed', e.message);
      }
    },
  });
};

async function formatSingleCitation(doi: string, style: string) {
  // Fetch CSL-JSON metadata from DOI
  const res = await fetch(`https://doi.org/${doi}`, {
    headers: {
      Accept: 'application/vnd.citationstyles.csl+json',
      'User-Agent': 'AFFiNE-Research-Assistant/1.0',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    return {
      doi,
      error: `DOI resolution failed: ${res.status}`,
      formatted: '',
    };
  }
  const meta = (await res.json()) as any;

  const authors = (meta.author || []).map((a: any) => ({
    given: a.given || '',
    family: a.family || '',
  }));

  const year =
    meta.issued?.['date-parts']?.[0]?.[0] ||
    meta.published?.['date-parts']?.[0]?.[0] ||
    meta['published-print']?.['date-parts']?.[0]?.[0] ||
    'n.d.';

  const title = Array.isArray(meta.title) ? meta.title[0] : meta.title || '';
  const journal = Array.isArray(meta['container-title'])
    ? meta['container-title'][0]
    : meta['container-title'] || '';
  const volume = meta.volume || '';
  const issue = meta.issue || '';
  const pages = meta.page || '';

  let formatted = '';

  switch (style) {
    case 'apa': {
      const authorStr = authors
        .map((a: any) => `${a.family}, ${a.given.charAt(0)}.`)
        .join(', ');
      formatted = `${authorStr} (${year}). ${title}. *${journal}*${volume ? `, *${volume}*` : ''}${issue ? `(${issue})` : ''}${pages ? `, ${pages}` : ''}. https://doi.org/${doi}`;
      break;
    }
    case 'mla': {
      const authorStr =
        authors.length > 0
          ? `${authors[0].family}, ${authors[0].given}` +
            (authors.length > 1 ? ', et al' : '')
          : '';
      formatted = `${authorStr}. "${title}." *${journal}*${volume ? ` ${volume}` : ''}${issue ? `.${issue}` : ''} (${year})${pages ? `: ${pages}` : ''}.`;
      break;
    }
    case 'chicago': {
      const authorStr = authors
        .map((a: any) => `${a.family}, ${a.given}`)
        .join(', ');
      formatted = `${authorStr}. "${title}." *${journal}* ${volume}${issue ? `, no. ${issue}` : ''} (${year})${pages ? `: ${pages}` : ''}.`;
      break;
    }
    case 'ieee': {
      const authorStr = authors
        .map((a: any) => `${a.given.charAt(0)}. ${a.family}`)
        .join(', ');
      formatted = `${authorStr}, "${title}," *${journal}*, vol. ${volume}${issue ? `, no. ${issue}` : ''}${pages ? `, pp. ${pages}` : ''}, ${year}.`;
      break;
    }
    case 'harvard': {
      const authorStr = authors
        .map((a: any) => `${a.family}, ${a.given.charAt(0)}.`)
        .join(', ');
      formatted = `${authorStr} (${year}) '${title}', *${journal}*${volume ? `, ${volume}` : ''}${issue ? `(${issue})` : ''}${pages ? `, pp. ${pages}` : ''}.`;
      break;
    }
    case 'vancouver': {
      const authorStr = authors
        .map((a: any) => `${a.family} ${a.given.charAt(0)}`)
        .join(', ');
      formatted = `${authorStr}. ${title}. ${journal}. ${year}${volume ? `;${volume}` : ''}${issue ? `(${issue})` : ''}${pages ? `:${pages}` : ''}.`;
      break;
    }
    case 'bibtex': {
      const key = `${authors[0]?.family?.toLowerCase() || 'unknown'}${year}`;
      const authorStr = authors
        .map((a: any) => `${a.family}, ${a.given}`)
        .join(' and ');
      formatted = `@article{${key},
  title = {${title}},
  author = {${authorStr}},
  journal = {${journal}},
  year = {${year}},
  volume = {${volume}},
  number = {${issue}},
  pages = {${pages}},
  doi = {${doi}}
}`;
      break;
    }
  }

  return {
    doi,
    title,
    authors: authors.map((a: any) => `${a.given} ${a.family}`),
    year,
    journal,
    volume,
    issue,
    pages,
    formatted,
    style,
    url: `https://doi.org/${doi}`,
  };
}

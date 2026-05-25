import type { ChainTemplate } from '../domain/agent-chain';

export const searchAndSummarizeChain: ChainTemplate = {
  id: 'search_and_summarize',
  name: 'Search & Summarize',
  description: 'Search for documents by keyword, read the top result, and create a summary doc',
  icon: '🔍',
  steps: [
    {
      toolName: 'affine.search_docs',
      title: 'Search workspace',
      params: { query: '{{context.selectedText}}', limit: 3 },
    },
    {
      toolName: 'affine.read_doc',
      title: 'Read top result',
      params: { docId: '{{prev.results[0].docId}}' },
    },
    {
      toolName: 'affine.create_doc_from_markdown',
      title: 'Create summary',
      params: {
        title: 'Summary',
        markdown: '{{prev.content}}',
      },
    },
  ],
  requiredContext: ['selectedText'],
};

export const duplicateDocChain: ChainTemplate = {
  id: 'duplicate_doc',
  name: 'Duplicate Document',
  description: 'Read the current document and create a copy',
  icon: '📋',
  steps: [
    {
      toolName: 'affine.read_doc',
      title: 'Read source document',
      params: { docId: '{{context.sourceDocId}}' },
    },
    {
      toolName: 'affine.create_doc_from_markdown',
      title: 'Create duplicate',
      params: {
        title: 'Copy of {{context.sourceDocTitle}}',
        markdown: '{{prev.content}}',
      },
    },
  ],
  requiredContext: ['sourceDocId'],
};

export const builtinChains: ChainTemplate[] = [
  searchAndSummarizeChain,
  duplicateDocChain,
];

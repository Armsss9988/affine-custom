import { insertFromMarkdown } from '@affine/core/blocksuite/utils/markdown-utils';
import {
  MarkdownAdapter,
  titleMiddleware,
} from '@blocksuite/affine/shared/adapters';

import type { AgentTool, ToolExecutionContext } from '../domain/agent-tool';

/**
 * Reads a document's content and returns it as Markdown.
 */
export const affineReadDocTool: AgentTool<
  { docId: string },
  { content: string }
> = {
  name: 'affine.read_doc',
  description: 'Reads an AFFiNE document and returns its content as Markdown',
  riskLevel: 'read',
  inputSchema: { docId: 'string' },
  async execute(input, ctx: ToolExecutionContext) {
    const { doc, release } = ctx.docsService.open(input.docId);
    const disposePriorityLoad = doc.addPriorityLoad(10);

    try {
      await doc.waitForSyncReady();
      disposePriorityLoad();
      const store = doc.blockSuiteDoc;
      const transformer = store.getTransformer([
        titleMiddleware(ctx.workspace.docCollection.meta.docMetas),
      ]);
      const adapter = new MarkdownAdapter(transformer, store.provider);

      const docSnapshot = transformer.docToSnapshot(store);
      if (!docSnapshot) {
        return { content: '' };
      }

      const payload = await adapter.fromDocSnapshot({
        snapshot: docSnapshot,
        assets: transformer.assetsManager,
      });

      return { content: payload.file };
    } finally {
      disposePriorityLoad();
      release();
    }
  },
};

/**
 * Creates a new document from Markdown content.
 */
export const affineCreateDocTool: AgentTool<
  { title: string; markdown: string },
  { docId: string }
> = {
  name: 'affine.create_doc_from_markdown',
  description: 'Creates a new AFFiNE document from Markdown',
  riskLevel: 'create',
  inputSchema: { title: 'string', markdown: 'string' },
  async execute(input, ctx: ToolExecutionContext) {
    const record = ctx.docsService.createDoc({
      title: input.title,
      primaryMode: 'page',
    });
    const { doc, release } = ctx.docsService.open(record.id);
    const disposePriorityLoad = doc.addPriorityLoad(10);

    try {
      await doc.waitForSyncReady();
      disposePriorityLoad();
      const noteBlock = doc.blockSuiteDoc.getBlocksByFlavour('affine:note')[0];
      if (!noteBlock) {
        throw new Error('Note block not found in created document');
      }
      await insertFromMarkdown(
        undefined,
        input.markdown,
        doc.blockSuiteDoc,
        noteBlock.id,
        0
      );

      // Add artifact for the created document
      ctx.addArtifact({
        type: 'doc',
        title: input.title,
        docId: doc.id,
      });

      return { docId: doc.id };
    } finally {
      disposePriorityLoad();
      release();
    }
  },
};

/**
 * Appends Markdown content to an existing document.
 */
export const affineAppendDocTool: AgentTool<
  { docId: string; markdown: string },
  { success: boolean }
> = {
  name: 'affine.append_doc_markdown',
  description: 'Appends Markdown content to the end of an existing document',
  riskLevel: 'append',
  inputSchema: { docId: 'string', markdown: 'string' },
  async execute(input, ctx: ToolExecutionContext) {
    const { doc, release } = ctx.docsService.open(input.docId);
    const disposePriorityLoad = doc.addPriorityLoad(10);

    try {
      await doc.waitForSyncReady();
      disposePriorityLoad();
      const noteBlock = doc.blockSuiteDoc.getBlocksByFlavour('affine:note')[0];
      if (!noteBlock) {
        throw new Error('Note block not found in document');
      }
      await insertFromMarkdown(
        undefined,
        input.markdown,
        doc.blockSuiteDoc,
        noteBlock.id
      );

      return { success: true };
    } finally {
      disposePriorityLoad();
      release();
    }
  },
};

export const affineCreateDocAliasTool: AgentTool<
  { title: string; markdown: string },
  { docId: string }
> = {
  ...affineCreateDocTool,
  name: 'affine.create_doc',
};

export const affineAppendDocAliasTool: AgentTool<
  { docId: string; markdown: string },
  { success: boolean }
> = {
  ...affineAppendDocTool,
  name: 'affine.append_doc',
};

export const allDocTools: AgentTool[] = [
  affineReadDocTool,
  affineCreateDocTool,
  affineAppendDocTool,
  affineCreateDocAliasTool,
  affineAppendDocAliasTool,
];

/**
 * Doc management tools: list, delete, restore, info.
 * These allow the AI to manage the full lifecycle of documents in the workspace.
 */
import { Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { z } from 'zod';

import { DocReader } from '../../../core/doc';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocManageTools');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parse the workspace root doc (docId = workspaceId) to get the meta.pages array.
 * Returns an array of page meta objects: { id, title, createDate, trash, trashDate, ... }
 */
function parseRootDocPages(bin: Buffer | Uint8Array): Array<{
  id: string;
  title?: string;
  createDate?: number;
  trash?: boolean;
  trashDate?: number;
  isJournal?: boolean;
  tags?: string[];
}> {
  try {
    const buf = Buffer.isBuffer(bin)
      ? bin
      : Buffer.from(
          bin.buffer,
          (bin as Uint8Array).byteOffset,
          (bin as Uint8Array).byteLength
        );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, buf);
    const meta = doc.getMap('meta');
    const pages = meta.get('pages') as Y.Array<Y.Map<unknown>> | undefined;
    if (!pages) return [];
    const result: ReturnType<typeof parseRootDocPages> = [];
    pages.forEach((page: Y.Map<unknown>) => {
      result.push({
        id: page.get('id') as string,
        title: page.get('title') as string | undefined,
        createDate: page.get('createDate') as number | undefined,
        trash: page.get('trash') as boolean | undefined,
        trashDate: page.get('trashDate') as number | undefined,
        isJournal: page.get('isJournal') as boolean | undefined,
        tags: page.get('tags') as string[] | undefined,
      });
    });
    return result;
  } catch {
    return [];
  }
}

/**
 * Push a Y.js update that sets a specific field on a page in meta.pages.
 */
function buildRootDocPageUpdate(
  existingBin: Buffer,
  docId: string,
  updates: Record<string, unknown>
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const meta = doc.getMap('meta');
  const pages = meta.get('pages') as Y.Array<Y.Map<unknown>> | undefined;
  if (!pages) throw new Error('No pages array in root doc');

  let found = false;
  pages.forEach((page: Y.Map<unknown>) => {
    if (page.get('id') === docId) {
      for (const [k, v] of Object.entries(updates)) {
        if (v === undefined || v === null) {
          page.delete(k);
        } else {
          page.set(k, v);
        }
      }
      found = true;
    }
  });

  if (!found) throw new Error(`Doc ${docId} not found in root doc pages`);
  return Y.encodeStateAsUpdate(doc);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildDocListHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, includeTrash = false) => {
    if (!options?.user || !options.workspace) {
      return toolError('Doc List Failed', 'Missing user or workspace context');
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError('Doc List Failed', 'No workspace read permission');
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Doc List Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const pages = parseRootDocPages(rootBin);
    const filtered = includeTrash ? pages : pages.filter(p => !p.trash);
    return {
      total: filtered.length,
      docs: filtered.map(p => ({
        docId: p.id,
        title: p.title || '(Untitled)',
        createdAt: p.createDate ? new Date(p.createDate).toISOString() : null,
        isJournal: !!p.isJournal,
        inTrash: !!p.trash,
      })),
    };
  };
};

export const buildDocDeleteHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, docId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Delete Failed',
        'Missing user or workspace context'
      );
    }
    const canDelete = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Delete');
    if (!canDelete) {
      return toolError(
        'Doc Delete Failed',
        `No permission to delete doc ${docId}`
      );
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Doc Delete Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const update = buildRootDocPageUpdate(rootBin, docId, {
      trash: true,
      trashDate: Date.now(),
    });
    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );
    logger.log(`Doc ${docId} moved to trash by ${options.user}`);
    return {
      success: true,
      docId,
      message: `Document moved to trash successfully`,
    };
  };
};

export const buildDocRestoreHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, docId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Doc Restore Failed',
        'Missing user or workspace context'
      );
    }
    const canUpdate = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canUpdate) {
      return toolError(
        'Doc Restore Failed',
        `No permission to restore doc ${docId}`
      );
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Doc Restore Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const update = buildRootDocPageUpdate(rootBin, docId, {
      trash: undefined,
      trashDate: undefined,
    });
    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );
    logger.log(`Doc ${docId} restored from trash by ${options.user}`);
    return {
      success: true,
      docId,
      message: `Document restored from trash successfully`,
    };
  };
};

export const buildDocInfoHandler = (
  ac: AccessController,
  docReader: DocReader,
  models: Models
) => {
  return async (options: CopilotChatOptions, docId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError('Doc Info Failed', 'Missing user or workspace context');
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Read');
    if (!canRead) {
      return toolError(
        'Doc Info Failed',
        `No read permission for doc ${docId}`
      );
    }
    const [content, authors] = await Promise.all([
      docReader.getDocMarkdown(options.workspace, docId, false),
      models.doc.getAuthors(options.workspace, docId),
    ]);
    if (!content) {
      return toolError(
        'Doc Info Failed',
        `Doc ${docId} not found or not synced`
      );
    }
    return {
      docId,
      title: content.title || '(Untitled)',
      wordCount: content.markdown?.split(/\s+/).filter(Boolean).length ?? 0,
      createdAt: authors?.createdAt?.toISOString() ?? null,
      updatedAt: authors?.updatedAt?.toISOString() ?? null,
      createdBy: authors?.createdByUser
        ? { id: authors.createdByUser.id, name: authors.createdByUser.name }
        : null,
      updatedBy: authors?.updatedByUser
        ? { id: authors.updatedByUser.id, name: authors.updatedByUser.name }
        : null,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createDocListTool = (
  listDocs: (includeTrash?: boolean) => Promise<object>
) =>
  defineTool({
    description:
      'List all documents in the workspace. Returns docId, title, createdAt, and whether the doc is in the trash or is a journal. Use this when the user asks to see all docs, find a doc by name, or browse the workspace contents.',
    inputSchema: z.object({
      include_trash: z
        .boolean()
        .optional()
        .describe(
          'If true, also list docs currently in the trash. Default: false'
        ),
    }),
    execute: async ({ include_trash }) => {
      try {
        return await listDocs(include_trash ?? false);
      } catch (err: any) {
        logger.error('Failed to list docs', err);
        return toolError('Doc List Failed', err.message);
      }
    },
  });

export const createDocDeleteTool = (
  deleteDoc: (docId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Move a document to the trash (soft delete). The document can be restored later. Use this when the user asks to delete, remove, or trash a document. Always confirm with the user before deleting.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to move to trash'),
    }),
    execute: async ({ doc_id }) => {
      try {
        return await deleteDoc(doc_id);
      } catch (err: any) {
        logger.error(`Failed to delete doc ${doc_id}`, err);
        return toolError('Doc Delete Failed', err.message);
      }
    },
  });

export const createDocRestoreTool = (
  restoreDoc: (docId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Restore a document from the trash back to the workspace. Use this when the user asks to recover or restore a deleted document.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The ID of the document to restore from trash'),
    }),
    execute: async ({ doc_id }) => {
      try {
        return await restoreDoc(doc_id);
      } catch (err: any) {
        logger.error(`Failed to restore doc ${doc_id}`, err);
        return toolError('Doc Restore Failed', err.message);
      }
    },
  });

export const createDocInfoTool = (
  getDocInfo: (docId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Get metadata and basic info about a document: title, word count, creation/update timestamps, and author information. Use this when the user asks about who created a doc, when it was last updated, or how long a doc is.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to get info about'),
    }),
    execute: async ({ doc_id }) => {
      try {
        return await getDocInfo(doc_id);
      } catch (err: any) {
        logger.error(`Failed to get doc info ${doc_id}`, err);
        return toolError('Doc Info Failed', err.message);
      }
    },
  });

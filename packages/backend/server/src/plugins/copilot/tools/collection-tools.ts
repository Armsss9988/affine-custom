import { Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { z } from 'zod';

import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { DocWriter } from '../../../core/doc/writer';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('CollectionTools');

// ─── Helpers ────────────────────────────────────────────────────────────────

interface CollectionItem {
  id: string;
  name: string;
  allowList: string[];
}

function parseCollections(bin: Buffer | Uint8Array): CollectionItem[] {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bin);
    const setting = doc.getMap('setting');
    const collections = setting.get('collections');
    if (!collections || !(collections instanceof Y.Array)) {
      return [];
    }

    return collections.map(col => {
      const toJSON = typeof col.toJSON === 'function' ? col.toJSON() : col;
      return {
        id: toJSON.id || '',
        name: toJSON.name || toJSON.title || '',
        allowList: toJSON.allowList || [],
      };
    });
  } catch (err) {
    logger.error('Failed to parse collections', err);
    return [];
  }
}

function buildCollectionUpdate(
  existingBin: Buffer,
  info: { id: string; name?: string; allowList?: string[] },
  action: 'create' | 'delete' | 'update_allow_list'
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const setting = doc.getMap('setting');
  let collections = setting.get('collections');
  if (!collections || !(collections instanceof Y.Array)) {
    collections = new Y.Array<any>();
    setting.set('collections', collections);
  }

  const collectionsArray = collections as Y.Array<any>;
  doc.transact(() => {
    if (action === 'create') {
      collectionsArray.push([{
        id: info.id,
        name: info.name || '',
        allowList: [],
        rules: { filters: [] }
      }]);
    } else if (action === 'delete') {
      for (let i = 0; i < collectionsArray.length; i++) {
        const col = collectionsArray.get(i);
        const colId = typeof col.get === 'function' ? col.get('id') : col.id;
        if (colId === info.id) {
          collectionsArray.delete(i, 1);
          break;
        }
      }
    } else if (action === 'update_allow_list') {
      for (let i = 0; i < collectionsArray.length; i++) {
        const col = collectionsArray.get(i);
        const colId = typeof col.get === 'function' ? col.get('id') : col.id;
        if (colId === info.id) {
          const colName = typeof col.get === 'function' ? col.get('name') : col.name;
          const colRules = typeof col.get === 'function' ? (typeof col.get('rules')?.toJSON === 'function' ? col.get('rules').toJSON() : col.get('rules')) : col.rules;

          collectionsArray.delete(i, 1);
          collectionsArray.insert(i, [{
            id: info.id,
            name: colName || '',
            allowList: info.allowList || [],
            rules: colRules || { filters: [] }
          }]);
          break;
        }
      }
    }
  });

  return Y.encodeStateAsUpdate(doc);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildCollectionListHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Collection List Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError(
        'Collection List Failed',
        'No workspace read permission'
      );
    }

    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return { total: 0, collections: [] };
    }
    const bin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const collections = parseCollections(bin);
    return {
      total: collections.length,
      collections,
    };
  };
};

export const buildCollectionCreateHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (options: CopilotChatOptions, name: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Collection Create Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.CreateDoc');
    if (!canAccess) {
      return toolError(
        'Collection Create Failed',
        'No workspace update permission'
      );
    }

    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError(
        'Collection Create Failed',
        'Workspace root doc not found'
      );
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const collections = parseCollections(rootBin);
    const duplicate = collections.find(
      c => c.name.toLowerCase() === name.toLowerCase()
    );
    if (duplicate) {
      return {
        success: true,
        collection: duplicate,
        message: 'Collection already exists',
      };
    }

    const collectionId = nanoid();
    const update = buildCollectionUpdate(
      rootBin,
      { id: collectionId, name },
      'create'
    );
    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: options.workspace,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      collection: { id: collectionId, name, allowList: [] },
      message: `Collection '${name}' created successfully`,
    };
  };
};

export const buildCollectionAddDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    collectionId: string,
    docId: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Collection Add Doc Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Read');
    if (!canAccess) {
      return toolError(
        'Collection Add Doc Failed',
        `No permission to read doc ${docId}`
      );
    }

    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError(
        'Collection Add Doc Failed',
        'Workspace root doc not found'
      );
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const collections = parseCollections(rootBin);
    const target = collections.find(c => c.id === collectionId);
    if (!target) {
      return toolError(
        'Collection Add Doc Failed',
        `Collection ID ${collectionId} not found`
      );
    }

    if (target.allowList.includes(docId)) {
      return { success: true, message: 'Doc already in collection' };
    }

    const newAllowList = [...target.allowList, docId];
    const update = buildCollectionUpdate(
      rootBin,
      { id: collectionId, allowList: newAllowList },
      'update_allow_list'
    );
    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: options.workspace,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      message: `Added document to collection successfully`,
    };
  };
};

export const buildCollectionRemoveDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    collectionId: string,
    docId: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Collection Remove Doc Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError(
        'Collection Remove Doc Failed',
        'No workspace read permission'
      );
    }

    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError(
        'Collection Remove Doc Failed',
        'Workspace root doc not found'
      );
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const collections = parseCollections(rootBin);
    const target = collections.find(c => c.id === collectionId);
    if (!target) {
      return toolError(
        'Collection Remove Doc Failed',
        `Collection ID ${collectionId} not found`
      );
    }

    if (!target.allowList.includes(docId)) {
      return { success: true, message: 'Doc not in collection' };
    }

    const newAllowList = target.allowList.filter(id => id !== docId);
    const update = buildCollectionUpdate(
      rootBin,
      { id: collectionId, allowList: newAllowList },
      'update_allow_list'
    );
    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: options.workspace,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      message: `Removed document from collection successfully`,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createCollectionListTool = (
  listCollections: () => Promise<object>
) =>
  defineTool({
    description: 'List all custom collections in the workspace.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await listCollections();
      } catch (err: any) {
        logger.error('Failed to list collections', err);
        return toolError('Collection List Failed', err.message);
      }
    },
  });

export const createCollectionCreateTool = (
  createCollection: (name: string) => Promise<object>
) =>
  defineTool({
    description:
      'Create a new collection. Use this when the user asks to create or add a new collection.',
    inputSchema: z.object({
      name: z.string().describe('The name of the collection to create'),
    }),
    execute: async ({ name }) => {
      try {
        return await createCollection(name);
      } catch (err: any) {
        logger.error('Failed to create collection', err);
        return toolError('Collection Create Failed', err.message);
      }
    },
  });

export const createCollectionAddDocTool = (
  addDoc: (collectionId: string, docId: string) => Promise<object>
) =>
  defineTool({
    description:
      "Add a document to a collection (adds to collection's allowList).",
    inputSchema: z.object({
      collection_id: z.string().describe('The ID of the collection'),
      doc_id: z.string().describe('The ID of the document to add'),
    }),
    execute: async ({ collection_id, doc_id }) => {
      try {
        return await addDoc(collection_id, doc_id);
      } catch (err: any) {
        logger.error(
          `Failed to add doc ${doc_id} to collection ${collection_id}`,
          err
        );
        return toolError('Collection Add Doc Failed', err.message);
      }
    },
  });

export const createCollectionRemoveDocTool = (
  removeDoc: (collectionId: string, docId: string) => Promise<object>
) =>
  defineTool({
    description:
      "Remove a document from a collection (removes from collection's allowList).",
    inputSchema: z.object({
      collection_id: z.string().describe('The ID of the collection'),
      doc_id: z.string().describe('The ID of the document to remove'),
    }),
    execute: async ({ collection_id, doc_id }) => {
      try {
        return await removeDoc(collection_id, doc_id);
      } catch (err: any) {
        logger.error(
          `Failed to remove doc ${doc_id} from collection ${collection_id}`,
          err
        );
        return toolError('Collection Remove Doc Failed', err.message);
      }
    },
  });

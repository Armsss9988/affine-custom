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

const logger = new Logger('FolderTools');

// ─── Helpers ────────────────────────────────────────────────────────────────

interface RawFolderNode {
  id: string;
  parentId: string | null;
  data: string;
  type: 'folder' | 'doc' | 'tag' | 'collection';
  index: string;
}

interface FolderTreeItem {
  id: string;
  name?: string;
  type: 'folder' | 'doc' | 'tag' | 'collection';
  targetId?: string;
  index: string;
  children?: FolderTreeItem[];
}

function parseFolders(bin: Buffer | Uint8Array): RawFolderNode[] {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bin);
    const result: RawFolderNode[] = [];

    for (const key of doc.share.keys()) {
      const record = doc.getMap(key);
      if (record.get('$$DELETED') === true || record.size === 0) {
        continue;
      }

      result.push({
        id: (record.get('id') || key) as string,
        parentId: record.get('parentId') as string | null,
        data: (record.get('data') as string) || '',
        type: (record.get('type') as any) || 'folder',
        index: (record.get('index') as string) || '',
      });
    }
    return result;
  } catch (err) {
    logger.error('Failed to parse folders doc', err);
    return [];
  }
}

function buildFolderUpdate(
  existingBin: Buffer,
  node: {
    id: string;
    parentId?: string | null;
    data?: string;
    type?: string;
    index?: string;
  },
  isDelete = false
): Uint8Array {
  const doc = new Y.Doc();
  if (existingBin.length > 0) {
    Y.applyUpdate(doc, existingBin);
  }
  const record = doc.getMap(node.id);

  doc.transact(() => {
    if (isDelete) {
      record.set('$$DELETED', true);
      record.delete('parentId');
      record.delete('data');
      record.delete('type');
      record.delete('index');
    } else {
      record.set('id', node.id);
      if (node.parentId !== undefined) {
        if (node.parentId === null) {
          record.delete('parentId');
        } else {
          record.set('parentId', node.parentId);
        }
      }
      if (node.data !== undefined) record.set('data', node.data);
      if (node.type !== undefined) record.set('type', node.type);
      if (node.index !== undefined) record.set('index', node.index);
      record.delete('$$DELETED');
    }
  });

  return Y.encodeStateAsUpdate(doc);
}

function buildFolderTree(nodes: RawFolderNode[]): FolderTreeItem[] {
  const nodeMap = new Map<string, FolderTreeItem>();
  const rootItems: FolderTreeItem[] = [];

  // Create tree nodes
  for (const node of nodes) {
    const item: FolderTreeItem = {
      id: node.id,
      type: node.type,
      index: node.index,
    };
    if (node.type === 'folder') {
      item.name = node.data;
      item.children = [];
    } else {
      item.targetId = node.data;
    }
    nodeMap.set(node.id, item);
  }

  // Build tree hierarchy
  for (const node of nodes) {
    const item = nodeMap.get(node.id)!;
    if (node.parentId) {
      const parent = nodeMap.get(node.parentId);
      if (parent && parent.children) {
        parent.children.push(item);
      } else {
        rootItems.push(item); // Dangling child as root
      }
    } else {
      rootItems.push(item);
    }
  }

  // Sort children by index fractional strings
  const sortFn = (a: FolderTreeItem, b: FolderTreeItem) =>
    a.index.localeCompare(b.index);
  rootItems.sort(sortFn);
  for (const item of nodeMap.values()) {
    if (item.children) {
      item.children.sort(sortFn);
    }
  }

  return rootItems;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildFolderListHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Folder List Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError('Folder List Failed', 'No workspace read permission');
    }

    const folderDocId = `db$folders`;
    const folderDoc = await storage.getDoc(options.workspace, folderDocId);
    if (!folderDoc?.bin) {
      return { folders: [] };
    }
    const bin = Buffer.isBuffer(folderDoc.bin)
      ? folderDoc.bin
      : Buffer.from(
          folderDoc.bin.buffer,
          folderDoc.bin.byteOffset,
          folderDoc.bin.byteLength
        );
    const nodes = parseFolders(bin);
    const tree = buildFolderTree(nodes);
    return { folders: tree };
  };
};

export const buildFolderCreateHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    name: string,
    parentId?: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Folder Create Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.CreateDoc');
    if (!canAccess) {
      return toolError(
        'Folder Create Failed',
        'No workspace update permission'
      );
    }

    const folderDocId = `db$folders`;
    const folderDoc = await storage.getDoc(options.workspace, folderDocId);
    const existingBin = folderDoc?.bin
      ? Buffer.isBuffer(folderDoc.bin)
        ? folderDoc.bin
        : Buffer.from(
            folderDoc.bin.buffer,
            folderDoc.bin.byteOffset,
            folderDoc.bin.byteLength
          )
      : Buffer.alloc(0);

    const nodes = parseFolders(existingBin);
    if (parentId) {
      const parent = nodes.find(n => n.id === parentId);
      if (!parent || parent.type !== 'folder') {
        return toolError(
          'Folder Create Failed',
          `Parent folder ${parentId} not found`
        );
      }
    }

    const folderId = nanoid();
    const index = `a${nanoid(5)}`;
    const update = buildFolderUpdate(existingBin, {
      id: folderId,
      parentId: parentId || null,
      data: name,
      type: 'folder',
      index,
    });

    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      folderDocId,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: folderDocId,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      folder: { id: folderId, name, parentId: parentId || null, index },
      message: `Folder '${name}' created successfully`,
    };
  };
};

export const buildFolderAddDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    folderId: string,
    docId: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Folder Add Doc Failed',
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
        'Folder Add Doc Failed',
        `No permission to read doc ${docId}`
      );
    }

    const folderDocId = `db$folders`;
    const folderDoc = await storage.getDoc(options.workspace, folderDocId);
    if (!folderDoc?.bin) {
      return toolError('Folder Add Doc Failed', 'Folder database not found');
    }
    const existingBin = Buffer.isBuffer(folderDoc.bin)
      ? folderDoc.bin
      : Buffer.from(
          folderDoc.bin.buffer,
          folderDoc.bin.byteOffset,
          folderDoc.bin.byteLength
        );

    const nodes = parseFolders(existingBin);
    const folder = nodes.find(n => n.id === folderId);
    if (!folder || folder.type !== 'folder') {
      return toolError(
        'Folder Add Doc Failed',
        `Target folder ID ${folderId} not found`
      );
    }

    const linkId = nanoid();
    const index = `a${nanoid(5)}`;
    const update = buildFolderUpdate(existingBin, {
      id: linkId,
      parentId: folderId,
      data: docId,
      type: 'doc',
      index,
    });

    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      folderDocId,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: folderDocId,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      message: `Successfully added document to folder`,
    };
  };
};

export const buildFolderRemoveDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models,
  writer?: DocWriter
) => {
  return async (
    options: CopilotChatOptions,
    folderId: string,
    docId: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Folder Remove Doc Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError(
        'Folder Remove Doc Failed',
        'No workspace read permission'
      );
    }

    const folderDocId = `db$folders`;
    const folderDoc = await storage.getDoc(options.workspace, folderDocId);
    if (!folderDoc?.bin) {
      return { success: true, message: 'Folder database not found' };
    }
    const existingBin = Buffer.isBuffer(folderDoc.bin)
      ? folderDoc.bin
      : Buffer.from(
          folderDoc.bin.buffer,
          folderDoc.bin.byteOffset,
          folderDoc.bin.byteLength
        );

    const nodes = parseFolders(existingBin);
    const link = nodes.find(
      n => n.parentId === folderId && n.type === 'doc' && n.data === docId
    );
    if (!link) {
      return { success: true, message: 'Document not found in folder' };
    }

    const update = buildFolderUpdate(existingBin, { id: link.id }, true);
    const timestamp = await storage.pushDocUpdates(
      options.workspace,
      folderDocId,
      [update],
      options.user
    );

    if (writer) {
      writer['emitDocUpdatesPushed']({
        spaceId: options.workspace,
        docId: folderDocId,
        updates: [update],
        timestamp,
        editor: options.user,
      });
    }

    return {
      success: true,
      message: `Successfully removed document from folder`,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createFolderListTool = (listFolders: () => Promise<object>) =>
  defineTool({
    description:
      'List all folders and hierarchical organization tree in the workspace.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await listFolders();
      } catch (err: any) {
        logger.error('Failed to list folders', err);
        return toolError('Folder List Failed', err.message);
      }
    },
  });

export const createFolderCreateTool = (
  createFolder: (name: string, parentId?: string) => Promise<object>
) =>
  defineTool({
    description:
      'Create a new folder in the workspace hierarchy. Use this when the user asks to create or add a new folder.',
    inputSchema: z.object({
      name: z.string().describe('The name of the folder to create'),
      parent_id: z.string().optional().describe('Optional parent folder ID'),
    }),
    execute: async ({ name, parent_id }) => {
      try {
        return await createFolder(name, parent_id);
      } catch (err: any) {
        logger.error('Failed to create folder', err);
        return toolError('Folder Create Failed', err.message);
      }
    },
  });

export const createFolderAddDocTool = (
  addDoc: (folderId: string, docId: string) => Promise<object>
) =>
  defineTool({
    description: 'Move/add a document inside a folder.',
    inputSchema: z.object({
      folder_id: z.string().describe('The ID of the folder'),
      doc_id: z.string().describe('The ID of the document to add'),
    }),
    execute: async ({ folder_id, doc_id }) => {
      try {
        return await addDoc(folder_id, doc_id);
      } catch (err: any) {
        logger.error(`Failed to add doc ${doc_id} to folder ${folder_id}`, err);
        return toolError('Folder Add Doc Failed', err.message);
      }
    },
  });

export const createFolderRemoveDocTool = (
  removeDoc: (folderId: string, docId: string) => Promise<object>
) =>
  defineTool({
    description: 'Remove a document from a folder.',
    inputSchema: z.object({
      folder_id: z.string().describe('The ID of the folder'),
      doc_id: z.string().describe('The ID of the document to remove'),
    }),
    execute: async ({ folder_id, doc_id }) => {
      try {
        return await removeDoc(folder_id, doc_id);
      } catch (err: any) {
        logger.error(
          `Failed to remove doc ${doc_id} from folder ${folder_id}`,
          err
        );
        return toolError('Folder Remove Doc Failed', err.message);
      }
    },
  });

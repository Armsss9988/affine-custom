import { Logger } from '@nestjs/common';
import { nanoid } from 'nanoid';
import * as Y from 'yjs';
import { z } from 'zod';

import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('FavoriteTools');

// ─── Helpers ────────────────────────────────────────────────────────────────

interface FavoriteRecord {
  type: 'doc' | 'collection' | 'tag';
  id: string;
  index: string;
}

function parseFavorites(bin: Buffer | Uint8Array): FavoriteRecord[] {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bin);
    const result: FavoriteRecord[] = [];

    // Iterate over all share keys in the Y.Doc root
    for (const key of doc.share.keys()) {
      const record = doc.getMap(key);
      if (record.get('$$DELETED') === true || record.size === 0) {
        continue;
      }

      const recordKey = (record.get('key') as string) || key;
      const parts = recordKey.split(':');
      if (parts.length >= 2) {
        const type = parts[0];
        if (type === 'doc' || type === 'collection' || type === 'tag') {
          result.push({
            type,
            id: parts.slice(1).join(':'),
            index: (record.get('index') as string) || '',
          });
        }
      }
    }
    return result;
  } catch (err) {
    logger.error('Failed to parse favorites doc', err);
    return [];
  }
}

function buildFavoriteUpdate(
  existingBin: Buffer,
  type: 'doc' | 'collection' | 'tag',
  id: string,
  index: string,
  isDelete: boolean
): Uint8Array {
  const doc = new Y.Doc();
  if (existingBin.length > 0) {
    Y.applyUpdate(doc, existingBin);
  }
  const key = `${type}:${id}`;
  const record = doc.getMap(key);

  doc.transact(() => {
    if (isDelete) {
      record.set('$$DELETED', true);
      record.delete('index');
    } else {
      record.set('key', key);
      record.set('index', index);
      record.delete('$$DELETED');
    }
  });

  return Y.encodeStateAsUpdate(doc);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildFavoriteListHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Favorite List Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError('Favorite List Failed', 'No workspace read permission');
    }

    const favDocId = `userdata$${options.user}$favorite`;
    const favDoc = await storage.getDoc(options.workspace, favDocId);
    if (!favDoc?.bin) {
      return { total: 0, favorites: [] };
    }
    const bin = Buffer.isBuffer(favDoc.bin)
      ? favDoc.bin
      : Buffer.from(
          favDoc.bin.buffer,
          favDoc.bin.byteOffset,
          favDoc.bin.byteLength
        );
    const favorites = parseFavorites(bin);
    return {
      total: favorites.length,
      favorites,
    };
  };
};

export const buildFavoriteAddHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    type: 'doc' | 'collection' | 'tag',
    id: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Favorite Add Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError('Favorite Add Failed', 'No workspace read permission');
    }

    const favDocId = `userdata$${options.user}$favorite`;
    const favDoc = await storage.getDoc(options.workspace, favDocId);
    const existingBin = favDoc?.bin
      ? Buffer.isBuffer(favDoc.bin)
        ? favDoc.bin
        : Buffer.from(
            favDoc.bin.buffer,
            favDoc.bin.byteOffset,
            favDoc.bin.byteLength
          )
      : Buffer.alloc(0);

    const index = `a${nanoid(5)}`;
    const update = buildFavoriteUpdate(existingBin, type, id, index, false);

    await storage.pushDocUpdates(
      options.workspace,
      favDocId,
      [update],
      options.user
    );

    return {
      success: true,
      message: `Successfully added ${type} '${id}' to favorites`,
    };
  };
};

export const buildFavoriteRemoveHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (
    options: CopilotChatOptions,
    type: 'doc' | 'collection' | 'tag',
    id: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Favorite Remove Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError(
        'Favorite Remove Failed',
        'No workspace read permission'
      );
    }

    const favDocId = `userdata$${options.user}$favorite`;
    const favDoc = await storage.getDoc(options.workspace, favDocId);
    if (!favDoc?.bin) {
      return { success: true, message: 'Favorites already empty' };
    }

    const existingBin = Buffer.isBuffer(favDoc.bin)
      ? favDoc.bin
      : Buffer.from(
          favDoc.bin.buffer,
          favDoc.bin.byteOffset,
          favDoc.bin.byteLength
        );

    const update = buildFavoriteUpdate(existingBin, type, id, '', true);

    await storage.pushDocUpdates(
      options.workspace,
      favDocId,
      [update],
      options.user
    );

    return {
      success: true,
      message: `Successfully removed ${type} '${id}' from favorites`,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createFavoriteListTool = (listFavorites: () => Promise<object>) =>
  defineTool({
    description:
      'List all favorite items of the current user. Returns list of type, ID, and positional index.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await listFavorites();
      } catch (err: any) {
        logger.error('Failed to list favorites', err);
        return toolError('Favorite List Failed', err.message);
      }
    },
  });

export const createFavoriteAddTool = (
  addFavorite: (
    type: 'doc' | 'collection' | 'tag',
    id: string
  ) => Promise<object>
) =>
  defineTool({
    description:
      "Add an item (document, tag, or collection) to the user's favorites.",
    inputSchema: z.object({
      type: z
        .enum(['doc', 'collection', 'tag'])
        .describe('The type of item to favorite'),
      id: z.string().describe('The ID of the item to favorite'),
    }),
    execute: async ({ type, id }) => {
      try {
        return await addFavorite(type, id);
      } catch (err: any) {
        logger.error(`Failed to add favorite ${type}:${id}`, err);
        return toolError('Favorite Add Failed', err.message);
      }
    },
  });

export const createFavoriteRemoveTool = (
  removeFavorite: (
    type: 'doc' | 'collection' | 'tag',
    id: string
  ) => Promise<object>
) =>
  defineTool({
    description:
      "Remove an item (document, tag, or collection) from the user's favorites.",
    inputSchema: z.object({
      type: z
        .enum(['doc', 'collection', 'tag'])
        .describe('The type of item to unfavorite'),
      id: z.string().describe('The ID of the item to unfavorite'),
    }),
    execute: async ({ type, id }) => {
      try {
        return await removeFavorite(type, id);
      } catch (err: any) {
        logger.error(`Failed to remove favorite ${type}:${id}`, err);
        return toolError('Favorite Remove Failed', err.message);
      }
    },
  });

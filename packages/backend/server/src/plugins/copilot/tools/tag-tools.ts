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

const logger = new Logger('TagTools');

const TAG_COLORS = [
  'var(--affine-tag-pink)',
  'var(--affine-tag-blue)',
  'var(--affine-tag-green)',
  'var(--affine-tag-orange)',
  'var(--affine-tag-purple)',
  'var(--affine-tag-teal)',
  'var(--affine-tag-yellow)',
];

// ─── Helpers ────────────────────────────────────────────────────────────────

interface TagOption {
  id: string;
  value: string;
  color: string;
  createDate?: number;
  updateDate?: number;
}

function getOrCreateMap(parent: Y.Map<any>, key: string): Y.Map<any> {
  let child = parent.get(key);
  if (!(child instanceof Y.Map)) {
    child = new Y.Map();
    parent.set(key, child);
  }
  return child;
}

/**
 * Retrieve tag options from workspace root doc
 */
function getTagOptions(rootBin: Buffer | Uint8Array): TagOption[] {
  try {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, rootBin);
    const meta = doc.getMap('meta');
    const properties = meta.get('properties');
    if (!(properties instanceof Y.Map)) return [];
    const tags = properties.get('tags');
    if (!(tags instanceof Y.Map)) return [];
    const options = tags.get('options');
    if (!(options instanceof Y.Array)) return [];

    return options.map(opt => {
      const toJSON = typeof opt.toJSON === 'function' ? opt.toJSON() : opt;
      return {
        id: toJSON.id || '',
        value: toJSON.value || '',
        color: toJSON.color || '',
        createDate: toJSON.createDate,
        updateDate: toJSON.updateDate,
      };
    });
  } catch (err) {
    logger.error('Failed to parse tag options', err);
    return [];
  }
}

/**
 * Build update to write new list of tag options
 */
function buildTagOptionsUpdate(
  existingBin: Buffer,
  optionsList: TagOption[]
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const meta = doc.getMap('meta');
  const properties = getOrCreateMap(meta, 'properties');
  const tags = getOrCreateMap(properties, 'tags');

  doc.transact(() => {
    const optionsArray = new Y.Array();
    for (const opt of optionsList) {
      const optMap = new Y.Map();
      optMap.set('id', opt.id);
      optMap.set('value', opt.value);
      optMap.set('color', opt.color);
      optMap.set('createDate', opt.createDate || Date.now());
      optMap.set('updateDate', opt.updateDate || Date.now());
      optionsArray.push([optMap]);
    }
    tags.set('options', optionsArray);
  });

  return Y.encodeStateAsUpdate(doc);
}

/**
 * Add or remove a tag from a document inside meta.pages
 */
function buildDocTagsUpdate(
  existingBin: Buffer,
  docId: string,
  tagId: string,
  action: 'add' | 'remove'
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, existingBin);
  const meta = doc.getMap('meta');
  const pages = meta.get('pages') as Y.Array<Y.Map<unknown>> | undefined;
  if (!pages || !(pages instanceof Y.Array)) {
    throw new Error('No pages array found in workspace root doc');
  }

  let found = false;
  doc.transact(() => {
    pages.forEach((page: Y.Map<unknown>) => {
      if (page.get('id') === docId) {
        found = true;
        let tagsArray = page.get('tags') as Y.Array<string> | undefined;
        const currentTags =
          tagsArray instanceof Y.Array ? tagsArray.toArray() : [];

        if (action === 'add') {
          if (!currentTags.includes(tagId)) {
            const newTagsArray = new Y.Array<string>();
            newTagsArray.push([...currentTags, tagId]);
            page.set('tags', newTagsArray);
          }
        } else {
          if (currentTags.includes(tagId)) {
            const newTagsArray = new Y.Array<string>();
            newTagsArray.push(currentTags.filter(t => t !== tagId));
            page.set('tags', newTagsArray);
          }
        }
      }
    });
  });

  if (!found) {
    throw new Error(`Doc ${docId} not found in workspace pages`);
  }
  return Y.encodeStateAsUpdate(doc);
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildTagListHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError('Tag List Failed', 'Missing user or workspace context');
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canAccess) {
      return toolError('Tag List Failed', 'No workspace read permission');
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Tag List Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );
    const tags = getTagOptions(rootBin);
    return {
      total: tags.length,
      tags,
    };
  };
};

export const buildTagCreateHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, value: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Tag Create Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.CreateDoc'); // Writer+ or member
    if (!canAccess) {
      return toolError('Tag Create Failed', 'No workspace update permission');
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Tag Create Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const existingTags = getTagOptions(rootBin);
    const duplicate = existingTags.find(
      t => t.value.toLowerCase() === value.toLowerCase()
    );
    if (duplicate) {
      return {
        success: true,
        tag: duplicate,
        message: 'Tag already exists',
      };
    }

    const tagId = nanoid();
    const color = TAG_COLORS[existingTags.length % TAG_COLORS.length];
    const newTag: TagOption = {
      id: tagId,
      value,
      color,
      createDate: Date.now(),
      updateDate: Date.now(),
    };

    const update = buildTagOptionsUpdate(rootBin, [...existingTags, newTag]);
    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    return {
      success: true,
      tag: newTag,
      message: `Tag '${value}' created successfully`,
    };
  };
};

export const buildTagAddToDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, docId: string, tagId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError('Tag Add Failed', 'Missing user or workspace context');
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canAccess) {
      return toolError(
        'Tag Add Failed',
        `No permission to update doc ${docId}`
      );
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Tag Add Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    // Verify tagId exists
    const existingTags = getTagOptions(rootBin);
    const tag = existingTags.find(t => t.id === tagId);
    if (!tag) {
      return toolError('Tag Add Failed', `Tag ID ${tagId} does not exist`);
    }

    const update = buildDocTagsUpdate(rootBin, docId, tagId, 'add');
    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    return {
      success: true,
      message: `Added tag '${tag.value}' to document successfully`,
    };
  };
};

export const buildTagRemoveFromDocHandler = (
  ac: AccessController,
  storage: PgWorkspaceDocStorageAdapter,
  _models: Models
) => {
  return async (options: CopilotChatOptions, docId: string, tagId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Tag Remove Failed',
        'Missing user or workspace context'
      );
    }
    const canAccess = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Update');
    if (!canAccess) {
      return toolError(
        'Tag Remove Failed',
        `No permission to update doc ${docId}`
      );
    }
    const rootDoc = await storage.getDoc(options.workspace, options.workspace);
    if (!rootDoc?.bin) {
      return toolError('Tag Remove Failed', 'Workspace root doc not found');
    }
    const rootBin = Buffer.isBuffer(rootDoc.bin)
      ? rootDoc.bin
      : Buffer.from(
          rootDoc.bin.buffer,
          rootDoc.bin.byteOffset,
          rootDoc.bin.byteLength
        );

    const update = buildDocTagsUpdate(rootBin, docId, tagId, 'remove');
    await storage.pushDocUpdates(
      options.workspace,
      options.workspace,
      [update],
      options.user
    );

    return {
      success: true,
      message: `Removed tag from document successfully`,
    };
  };
};

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createTagListTool = (listTags: () => Promise<object>) =>
  defineTool({
    description:
      'List all tags in the workspace. Returns tag IDs, values (names), and colors.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await listTags();
      } catch (err: any) {
        logger.error('Failed to list tags', err);
        return toolError('Tag List Failed', err.message);
      }
    },
  });

export const createTagCreateTool = (
  createTag: (value: string) => Promise<object>
) =>
  defineTool({
    description:
      'Create a new tag in the workspace. Use this when the user asks to create or add a new tag.',
    inputSchema: z.object({
      value: z.string().describe('The name of the tag to create'),
    }),
    execute: async ({ value }) => {
      try {
        return await createTag(value);
      } catch (err: any) {
        logger.error('Failed to create tag', err);
        return toolError('Tag Create Failed', err.message);
      }
    },
  });

export const createTagAddToDocTool = (
  addTag: (docId: string, tagId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Add an existing tag to a document. Use this when the user asks to tag a document.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document'),
      tag_id: z.string().describe('The ID of the tag to add'),
    }),
    execute: async ({ doc_id, tag_id }) => {
      try {
        return await addTag(doc_id, tag_id);
      } catch (err: any) {
        logger.error(`Failed to add tag ${tag_id} to doc ${doc_id}`, err);
        return toolError('Tag Add Failed', err.message);
      }
    },
  });

export const createTagRemoveFromDocTool = (
  removeTag: (docId: string, tagId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Remove a tag from a document. Use this when the user asks to untag a document.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document'),
      tag_id: z.string().describe('The ID of the tag to remove'),
    }),
    execute: async ({ doc_id, tag_id }) => {
      try {
        return await removeTag(doc_id, tag_id);
      } catch (err: any) {
        logger.error(`Failed to remove tag ${tag_id} from doc ${doc_id}`, err);
        return toolError('Tag Remove Failed', err.message);
      }
    },
  });

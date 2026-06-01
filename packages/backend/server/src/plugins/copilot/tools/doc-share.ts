/**
 * Doc sharing tools: enable/disable public sharing for a document.
 */
import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { PublicDocMode } from '../../../models/common/doc';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('DocShareTools');

export const buildDocShareEnableHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    mode: 'page' | 'edgeless' = 'page'
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Share Enable Failed',
        'Missing user or workspace context'
      );
    }
    const canPublish = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Publish');
    if (!canPublish) {
      return toolError(
        'Share Enable Failed',
        `No permission to share doc ${docId}`
      );
    }
    const docMode =
      mode === 'edgeless' ? PublicDocMode.Edgeless : PublicDocMode.Page;
    await models.doc.publish(options.workspace, docId, docMode);
    const url = `${process.env['AFFINE_SERVER_EXTERNAL_URL'] ?? ''}/share/${options.workspace}/${docId}`;
    logger.log(`Doc ${docId} published as public by ${options.user}`);
    return {
      success: true,
      docId,
      publicUrl: url,
      message: `Document is now publicly accessible`,
    };
  };
};

export const buildDocShareDisableHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (options: CopilotChatOptions, docId: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Share Disable Failed',
        'Missing user or workspace context'
      );
    }
    const canPublish = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Publish');
    if (!canPublish) {
      return toolError(
        'Share Disable Failed',
        `No permission to manage sharing for doc ${docId}`
      );
    }
    await models.doc.unpublish(options.workspace, docId);
    logger.log(`Doc ${docId} unpublished by ${options.user}`);
    return {
      success: true,
      docId,
      message: `Document public access has been revoked`,
    };
  };
};

export const createDocShareEnableTool = (
  enableShare: (docId: string, mode?: 'page' | 'edgeless') => Promise<object>
) =>
  defineTool({
    description:
      'Make a document publicly accessible via a shareable link. Anyone with the link can view the document without signing in. Use this when the user asks to share, publish, or make a document public.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to make public'),
      mode: z
        .enum(['page', 'edgeless'])
        .optional()
        .describe(
          'The view mode for the public link: "page" (default) or "edgeless" (whiteboard)'
        ),
    }),
    execute: async ({ doc_id, mode }) => {
      try {
        return await enableShare(doc_id, mode);
      } catch (err: any) {
        logger.error(`Failed to enable sharing for doc ${doc_id}`, err);
        return toolError('Share Enable Failed', err.message);
      }
    },
  });

export const createDocShareDisableTool = (
  disableShare: (docId: string) => Promise<object>
) =>
  defineTool({
    description:
      'Revoke public access to a document, making it private again. Use this when the user asks to stop sharing, unpublish, or make a document private.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to make private'),
    }),
    execute: async ({ doc_id }) => {
      try {
        return await disableShare(doc_id);
      } catch (err: any) {
        logger.error(`Failed to disable sharing for doc ${doc_id}`, err);
        return toolError('Share Disable Failed', err.message);
      }
    },
  });

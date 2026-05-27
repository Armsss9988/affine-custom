/**
 * Workspace info tool: get workspace metadata, member count, quota.
 */
import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('WorkspaceInfoTool');

export const buildWorkspaceInfoHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (options: CopilotChatOptions) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Workspace Info Failed',
        'Missing user or workspace context'
      );
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .can('Workspace.Read');
    if (!canRead) {
      return toolError('Workspace Info Failed', 'No workspace read permission');
    }
    const [workspace, memberCount] = await Promise.all([
      models.workspace.get(options.workspace),
      models.workspaceUser.count(options.workspace).catch(() => null),
    ]);
    if (!workspace) {
      return toolError(
        'Workspace Info Failed',
        `Workspace ${options.workspace} not found`
      );
    }
    return {
      workspaceId: workspace.id,
      name:
        (workspace as Record<string, unknown>)['name'] ?? '(Unnamed Workspace)',
      createdAt: workspace.createdAt?.toISOString() ?? null,
      memberCount: memberCount ?? null,
    };
  };
};

export const createWorkspaceInfoTool = (getInfo: () => Promise<object>) =>
  defineTool({
    description:
      'Get information about the current workspace: name, creation date, member count, and storage quota usage. Use this when the user asks about the workspace, how many members it has, or how much storage is being used.',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        return await getInfo();
      } catch (err: any) {
        logger.error('Failed to get workspace info', err);
        return toolError('Workspace Info Failed', err.message);
      }
    },
  });

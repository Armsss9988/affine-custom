/**
 * Comment tools: list, create, reply, resolve comments in a document.
 * Uses the CommentModel directly from Models.
 */
import { Logger } from '@nestjs/common';
import { z } from 'zod';

import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { toolError } from './error';
import { defineTool } from './tool';
import type { CopilotChatOptions } from './types';

const logger = new Logger('CommentTools');

// CommentModel.create expects: { workspaceId, docId, userId, content: JSONSchema }
// content is a JSON object representing the Blocksuite Y.Text snapshot.
// For AI-generated comments, we use a plain text delta format.
function buildTextContent(text: string): object {
  // Tiptap/Blocksuite delta format for plain text
  return { delta: [{ insert: text }] };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export const buildCommentListHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (options: CopilotChatOptions, docId: string, limit?: number) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Comment List Failed',
        'Missing user or workspace context'
      );
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Comments.Read');
    if (!canRead) {
      return toolError(
        'Comment List Failed',
        `No permission to read comments on doc ${docId}`
      );
    }
    const comments = await models.comment.list(options.workspace, docId, {
      take: limit ?? 50,
    });
    return {
      docId,
      total: comments.length,
      comments: comments.map(c => ({
        id: c.id,
        content: extractTextFromContent(c.content),
        resolved: c.resolved ?? false,
        createdAt: c.createdAt?.toISOString() ?? null,
        userId: c.userId,
        replies: (c.replies ?? []).map(r => ({
          id: r.id,
          content: extractTextFromContent(r.content),
          createdAt: r.createdAt?.toISOString() ?? null,
          userId: r.userId,
        })),
      })),
    };
  };
};

export const buildCommentCreateHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (options: CopilotChatOptions, docId: string, text: string) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Comment Create Failed',
        'Missing user or workspace context'
      );
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Comments.Create');
    if (!canRead) {
      return toolError(
        'Comment Create Failed',
        `No permission to comment on doc ${docId}`
      );
    }
    const comment = await models.comment.create({
      workspaceId: options.workspace,
      docId,
      userId: options.user,
      content: buildTextContent(text),
    });
    logger.log(`Comment created on doc ${docId} by ${options.user}`);
    return {
      success: true,
      commentId: comment.id,
      message: `Comment added to document`,
    };
  };
};

export const buildCommentReplyHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    commentId: string,
    text: string
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Comment Reply Failed',
        'Missing user or workspace context'
      );
    }
    const canRead = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Comments.Create');
    if (!canRead) {
      return toolError(
        'Comment Reply Failed',
        `No permission to comment on doc ${docId}`
      );
    }
    // Verify parent comment exists
    const parentComment = await models.comment.get(commentId);
    if (!parentComment) {
      return toolError(
        'Comment Reply Failed',
        `Comment ${commentId} not found`
      );
    }
    const reply = await models.comment.createReply({
      commentId,
      userId: options.user,
      content: buildTextContent(text),
    });
    logger.log(`Reply created on comment ${commentId} by ${options.user}`);
    return {
      success: true,
      replyId: reply.id,
      commentId,
      message: `Reply added to comment`,
    };
  };
};

export const buildCommentResolveHandler = (
  ac: AccessController,
  models: Models
) => {
  return async (
    options: CopilotChatOptions,
    docId: string,
    commentId: string,
    resolved: boolean
  ) => {
    if (!options?.user || !options.workspace) {
      return toolError(
        'Comment Resolve Failed',
        'Missing user or workspace context'
      );
    }
    const canManage = await ac
      .user(options.user)
      .workspace(options.workspace)
      .doc(docId)
      .can('Doc.Comments.Resolve');
    if (!canManage) {
      return toolError(
        'Comment Resolve Failed',
        `No permission to resolve comments on doc ${docId}`
      );
    }
    await models.comment.resolve({ id: commentId, resolved });
    logger.log(
      `Comment ${commentId} ${resolved ? 'resolved' : 'unresolved'} by ${options.user}`
    );
    return {
      success: true,
      commentId,
      resolved,
      message: `Comment ${resolved ? 'resolved' : 'reopened'} successfully`,
    };
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractTextFromContent(content: unknown): string {
  try {
    if (typeof content === 'string') return content;
    if (typeof content === 'object' && content !== null) {
      const c = content as Record<string, unknown>;
      if (Array.isArray(c['delta'])) {
        return (c['delta'] as Array<{ insert?: string }>)
          .map(d => d.insert ?? '')
          .join('');
      }
    }
    return JSON.stringify(content);
  } catch {
    return '';
  }
}

// ─── Tool Factories ───────────────────────────────────────────────────────────

export const createCommentListTool = (
  listComments: (docId: string, limit?: number) => Promise<object>
) =>
  defineTool({
    description:
      'List all comments and their replies on a document. Returns comment text, author, creation time, resolved status, and replies. Use this when the user asks to see, read, or review comments on a doc.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The ID of the document to list comments for'),
      limit: z
        .number()
        .min(1)
        .max(100)
        .optional()
        .describe('Maximum number of comments to return. Default: 50'),
    }),
    execute: async ({ doc_id, limit }) => {
      try {
        return await listComments(doc_id, limit);
      } catch (err: any) {
        logger.error(`Failed to list comments for doc ${doc_id}`, err);
        return toolError('Comment List Failed', err.message);
      }
    },
  });

export const createCommentCreateTool = (
  createComment: (docId: string, text: string) => Promise<object>
) =>
  defineTool({
    description:
      'Add a new comment to a document. Use this when the user asks to comment on, annotate, or leave feedback on a document.',
    inputSchema: z.object({
      doc_id: z.string().describe('The ID of the document to comment on'),
      text: z.string().min(1).describe('The comment text to add'),
    }),
    execute: async ({ doc_id, text }) => {
      try {
        return await createComment(doc_id, text);
      } catch (err: any) {
        logger.error(`Failed to create comment on doc ${doc_id}`, err);
        return toolError('Comment Create Failed', err.message);
      }
    },
  });

export const createCommentReplyTool = (
  replyComment: (
    docId: string,
    commentId: string,
    text: string
  ) => Promise<object>
) =>
  defineTool({
    description:
      'Reply to an existing comment on a document. Use this when the user asks to respond to or reply to a comment.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The ID of the document containing the comment'),
      comment_id: z.string().describe('The ID of the comment to reply to'),
      text: z.string().min(1).describe('The reply text'),
    }),
    execute: async ({ doc_id, comment_id, text }) => {
      try {
        return await replyComment(doc_id, comment_id, text);
      } catch (err: any) {
        logger.error(`Failed to reply to comment ${comment_id}`, err);
        return toolError('Comment Reply Failed', err.message);
      }
    },
  });

export const createCommentResolveTool = (
  resolveComment: (
    docId: string,
    commentId: string,
    resolved: boolean
  ) => Promise<object>
) =>
  defineTool({
    description:
      'Resolve or reopen a comment on a document. Resolved comments are marked as done and hidden by default. Use this when the user asks to resolve, close, or reopen a comment.',
    inputSchema: z.object({
      doc_id: z
        .string()
        .describe('The ID of the document containing the comment'),
      comment_id: z
        .string()
        .describe('The ID of the comment to resolve or reopen'),
      resolved: z
        .boolean()
        .describe('true to resolve the comment, false to reopen it'),
    }),
    execute: async ({ doc_id, comment_id, resolved }) => {
      try {
        return await resolveComment(doc_id, comment_id, resolved);
      } catch (err: any) {
        logger.error(`Failed to resolve comment ${comment_id}`, err);
        return toolError('Comment Resolve Failed', err.message);
      }
    },
  });

import { Injectable } from '@nestjs/common';
import { pick } from 'lodash-es';
import z from 'zod';
import * as Y from 'yjs';

import {
  DocReader,
  DocWriter,
  PgWorkspaceDocStorageAdapter,
} from '../../../core/doc';
import { AccessController } from '../../../core/permission';
import { clearEmbeddingChunk } from '../../../models';
import { IndexerService } from '../../indexer';
import { CopilotContextService } from '../context/service';
import { UiManifestService } from './ui-manifest.service';

type McpTextContent = {
  type: 'text';
  text: string;
};

export type WorkspaceMcpToolResult = {
  content: McpTextContent[];
  isError?: boolean;
};

export type WorkspaceMcpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

export type WorkspaceMcpServer = {
  name: string;
  version: string;
  tools: WorkspaceMcpToolDefinition[];
};

type ToolExecutorInput<T extends z.ZodTypeAny> = {
  name: string;
  title: string;
  description: string;
  parser: T;
  inputSchema: Record<string, unknown>;
  execute: (
    args: z.infer<T>,
    options: { signal: AbortSignal }
  ) => Promise<WorkspaceMcpToolResult>;
};

function toolText(text: string): WorkspaceMcpToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

function toolError(message: string): WorkspaceMcpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function toInputError(error: z.ZodError) {
  const details = error.issues
    .map(issue => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
  return toolError(`Invalid arguments: ${details || 'Invalid input'}`);
}

function abortIfNeeded(
  signal: AbortSignal
): WorkspaceMcpToolResult | undefined {
  if (signal.aborted) return toolError('Request aborted.');
  return;
}

function defineTool<T extends z.ZodTypeAny>(
  config: ToolExecutorInput<T>
): WorkspaceMcpToolDefinition {
  return {
    name: config.name,
    title: config.title,
    description: config.description,
    inputSchema: config.inputSchema,
    execute: async (args, options) => {
      const aborted = abortIfNeeded(options.signal);
      if (aborted) return aborted;

      const parsed = config.parser.safeParse(args ?? {});
      if (!parsed.success) return toInputError(parsed.error);
      return await config.execute(parsed.data, options);
    },
  };
}

@Injectable()
export class WorkspaceMcpProvider {
  constructor(
    private readonly ac: AccessController,
    private readonly reader: DocReader,
    private readonly writer: DocWriter,
    private readonly context: CopilotContextService,
    private readonly indexer: IndexerService,
    private readonly uiManifest: UiManifestService,
    private readonly workspaceStorage: PgWorkspaceDocStorageAdapter
  ) {}

  async for(userId: string, workspaceId: string): Promise<WorkspaceMcpServer> {
    await this.ac.user(userId).workspace(workspaceId).assert('Workspace.Read');

    const readDocument = defineTool({
      name: 'read_document',
      title: 'Read Document',
      description: 'Read a document with given ID',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string' },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        const content = await this.reader.getDocMarkdown(
          workspaceId,
          docId,
          false
        );
        if (!content) return notFoundError;

        const abortedAfterRead = abortIfNeeded(options.signal);
        if (abortedAfterRead) return abortedAfterRead;

        return toolText(content.markdown);
      },
    });

    const semanticSearch = defineTool({
      name: 'semantic_search',
      title: 'Semantic Search',
      description:
        'Retrieve conceptually related passages by performing vector-based semantic similarity search across embedded documents; use this tool only when exact keyword search fails or the user explicitly needs meaning-level matches (e.g., paraphrases, synonyms, broader concepts, recent documents).',
      parser: z.object({ query: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query }, options) => {
        const trimmed = query.trim();
        if (!trimmed) {
          return toolError('Query is required for semantic search.');
        }

        const chunks = await this.context.matchWorkspaceDocs(
          workspaceId,
          trimmed,
          5,
          options.signal
        );

        const abortedAfterMatch = abortIfNeeded(options.signal);
        if (abortedAfterMatch) return abortedAfterMatch;

        const docs = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .docs(
            chunks.filter(chunk => 'docId' in chunk),
            'Doc.Read'
          );

        const abortedAfterDocs = abortIfNeeded(options.signal);
        if (abortedAfterDocs) return abortedAfterDocs;

        return {
          content: docs.map(doc => ({
            type: 'text',
            text: clearEmbeddingChunk(doc).content,
          })),
        };
      },
    });

    const keywordSearch = defineTool({
      name: 'keyword_search',
      title: 'Keyword Search',
      description:
        'Fuzzy search all workspace documents for the exact keyword or phrase supplied and return passages ranked by textual match. Use this tool by default whenever a straightforward term-based or keyword-base lookup is sufficient.',
      parser: z.object({ query: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query }, options) => {
        const trimmed = query.trim();
        if (!trimmed) return toolError('Query is required for keyword search.');

        let docs = await this.indexer.searchDocsByKeyword(workspaceId, trimmed);

        const abortedAfterSearch = abortIfNeeded(options.signal);
        if (abortedAfterSearch) return abortedAfterSearch;

        docs = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .docs(docs, 'Doc.Read');

        const abortedAfterDocs = abortIfNeeded(options.signal);
        if (abortedAfterDocs) return abortedAfterDocs;

        return {
          content: docs.map(doc => ({
            type: 'text',
            text: JSON.stringify(pick(doc, 'docId', 'title', 'createdAt')),
          })),
        };
      },
    });

    const tools = [readDocument, semanticSearch, keywordSearch];

    const createDocument = defineTool({
      name: 'create_document',
      title: 'Create Document',
      description:
        'Create a new document in the workspace with the given title and markdown content. Returns the ID of the created document. This tool not support insert or update database block and image yet.',
      parser: z.object({
        title: z.string().min(1),
        content: z.string(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the new document',
          },
          content: {
            type: 'string',
            description: 'The markdown content for the document body',
          },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
      execute: async ({ title, content }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.CreateDoc');

          const abortedAfterPermission = abortIfNeeded(options.signal);
          if (abortedAfterPermission) return abortedAfterPermission;

          const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
          if (!sanitizedTitle) throw new Error('Title cannot be empty');
          const strippedContent = content.replace(
            /^[ \t]{0,3}#\s+[^\n]*#*\s*\n*/,
            ''
          );
          const result = await this.writer.createDoc(
            workspaceId,
            sanitizedTitle,
            strippedContent,
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              docId: result.docId,
              message: `Document "${title}" created successfully`,
            })
          );
        } catch (error) {
          return toolError(
            `Failed to create document: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const updateDocument = defineTool({
      name: 'update_document',
      title: 'Update Document',
      description:
        'Update an existing document with new markdown content (body only). Uses structural diffing to apply minimal changes, preserving document history and enabling real-time collaboration. This does NOT update the document title. This tool not support insert or update database block and image yet.',
      parser: z.object({
        docId: z.string(),
        content: z.string(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The ID of the document to update',
          },
          content: {
            type: 'string',
            description:
              'The complete new markdown content for the document body (do NOT include a title H1)',
          },
        },
        required: ['docId', 'content'],
        additionalProperties: false,
      },
      execute: async ({ docId, content }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible) return notFoundError;

        const abortedBeforeWrite = abortIfNeeded(options.signal);
        if (abortedBeforeWrite) return abortedBeforeWrite;

        try {
          await this.writer.updateDoc(workspaceId, docId, content, userId);
          return toolText(
            JSON.stringify({
              success: true,
              docId,
              message: 'Document updated successfully',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to update document: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const updateDocumentMeta = defineTool({
      name: 'update_document_meta',
      title: 'Update Document Metadata',
      description: 'Update document metadata (currently title only).',
      parser: z.object({
        docId: z.string(),
        title: z.string().min(1),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The ID of the document to update',
          },
          title: {
            type: 'string',
            description: 'The new document title',
          },
        },
        required: ['docId', 'title'],
        additionalProperties: false,
      },
      execute: async ({ docId, title }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);

        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Update');
        if (!accessible) return notFoundError;

        const abortedAfterPermission = abortIfNeeded(options.signal);
        if (abortedAfterPermission) return abortedAfterPermission;

        try {
          const sanitizedTitle = title.replace(/[\r\n]+/g, ' ').trim();
          if (!sanitizedTitle) throw new Error('Title cannot be empty');

          await this.writer.updateDocMeta(
            workspaceId,
            docId,
            { title: sanitizedTitle },
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              docId,
              message: 'Document title updated successfully',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to update document metadata: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const queryUiFeatures = defineTool({
      name: 'query_ui_features',
      title: 'Query UI Features',
      description:
        'Search for AFFiNE UI features, keyboard shortcuts, commands, and page capabilities. ' +
        'Use this tool when users ask HOW to do something in the app, what shortcuts are available, ' +
        'or where to find a specific feature.',
      parser: z.object({
        query: z
          .string()
          .describe(
            'The feature, shortcut, or action the user is asking about'
          ),
        category: z
          .enum(['shortcuts', 'commands', 'page-features', 'all'])
          .optional()
          .default('all')
          .describe('Category of UI features to query'),
        platform: z
          .enum(['mac', 'win'])
          .optional()
          .describe(
            'The platform/OS to get specific keyboard shortcuts for (mac or win)'
          ),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'The feature, shortcut, or action the user is asking about',
          },
          category: {
            type: 'string',
            enum: ['shortcuts', 'commands', 'page-features', 'all'],
            default: 'all',
            description: 'Category of UI features to query',
          },
          platform: {
            type: 'string',
            enum: ['mac', 'win'],
            description:
              'The platform/OS to get specific keyboard shortcuts for (mac or win)',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, category, platform }, options) => {
        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;

        try {
          const results = this.uiManifest.search(query, category, platform);
          return toolText(JSON.stringify(results, null, 2));
        } catch (error) {
          return toolError(
            `Failed to query UI features: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const listKanbanTasks = defineTool({
      name: 'list_kanban_tasks',
      title: 'List Kanban Tasks',
      description:
        'Fetch all tasks/cards and their status from a document Kanban database view',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The document ID containing the Kanban board',
          },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Read');
        if (!accessible) return notFoundError;

        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;

        try {
          const doc = await this.reader.getDoc(workspaceId, docId);
          if (!doc) return notFoundError;

          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, doc.bin);

          const blocks = ydoc.getMap('blocks');
          let databaseBlock: Y.Map<any> | null = null;
          for (const key of blocks.keys()) {
            const block = blocks.get(key) as Y.Map<any>;
            if (block?.get('sys:flavour') === 'affine:database') {
              databaseBlock = block;
              break;
            }
          }

          if (!databaseBlock) {
            return toolError(
              'No Kanban/Database board found in this document.'
            );
          }

          // Parse columns to get status column ID and options
          const columnsArray = databaseBlock.get(
            'prop:columns'
          ) as Y.Array<any>;
          let statusColumnId = '';
          const statusOptions = new Map<string, string>(); // opt-id -> status-value
          if (columnsArray) {
            for (let i = 0; i < columnsArray.length; i++) {
              const col = columnsArray.get(i);
              if (col instanceof Y.Map && col.get('name') === 'Status') {
                statusColumnId = col.get('id');
                const data = col.get('data');
                if (data instanceof Y.Map) {
                  const optionsArr = data.get('options');
                  if (optionsArr instanceof Y.Array) {
                    for (let j = 0; j < optionsArr.length; j++) {
                      const opt = optionsArr.get(j);
                      if (opt instanceof Y.Map) {
                        statusOptions.set(opt.get('id'), opt.get('value'));
                      }
                    }
                  }
                }
                break;
              }
            }
          }

          const cellsMap = databaseBlock.get('prop:cells') as Y.Map<any>;
          const childrenArray = databaseBlock.get(
            'sys:children'
          ) as Y.Array<string>;
          const tasks: any[] = [];

          if (childrenArray) {
            for (let i = 0; i < childrenArray.length; i++) {
              const rowId = childrenArray.get(i);
              const rowBlock = blocks.get(rowId) as Y.Map<any>;
              if (rowBlock) {
                const textObj = rowBlock.get('prop:text');
                const title = textObj ? textObj.toString() : '';

                let status = 'Todo'; // fallback
                if (statusColumnId && cellsMap) {
                  const rowCells = cellsMap.get(rowId);
                  if (rowCells instanceof Y.Map) {
                    const statusCell = rowCells.get(statusColumnId);
                    if (statusCell && typeof statusCell === 'object') {
                      const cellVal = (statusCell as any).value;
                      if (Array.isArray(cellVal) && cellVal.length > 0) {
                        const optVal = cellVal[0].value;
                        if (optVal) {
                          status = optVal;
                        }
                      }
                    }
                  }
                }

                tasks.push({
                  id: rowId,
                  title,
                  status,
                });
              }
            }
          }

          return toolText(JSON.stringify(tasks, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list Kanban tasks: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const updateKanbanTaskStatus = defineTool({
      name: 'update_kanban_task_status',
      title: 'Update Kanban Task Status',
      description:
        'Update the status column of a specific task card on a Kanban board',
      parser: z.object({
        docId: z.string(),
        taskId: z.string(),
        status: z.string(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The document ID containing the Kanban board',
          },
          taskId: {
            type: 'string',
            description: 'The ID of the task row/card block',
          },
          status: {
            type: 'string',
            description: 'The new status value (e.g. Todo, Doing, Done)',
          },
        },
        required: ['docId', 'taskId', 'status'],
        additionalProperties: false,
      },
      execute: async ({ docId, taskId, status }, options) => {
        const notFoundError = toolError(`Doc with id ${docId} not found.`);
        const accessible = await this.ac
          .user(userId)
          .workspace(workspaceId)
          .doc(docId)
          .can('Doc.Write');
        if (!accessible) return toolError('Permission denied.');

        const aborted = abortIfNeeded(options.signal);
        if (aborted) return aborted;

        try {
          const doc = await this.reader.getDoc(workspaceId, docId);
          if (!doc) return notFoundError;

          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, doc.bin);

          const blocks = ydoc.getMap('blocks');
          let databaseBlock: Y.Map<any> | null = null;
          for (const key of blocks.keys()) {
            const block = blocks.get(key) as Y.Map<any>;
            if (block?.get('sys:flavour') === 'affine:database') {
              databaseBlock = block;
              break;
            }
          }

          if (!databaseBlock) {
            return toolError(
              'No Kanban/Database board found in this document.'
            );
          }

          // Verify row exists
          const rowBlock = blocks.get(taskId);
          if (!rowBlock) {
            return toolError(
              `Task card with ID ${taskId} not found in this document.`
            );
          }

          // Find status column
          const columnsArray = databaseBlock.get(
            'prop:columns'
          ) as Y.Array<any>;
          let statusColumnId = '';
          let targetOptId = '';
          if (columnsArray) {
            for (let i = 0; i < columnsArray.length; i++) {
              const col = columnsArray.get(i);
              if (col instanceof Y.Map && col.get('name') === 'Status') {
                statusColumnId = col.get('id');
                const data = col.get('data');
                if (data instanceof Y.Map) {
                  const optionsArr = data.get('options');
                  if (optionsArr instanceof Y.Array) {
                    for (let j = 0; j < optionsArr.length; j++) {
                      const opt = optionsArr.get(j);
                      if (opt instanceof Y.Map && opt.get('value') === status) {
                        targetOptId = opt.get('id');
                        break;
                      }
                    }
                    if (!targetOptId) {
                      // Create new status option
                      targetOptId = `opt-${optionsArr.length}`;
                      const optMap = new Y.Map();
                      optMap.set('id', targetOptId);
                      optMap.set('value', status);
                      optMap.set('color', 'var(--affine-tag-blue)');
                      optionsArr.push([optMap]);
                    }
                  }
                }
                break;
              }
            }
          }

          if (!statusColumnId) {
            return toolError('Status column not found on database board.');
          }

          const cellsMap = databaseBlock.get('prop:cells') as Y.Map<any>;
          if (cellsMap) {
            let rowCells = cellsMap.get(taskId);
            if (!rowCells) {
              rowCells = new Y.Map();
              cellsMap.set(taskId, rowCells);
            }
            if (rowCells instanceof Y.Map) {
              rowCells.set(statusColumnId, {
                columnId: statusColumnId,
                value: [{ id: targetOptId, value: status }],
              });
            }
          }

          const update = Y.encodeStateAsUpdate(ydoc);
          const timestamp = await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            docId,
            [update],
            userId
          );

          // Emit real-time update
          this.writer['emitDocUpdatesPushed']({
            spaceId: workspaceId,
            docId,
            updates: [update],
            timestamp,
            editor: userId,
          });

          return toolText(
            JSON.stringify({
              success: true,
              taskId,
              status,
              message: 'Task status updated successfully',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to update Kanban task: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    tools.push(
      createDocument,
      updateDocument,
      updateDocumentMeta,
      queryUiFeatures,
      listKanbanTasks,
      updateKanbanTaskStatus
    );

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }
}

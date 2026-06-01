import { Injectable } from '@nestjs/common';
import { pick } from 'lodash-es';
import z from 'zod';
import * as Y from 'yjs';
import { nanoid } from 'nanoid';

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

import {
  buildTagListHandler,
  buildTagCreateHandler,
  buildTagAddToDocHandler,
  buildTagRemoveFromDocHandler,
} from '../tools/tag-tools';
import {
  buildFavoriteListHandler,
  buildFavoriteAddHandler,
  buildFavoriteRemoveHandler,
} from '../tools/favorite-tools';
import {
  buildDatabaseCreateHandler,
  buildDatabaseQueryHandler,
  buildDatabaseAddRowHandler,
  buildDatabaseAddViewHandler,
} from '../tools/database-tools';

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

// ─── Collection Helpers ──────────────────────────────────────────────────────
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
  } catch {
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
      const colMap = new Y.Map();
      colMap.set('id', info.id);
      colMap.set('name', info.name || '');
      colMap.set('allowList', new Y.Array());
      const rulesMap = new Y.Map();
      rulesMap.set('filters', new Y.Array());
      colMap.set('rules', rulesMap);
      collectionsArray.push([colMap]);
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
          if (typeof col.set === 'function') {
            const yAllow = new Y.Array();
            yAllow.push(info.allowList || []);
            col.set('allowList', yAllow);
          } else {
            col.allowList = info.allowList || [];
          }
          break;
        }
      }
    }
  });

  return Y.encodeStateAsUpdate(doc);
}

// ─── Folder Helpers ──────────────────────────────────────────────────────────
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
  } catch {
    return [];
  }
}

function buildFolderTree(nodes: RawFolderNode[]): FolderTreeItem[] {
  const nodeMap = new Map<string, FolderTreeItem>();
  const rootItems: FolderTreeItem[] = [];

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

  for (const node of nodes) {
    const item = nodeMap.get(node.id)!;
    if (node.parentId) {
      const parent = nodeMap.get(node.parentId);
      if (parent && parent.children) {
        parent.children.push(item);
      } else {
        rootItems.push(item);
      }
    } else {
      rootItems.push(item);
    }
  }

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

// ─── Search Helpers ──────────────────────────────────────────────────────────
async function searchDuckDuckGo(query: string, numResults: number = 10) {
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; AFFiNE-Research-Bot/1.0)',
    },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo returned ${res.status}`);
  const html = await res.text();

  const results: Array<{
    title: string;
    url: string;
    content: string;
    engine: string;
  }> = [];

  const linkRegex =
    /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>(.*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    links.push({
      url: linkMatch[1],
      title: linkMatch[2].replace(/<[^>]*>/g, '').trim(),
    });
  }

  const snippets: string[] = [];
  let snippetMatch;
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(snippetMatch[1].replace(/<[^>]*>/g, '').trim());
  }

  if (links.length === 0) {
    return await searchDuckDuckGoInstant(query, numResults);
  }

  for (let i = 0; i < Math.min(links.length, numResults); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      content: snippets[i] || '',
      engine: 'duckduckgo',
    });
  }

  return results;
}

async function searchDuckDuckGoInstant(query: string, numResults: number) {
  const res = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
    {
      headers: {
        'User-Agent': 'AFFiNE-Research-Assistant/1.0',
      },
      signal: AbortSignal.timeout(10000),
    }
  );
  if (!res.ok) throw new Error(`DuckDuckGo API returned ${res.status}`);
  const data = (await res.json()) as any;

  const results: Array<{
    title: string;
    url: string;
    content: string;
    engine: string;
  }> = [];

  if (data.Abstract) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || '',
      content: data.Abstract,
      engine: 'duckduckgo',
    });
  }

  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics.slice(
      0,
      numResults - results.length
    )) {
      if (topic.Text && topic.FirstURL) {
        results.push({
          title: topic.Text.split(' - ')[0] || '',
          url: topic.FirstURL,
          content: topic.Text,
          engine: 'duckduckgo',
        });
      }
    }
  }

  return results;
}

// ─── URL Reader Helpers ──────────────────────────────────────────────────────
function extractHtmlTag(html: string, tag: string): string {
  const match = html.match(
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  );
  return match ? match[1].replace(/<[^>]*>/g, '').trim() : '';
}

function extractMeta(html: string, name: string): string {
  const match =
    html.match(
      new RegExp(
        `<meta[^>]*(?:name|property)=["'](?:og:)?${name}["'][^>]*content=["']([^"']*)["']`,
        'i'
      )
    ) ||
    html.match(
      new RegExp(
        `<meta[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:)?${name}["']`,
        'i'
      )
    );
  return match ? match[1].trim() : '';
}

function htmlToCleanText(html: string, maxLength: number): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const mainMatch = text.match(
    /<(?:main|article)[\s\S]*?>([\s\S]*?)<\/(?:main|article)>/i
  );
  if (mainMatch) {
    text = mainMatch[1];
  }

  text = text
    .replace(
      /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi,
      (_: string, level: string, content: string) => {
        return (
          '\n' +
          '#'.repeat(Number(level)) +
          ' ' +
          content.replace(/<[^>]*>/g, '').trim() +
          '\n'
        );
      }
    )
    .replace(
      /<p[^>]*>(.*?)<\/p>/gi,
      (_: string, content: string) => '\n' + content + '\n'
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gi, '> $1\n');

  text = text.replace(/<[^>]*>/g, '');

  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text.slice(0, maxLength);
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

    const listDocuments = defineTool({
      name: 'list_documents',
      title: 'List Documents',
      description:
        'List all documents in the workspace. Returns docId, title, createdAt, isJournal, and inTrash. Use this when the user asks to see all docs, find a doc by name, or browse the workspace contents.',
      parser: z.object({
        includeTrash: z.boolean().optional().default(false),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          includeTrash: {
            type: 'boolean',
            description:
              'If true, also list docs currently in the trash. Default: false',
          },
        },
        additionalProperties: false,
      },
      execute: async ({ includeTrash }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.Read');

          const abortedAfterPermission = abortIfNeeded(options.signal);
          if (abortedAfterPermission) return abortedAfterPermission;

          const rootDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            workspaceId
          );
          if (!rootDoc?.bin) {
            return toolText(JSON.stringify([]));
          }

          const buf = Buffer.isBuffer(rootDoc.bin)
            ? rootDoc.bin
            : Buffer.from(
                rootDoc.bin.buffer,
                rootDoc.bin.byteOffset,
                rootDoc.bin.byteLength
              );
          const ydoc = new Y.Doc();
          Y.applyUpdate(ydoc, buf);
          const meta = ydoc.getMap('meta');
          const pages = meta.get('pages') as
            | Y.Array<Y.Map<unknown>>
            | undefined;
          if (!pages) {
            return toolText(JSON.stringify([]));
          }

          const result: any[] = [];
          pages.forEach((page: Y.Map<unknown>) => {
            const trash = !!page.get('trash');
            if (includeTrash || !trash) {
              const createDate = page.get('createDate') as number | undefined;
              result.push({
                docId: page.get('id') as string,
                title:
                  (page.get('title') as string | undefined) || '(Untitled)',
                createdAt: createDate
                  ? new Date(createDate).toISOString()
                  : null,
                isJournal: !!page.get('isJournal'),
                inTrash: trash,
              });
            }
          });

          return toolText(JSON.stringify(result, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list documents: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const tools = [readDocument, semanticSearch, keywordSearch, listDocuments];

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
          .can('Doc.Update');
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

    const listCollections = defineTool({
      name: 'list_collections',
      title: 'List Collections',
      description: 'List all custom collections in the workspace.',
      parser: z.object({}),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async (_, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const rootDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            workspaceId
          );
          if (!rootDoc?.bin) {
            return toolText(JSON.stringify({ total: 0, collections: [] }));
          }
          const bin = Buffer.isBuffer(rootDoc.bin)
            ? rootDoc.bin
            : Buffer.from(
                rootDoc.bin.buffer,
                rootDoc.bin.byteOffset,
                rootDoc.bin.byteLength
              );

          const collections = parseCollections(bin);
          return toolText(
            JSON.stringify({ total: collections.length, collections }, null, 2)
          );
        } catch (error) {
          return toolError(
            `Failed to list collections: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const createCollection = defineTool({
      name: 'create_collection',
      title: 'Create Collection',
      description:
        'Create a new collection. Use this when the user asks to create or add a new collection.',
      parser: z.object({ name: z.string().min(1) }),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the collection to create',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async ({ name }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.CreateDoc');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const rootDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            workspaceId
          );
          if (!rootDoc?.bin) {
            return toolError('Workspace root doc not found');
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
            return toolText(
              JSON.stringify({
                success: true,
                collection: duplicate,
                message: 'Collection already exists',
              })
            );
          }

          const collectionId = nanoid();
          const update = buildCollectionUpdate(
            rootBin,
            { id: collectionId, name },
            'create'
          );
          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            workspaceId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify(
              {
                success: true,
                collection: { id: collectionId, name, allowList: [] },
                message: `Collection '${name}' created successfully`,
              },
              null,
              2
            )
          );
        } catch (error) {
          return toolError(
            `Failed to create collection: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addDocToCollection = defineTool({
      name: 'add_doc_to_collection',
      title: 'Add Document to Collection',
      description:
        "Add a document to a collection (adds to collection's allowList).",
      parser: z.object({ collectionId: z.string(), docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          collectionId: {
            type: 'string',
            description: 'The ID of the collection',
          },
          docId: {
            type: 'string',
            description: 'The ID of the document to add',
          },
        },
        required: ['collectionId', 'docId'],
        additionalProperties: false,
      },
      execute: async ({ collectionId, docId }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .assert('Doc.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const rootDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            workspaceId
          );
          if (!rootDoc?.bin) return toolError('Workspace root doc not found');
          const rootBin = Buffer.isBuffer(rootDoc.bin)
            ? rootDoc.bin
            : Buffer.from(
                rootDoc.bin.buffer,
                rootDoc.bin.byteOffset,
                rootDoc.bin.byteLength
              );

          const collections = parseCollections(rootBin);
          const target = collections.find(c => c.id === collectionId);
          if (!target)
            return toolError(`Collection ID ${collectionId} not found`);

          if (target.allowList.includes(docId)) {
            return toolText(
              JSON.stringify({
                success: true,
                message: 'Doc already in collection',
              })
            );
          }

          const newAllowList = [...target.allowList, docId];
          const update = buildCollectionUpdate(
            rootBin,
            { id: collectionId, allowList: newAllowList },
            'update_allow_list'
          );
          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            workspaceId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              message: 'Added document to collection successfully',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to add doc to collection: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const removeDocFromCollection = defineTool({
      name: 'remove_doc_from_collection',
      title: 'Remove Document from Collection',
      description: 'Remove a document from a collection.',
      parser: z.object({ collectionId: z.string(), docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          collectionId: {
            type: 'string',
            description: 'The ID of the collection',
          },
          docId: {
            type: 'string',
            description: 'The ID of the document to remove',
          },
        },
        required: ['collectionId', 'docId'],
        additionalProperties: false,
      },
      execute: async ({ collectionId, docId }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const rootDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            workspaceId
          );
          if (!rootDoc?.bin) return toolError('Workspace root doc not found');
          const rootBin = Buffer.isBuffer(rootDoc.bin)
            ? rootDoc.bin
            : Buffer.from(
                rootDoc.bin.buffer,
                rootDoc.bin.byteOffset,
                rootDoc.bin.byteLength
              );

          const collections = parseCollections(rootBin);
          const target = collections.find(c => c.id === collectionId);
          if (!target)
            return toolError(`Collection ID ${collectionId} not found`);

          if (!target.allowList.includes(docId)) {
            return toolText(
              JSON.stringify({
                success: true,
                message: 'Doc not in collection',
              })
            );
          }

          const newAllowList = target.allowList.filter(id => id !== docId);
          const update = buildCollectionUpdate(
            rootBin,
            { id: collectionId, allowList: newAllowList },
            'update_allow_list'
          );
          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            workspaceId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              message: 'Removed document from collection successfully',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to remove doc from collection: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const listFolders = defineTool({
      name: 'list_folders',
      title: 'List Folders',
      description:
        'List all folders and hierarchical organization tree in the workspace.',
      parser: z.object({}),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async (_, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const folderDocId = `db$folders`;
          const folderDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            folderDocId
          );
          if (!folderDoc?.bin) {
            return toolText(JSON.stringify({ folders: [] }));
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
          return toolText(JSON.stringify({ folders: tree }, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list folders: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const createFolder = defineTool({
      name: 'create_folder',
      title: 'Create Folder',
      description:
        'Create a new folder in the workspace hierarchy. Use this when the user asks to create or add a new folder.',
      parser: z.object({
        name: z.string().min(1),
        parentId: z.string().optional(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The name of the folder to create',
          },
          parentId: {
            type: 'string',
            description: 'Optional parent folder ID',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
      execute: async ({ name, parentId }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.CreateDoc');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const folderDocId = `db$folders`;
          const folderDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            folderDocId
          );
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
              return toolError(`Parent folder ${parentId} not found`);
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

          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            folderDocId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify(
              {
                success: true,
                folder: {
                  id: folderId,
                  name,
                  parentId: parentId || null,
                  index,
                },
                message: `Folder '${name}' created successfully`,
              },
              null,
              2
            )
          );
        } catch (error) {
          return toolError(
            `Failed to create folder: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addDocToFolder = defineTool({
      name: 'add_doc_to_folder',
      title: 'Add Document to Folder',
      description: 'Move/add a document inside a folder.',
      parser: z.object({ folderId: z.string(), docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'The ID of the folder' },
          docId: {
            type: 'string',
            description: 'The ID of the document to add',
          },
        },
        required: ['folderId', 'docId'],
        additionalProperties: false,
      },
      execute: async ({ folderId, docId }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .doc(docId)
            .assert('Doc.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const folderDocId = `db$folders`;
          const folderDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            folderDocId
          );
          if (!folderDoc?.bin) return toolError('Folder database not found');
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
            return toolError(`Target folder ID ${folderId} not found`);
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

          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            folderDocId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              message: 'Successfully added document to folder',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to add doc to folder: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const removeDocFromFolder = defineTool({
      name: 'remove_doc_from_folder',
      title: 'Remove Document from Folder',
      description: 'Remove a document from a folder.',
      parser: z.object({ folderId: z.string(), docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'The ID of the folder' },
          docId: {
            type: 'string',
            description: 'The ID of the document to remove',
          },
        },
        required: ['folderId', 'docId'],
        additionalProperties: false,
      },
      execute: async ({ folderId, docId }, options) => {
        try {
          await this.ac
            .user(userId)
            .workspace(workspaceId)
            .assert('Workspace.Read');
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const folderDocId = `db$folders`;
          const folderDoc = await this.workspaceStorage.getDoc(
            workspaceId,
            folderDocId
          );
          if (!folderDoc?.bin)
            return toolText(
              JSON.stringify({
                success: true,
                message: 'Folder database not found',
              })
            );
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
            return toolText(
              JSON.stringify({
                success: true,
                message: 'Document not found in folder',
              })
            );
          }

          const update = buildFolderUpdate(existingBin, { id: link.id }, true);
          await this.workspaceStorage.pushDocUpdates(
            workspaceId,
            folderDocId,
            [update],
            userId
          );

          return toolText(
            JSON.stringify({
              success: true,
              message: 'Successfully removed document from folder',
            })
          );
        } catch (error) {
          return toolError(
            `Failed to remove doc from folder: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const webSearch = defineTool({
      name: 'web_search',
      title: 'Web Search',
      description:
        'Search the web for current information using a free search engine. Returns web page titles, URLs, and snippets.',
      parser: z.object({
        query: z.string(),
        limit: z.number().optional().default(10),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          limit: {
            type: 'number',
            description: 'Number of results to return. Default: 10',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async ({ query, limit }, options) => {
        try {
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;
          const results = await searchDuckDuckGo(query, limit);
          return toolText(JSON.stringify(results, null, 2));
        } catch (error) {
          return toolError(
            `Web search failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const urlContentRead = defineTool({
      name: 'url_content_read',
      title: 'URL Content Read',
      description:
        'Fetch and read the content of any web page URL. Extracts clean text content, removing ads and scripts.',
      parser: z.object({
        url: z.string(),
        maxLength: z.number().optional().default(50000),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to read (including http:// or https://)',
          },
          maxLength: {
            type: 'number',
            description:
              'Maximum characters to extract from the page. Default: 50000',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
      execute: async ({ url, maxLength }, options) => {
        try {
          const aborted = abortIfNeeded(options.signal);
          if (aborted) return aborted;

          const res = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; AFFiNE-Research-Bot/1.0)',
              Accept:
                'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

          const contentType = res.headers.get('content-type') || '';
          const html = await res.text();

          if (
            contentType.includes('application/json') ||
            contentType.includes('text/plain')
          ) {
            return toolText(
              JSON.stringify(
                {
                  title: url,
                  url,
                  content: html.slice(0, maxLength),
                  contentType: contentType.includes('application/json')
                    ? 'json'
                    : 'text',
                },
                null,
                2
              )
            );
          }

          const title = extractHtmlTag(html, 'title') || url;
          const content = htmlToCleanText(html, maxLength);
          const description = extractMeta(html, 'description');
          const author = extractMeta(html, 'author');

          return toolText(
            JSON.stringify(
              {
                title,
                url,
                description,
                author: author || null,
                content,
                contentType: 'html',
              },
              null,
              2
            )
          );
        } catch (error) {
          return toolError(
            `URL content read failed: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    // --- Tags Tools ---
    const listTagsHandler = buildTagListHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const createTagHandler = buildTagCreateHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const addTagToDocHandler = buildTagAddToDocHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const removeTagFromDocHandler = buildTagRemoveFromDocHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );

    const listTags = defineTool({
      name: 'list_tags',
      title: 'List Tags',
      description:
        'List all tags in the workspace. Returns tag IDs, values (names), and colors.',
      parser: z.object({}),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        try {
          const res = await listTagsHandler({
            user: userId,
            workspace: workspaceId,
          });
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list tags: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const createTag = defineTool({
      name: 'create_tag',
      title: 'Create Tag',
      description: 'Create a new tag in the workspace.',
      parser: z.object({ value: z.string().min(1) }),
      inputSchema: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            description: 'The name of the tag to create',
          },
        },
        required: ['value'],
        additionalProperties: false,
      },
      execute: async ({ value }) => {
        try {
          const res = await createTagHandler(
            { user: userId, workspace: workspaceId },
            value
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to create tag: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addTagToDoc = defineTool({
      name: 'add_tag_to_doc',
      title: 'Add Tag to Document',
      description: 'Add an existing tag to a document.',
      parser: z.object({ docId: z.string(), tagId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'The ID of the document' },
          tagId: { type: 'string', description: 'The ID of the tag to add' },
        },
        required: ['docId', 'tagId'],
        additionalProperties: false,
      },
      execute: async ({ docId, tagId }) => {
        try {
          const res = await addTagToDocHandler(
            { user: userId, workspace: workspaceId },
            docId,
            tagId
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to add tag to doc: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const removeTagFromDoc = defineTool({
      name: 'remove_tag_from_doc',
      title: 'Remove Tag from Document',
      description: 'Remove a tag from a document.',
      parser: z.object({ docId: z.string(), tagId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'The ID of the document' },
          tagId: { type: 'string', description: 'The ID of the tag to remove' },
        },
        required: ['docId', 'tagId'],
        additionalProperties: false,
      },
      execute: async ({ docId, tagId }) => {
        try {
          const res = await removeTagFromDocHandler(
            { user: userId, workspace: workspaceId },
            docId,
            tagId
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to remove tag from doc: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    // --- Favorites Tools ---
    const listFavoritesHandler = buildFavoriteListHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const addFavoriteHandler = buildFavoriteAddHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const removeFavoriteHandler = buildFavoriteRemoveHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );

    const listFavorites = defineTool({
      name: 'list_favorites',
      title: 'List Favorites',
      description: 'List all favorite items of the current user.',
      parser: z.object({}),
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        try {
          const res = await listFavoritesHandler({
            user: userId,
            workspace: workspaceId,
          });
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to list favorites: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addFavorite = defineTool({
      name: 'add_favorite',
      title: 'Add Favorite',
      description:
        "Add an item (document, tag, or collection) to the user's favorites.",
      parser: z.object({
        type: z.enum(['doc', 'collection', 'tag']),
        id: z.string(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['doc', 'collection', 'tag'],
            description: 'The type of item to favorite',
          },
          id: { type: 'string', description: 'The ID of the item to favorite' },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      },
      execute: async ({ type, id }) => {
        try {
          const res = await addFavoriteHandler(
            { user: userId, workspace: workspaceId },
            type,
            id
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to add favorite: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const removeFavorite = defineTool({
      name: 'remove_favorite',
      title: 'Remove Favorite',
      description:
        "Remove an item (document, tag, or collection) from the user's favorites.",
      parser: z.object({
        type: z.enum(['doc', 'collection', 'tag']),
        id: z.string(),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['doc', 'collection', 'tag'],
            description: 'The type of item to unfavorite',
          },
          id: {
            type: 'string',
            description: 'The ID of the item to unfavorite',
          },
        },
        required: ['type', 'id'],
        additionalProperties: false,
      },
      execute: async ({ type, id }) => {
        try {
          const res = await removeFavoriteHandler(
            { user: userId, workspace: workspaceId },
            type,
            id
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to remove favorite: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    // --- Database Tools ---
    const createDatabaseHandler = buildDatabaseCreateHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const queryDatabaseHandler = buildDatabaseQueryHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const addDatabaseRowHandler = buildDatabaseAddRowHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );
    const addDatabaseViewHandler = buildDatabaseAddViewHandler(
      this.ac,
      this.workspaceStorage,
      {} as any
    );

    const createDatabase = defineTool({
      name: 'create_database',
      title: 'Create Database',
      description:
        'Create a new document with a database block (Grid/Table view by default). Define custom columns and initial row data.',
      parser: z.object({
        title: z.string().min(1),
        columns: z.array(
          z.object({
            name: z.string(),
            type: z.enum([
              'title',
              'rich-text',
              'number',
              'select',
              'multi-select',
              'date',
              'checkbox',
            ]),
            options: z.array(z.string()).optional(),
          })
        ),
        rows: z.array(z.object({ cells: z.record(z.any()) })).optional(),
        viewMode: z.enum(['table', 'kanban']).optional().default('table'),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'The title of the database document',
          },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: {
                  type: 'string',
                  enum: [
                    'title',
                    'rich-text',
                    'number',
                    'select',
                    'multi-select',
                    'date',
                    'checkbox',
                  ],
                },
                options: { type: 'array', items: { type: 'string' } },
              },
              required: ['name', 'type'],
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                cells: { type: 'object' },
              },
              required: ['cells'],
            },
          },
          viewMode: {
            type: 'string',
            enum: ['table', 'kanban'],
            default: 'table',
          },
        },
        required: ['title', 'columns'],
        additionalProperties: false,
      },
      execute: async ({ title, columns, rows, viewMode }) => {
        try {
          const res = await createDatabaseHandler(
            { user: userId, workspace: workspaceId },
            title,
            columns,
            rows,
            viewMode
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to create database: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const queryDatabase = defineTool({
      name: 'query_database',
      title: 'Query Database',
      description:
        'Query and list the columns and rows of a database document.',
      parser: z.object({ docId: z.string() }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The ID of the document containing the database',
          },
        },
        required: ['docId'],
        additionalProperties: false,
      },
      execute: async ({ docId }) => {
        try {
          const res = await queryDatabaseHandler(
            { user: userId, workspace: workspaceId },
            docId
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to query database: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addDatabaseRow = defineTool({
      name: 'add_database_row',
      title: 'Add Database Row',
      description: 'Add a new row of data to an existing database document.',
      parser: z.object({
        docId: z.string(),
        cells: z.record(z.any()),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The ID of the database document',
          },
          cells: {
            type: 'object',
            description:
              'Key-value pairs mapping column names to cell values to insert',
          },
        },
        required: ['docId', 'cells'],
        additionalProperties: false,
      },
      execute: async ({ docId, cells }) => {
        try {
          const res = await addDatabaseRowHandler(
            { user: userId, workspace: workspaceId },
            docId,
            cells
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to add row to database: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      },
    });

    const addDatabaseView = defineTool({
      name: 'add_database_view',
      title: 'Add Database View',
      description:
        'Add a new view (table, kanban, gallery, or calendar) to an existing database.',
      parser: z.object({
        docId: z.string(),
        name: z.string(),
        mode: z.enum(['table', 'kanban', 'gallery', 'calendar']),
      }),
      inputSchema: {
        type: 'object',
        properties: {
          docId: {
            type: 'string',
            description: 'The ID of the database document',
          },
          name: { type: 'string', description: 'The name of the new view' },
          mode: {
            type: 'string',
            enum: ['table', 'kanban', 'gallery', 'calendar'],
            description: 'Layout mode for the new view',
          },
        },
        required: ['docId', 'name', 'mode'],
        additionalProperties: false,
      },
      execute: async ({ docId, name, mode }) => {
        try {
          const res = await addDatabaseViewHandler(
            { user: userId, workspace: workspaceId },
            docId,
            name,
            mode
          );
          return toolText(JSON.stringify(res, null, 2));
        } catch (error) {
          return toolError(
            `Failed to add database view: ${error instanceof Error ? error.message : 'Unknown error'}`
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
      updateKanbanTaskStatus,
      listCollections,
      createCollection,
      addDocToCollection,
      removeDocFromCollection,
      listFolders,
      createFolder,
      addDocToFolder,
      removeDocFromFolder,
      webSearch,
      urlContentRead,
      listTags,
      createTag,
      addTagToDoc,
      removeTagFromDoc,
      listFavorites,
      addFavorite,
      removeFavorite,
      createDatabase,
      queryDatabase,
      addDatabaseRow,
      addDatabaseView
    );

    return {
      name: `AFFiNE MCP Server for Workspace ${workspaceId}`,
      version: '1.0.1',
      tools,
    };
  }
}

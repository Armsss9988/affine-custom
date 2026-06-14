import { Injectable } from '@nestjs/common';

import { Config } from '../../../base';
import { DocReader, DocWriter } from '../../../core/doc';
import { PgWorkspaceDocStorageAdapter } from '../../../core/doc/adapters/workspace';
import { AccessController } from '../../../core/permission';
import { Models } from '../../../models';
import { IndexerService } from '../../indexer';
import type { NodeTextMiddleware } from '../config';
import { CopilotContextService } from '../context/service';
import {
  type CopilotChatOptions,
  type CopilotChatTools,
  type PromptMessage,
} from '../providers/types';
import {
  buildBlobContentGetter,
  buildCommentCreateHandler,
  buildCommentListHandler,
  buildCommentReplyHandler,
  buildCommentResolveHandler,
  buildDocContentGetter,
  buildDocCreateHandler,
  buildDocDeleteHandler,
  buildDocInfoHandler,
  buildDocKeywordSearchGetter,
  buildDocListHandler,
  buildDocRestoreHandler,
  buildDocSearchGetter,
  buildDocShareDisableHandler,
  buildDocShareEnableHandler,
  buildDocUpdateHandler,
  buildDocUpdateMetaHandler,
  buildJournalReadHandler,
  buildJournalWriteHandler,
  buildKanbanHandler,
  buildWorkspaceInfoHandler,
  type CopilotTool,
  type CopilotToolSet,
  createAcademicSearchTool,
  createArxivSearchTool,
  createBlobReadTool,
  createCitationFormatTool,
  createCodeArtifactTool,
  createCommentCreateTool,
  createCommentListTool,
  createCommentReplyTool,
  createCommentResolveTool,
  createConversationSummaryTool,
  createDocComposeTool,
  createDocCreateTool,
  createDocDeleteTool,
  createDocInfoTool,
  createDocKeywordSearchTool,
  createDocListTool,
  createDocReadTool,
  createDocRestoreTool,
  createDocSemanticSearchTool,
  createDocShareDisableTool,
  createDocShareEnableTool,
  createDocSynthesisTool,
  createDocUpdateMetaTool,
  createDocUpdateTool,
  createExaCrawlTool,
  createExaSearchTool,
  createFreeWebSearchTool,
  createJournalReadTool,
  createJournalWriteTool,
  createKanbanTool,
  createSectionEditTool,
  createTranslateTextTool,
  createUrlContentReadTool,
  createWikipediaSearchTool,
  createWorkspaceInfoTool,
  getConfiguredExaKey,
  // Phase 2
  buildTagListHandler,
  buildTagCreateHandler,
  buildTagAddToDocHandler,
  buildTagRemoveFromDocHandler,
  buildFavoriteListHandler,
  buildFavoriteAddHandler,
  buildFavoriteRemoveHandler,
  buildCollectionListHandler,
  buildCollectionCreateHandler,
  buildCollectionAddDocHandler,
  buildCollectionRemoveDocHandler,
  buildFolderListHandler,
  buildFolderCreateHandler,
  buildFolderAddDocHandler,
  buildFolderRemoveDocHandler,
  createTagListTool,
  createTagCreateTool,
  createTagAddToDocTool,
  createTagRemoveFromDocTool,
  createFavoriteListTool,
  createFavoriteAddTool,
  createFavoriteRemoveTool,
  createCollectionListTool,
  createCollectionCreateTool,
  createCollectionAddDocTool,
  createCollectionRemoveDocTool,
  createFolderListTool,
  createFolderCreateTool,
  createFolderAddDocTool,
  createFolderRemoveDocTool,
  // Phase 3
  buildDatabaseCreateHandler,
  buildDatabaseQueryHandler,
  buildDatabaseAddRowHandler,
  buildDatabaseAddViewHandler,
  createDatabaseCreateTool,
  createDatabaseQueryTool,
  createDatabaseAddRowTool,
  createDatabaseAddViewTool,
} from '../tools';
import { PromptRuntime } from './prompt-runtime';
import type { ToolLoopBackend } from './tool/bridge';
import { createNativeToolLoopAdapter } from './tool/native-adapter';

export type ProviderSpecificToolResolver = (
  toolName: CopilotChatTools,
  model: string
) => [string, CopilotTool?] | undefined;

@Injectable()
export class ToolRuntime {
  constructor(
    private readonly config: Config,
    private readonly ac: AccessController,
    private readonly context: CopilotContextService,
    private readonly docReader: DocReader,
    private readonly docWriter: DocWriter,
    private readonly storage: PgWorkspaceDocStorageAdapter,
    private readonly models: Models,
    private readonly promptRuntime: PromptRuntime,
    private readonly indexerService: IndexerService
  ) {}

  async getTools(
    options: CopilotChatOptions,
    model: string,
    resolveProviderSpecificTool?: ProviderSpecificToolResolver
  ): Promise<CopilotToolSet> {
    const tools: CopilotToolSet = {};
    if (!options?.tools?.length) {
      return tools;
    }

    let syncedWorkspaceAvailable: Promise<boolean> | undefined;
    const canUseSyncedWorkspaceTools = async () => {
      if (!options.workspace) {
        return true;
      }
      syncedWorkspaceAvailable ??= this.models.workspace
        .get(options.workspace)
        .then(Boolean);
      return await syncedWorkspaceAvailable;
    };

    const runPromptText = (
      promptName: string,
      params: Record<string, unknown>,
      promptOptions?: { appendMessages?: PromptMessage[] }
    ) =>
      this.promptRuntime.runText(promptName, params, {
        appendMessages: promptOptions?.appendMessages,
        providerOptions: {
          user: options.user,
          session: options.session,
          workspace: options.workspace,
          byokLeaseId: options.byokLeaseId,
          billingUnitId: options.billingUnitId,
          quotaBackedRoutesAllowed: options.quotaBackedRoutesAllowed,
          featureKind: options.featureKind,
        },
      });

    for (const tool of options.tools) {
      const toolDef = resolveProviderSpecificTool?.(tool, model);
      if (toolDef) {
        if (toolDef[1]) {
          tools[toolDef[0]] = toolDef[1];
        }
        continue;
      }

      if (
        !(env.dev || env.namespaces.canary) &&
        ['docCreate', 'docUpdate', 'docUpdateMeta'].includes(tool)
      ) {
        continue;
      }

      switch (tool) {
        case 'blobRead': {
          const docContext = options.session
            ? await this.context.getBySessionId(options.session)
            : null;
          const getBlobContent = buildBlobContentGetter(this.ac, docContext);
          tools.blob_read = createBlobReadTool(
            getBlobContent.bind(null, options)
          );
          break;
        }
        case 'codeArtifact': {
          tools.code_artifact = createCodeArtifactTool(runPromptText);
          break;
        }
        case 'conversationSummary': {
          tools.conversation_summary = createConversationSummaryTool(
            options.session,
            runPromptText
          );
          break;
        }
        case 'docSemanticSearch': {
          if (!(await canUseSyncedWorkspaceTools())) {
            break;
          }
          const searchDocs = buildDocSearchGetter(
            this.ac,
            this.context,
            options.session,
            this.models
          );
          tools.doc_semantic_search = createDocSemanticSearchTool(
            searchDocs.bind(null, options)
          );
          break;
        }
        case 'docKeywordSearch': {
          if (
            this.config.indexer.enabled &&
            (await canUseSyncedWorkspaceTools())
          ) {
            const searchDocs = buildDocKeywordSearchGetter(
              this.ac,
              this.indexerService,
              this.models
            );
            tools.doc_keyword_search = createDocKeywordSearchTool(
              searchDocs.bind(null, options)
            );
          }
          break;
        }
        case 'docRead': {
          if (!(await canUseSyncedWorkspaceTools())) {
            break;
          }
          const getDoc = buildDocContentGetter(
            this.ac,
            this.docReader,
            this.models
          );
          tools.doc_read = createDocReadTool(getDoc.bind(null, options));
          break;
        }
        case 'docCreate': {
          const createDoc = buildDocCreateHandler(this.ac, this.docWriter);
          tools.doc_create = createDocCreateTool(createDoc.bind(null, options));
          break;
        }
        case 'docUpdate': {
          const updateDoc = buildDocUpdateHandler(this.ac, this.docWriter);
          tools.doc_update = createDocUpdateTool(updateDoc.bind(null, options));
          break;
        }
        case 'docUpdateMeta': {
          const updateDocMeta = buildDocUpdateMetaHandler(
            this.ac,
            this.docWriter
          );
          tools.doc_update_meta = createDocUpdateMetaTool(
            updateDocMeta.bind(null, options)
          );
          break;
        }
        case 'webSearch': {
          if (getConfiguredExaKey(this.config)) {
            tools.web_search_exa = createExaSearchTool(this.config);
            tools.web_crawl_exa = createExaCrawlTool(this.config);
          }
          break;
        }
        case 'docCompose': {
          tools.doc_compose = createDocComposeTool(runPromptText);
          break;
        }
        case 'sectionEdit': {
          tools.section_edit = createSectionEditTool(runPromptText);
          break;
        }
        case 'kanbanCreate': {
          const createKanban = buildKanbanHandler(this.ac, this.docWriter);
          tools.kanban_create = createKanbanTool(
            createKanban.bind(null, options)
          );
          break;
        }
        // ===== Doc Lifecycle Tools =====
        case 'docList': {
          const listDocs = buildDocListHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.doc_list = createDocListTool(listDocs.bind(null, options));
          break;
        }
        case 'docDelete': {
          const deleteDoc = buildDocDeleteHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.doc_delete = createDocDeleteTool(deleteDoc.bind(null, options));
          break;
        }
        case 'docRestore': {
          const restoreDoc = buildDocRestoreHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.doc_restore = createDocRestoreTool(
            restoreDoc.bind(null, options)
          );
          break;
        }
        case 'docInfo': {
          const getDocInfo = buildDocInfoHandler(
            this.ac,
            this.docReader,
            this.models
          );
          tools.doc_info = createDocInfoTool(getDocInfo.bind(null, options));
          break;
        }
        // ===== Sharing Tools =====
        case 'docShareEnable': {
          const enableShare = buildDocShareEnableHandler(this.ac, this.models);
          tools.doc_share_enable = createDocShareEnableTool(
            enableShare.bind(null, options)
          );
          break;
        }
        case 'docShareDisable': {
          const disableShare = buildDocShareDisableHandler(
            this.ac,
            this.models
          );
          tools.doc_share_disable = createDocShareDisableTool(
            disableShare.bind(null, options)
          );
          break;
        }
        // ===== Comment Tools =====
        case 'commentList': {
          const listComments = buildCommentListHandler(this.ac, this.models);
          tools.comment_list = createCommentListTool(
            listComments.bind(null, options)
          );
          break;
        }
        case 'commentCreate': {
          const createComment = buildCommentCreateHandler(this.ac, this.models);
          tools.comment_create = createCommentCreateTool(
            createComment.bind(null, options)
          );
          break;
        }
        case 'commentReply': {
          const replyComment = buildCommentReplyHandler(this.ac, this.models);
          tools.comment_reply = createCommentReplyTool(
            replyComment.bind(null, options)
          );
          break;
        }
        case 'commentResolve': {
          const resolveComment = buildCommentResolveHandler(
            this.ac,
            this.models
          );
          tools.comment_resolve = createCommentResolveTool(
            resolveComment.bind(null, options)
          );
          break;
        }
        // ===== Workspace Info =====
        case 'workspaceInfo': {
          const getInfo = buildWorkspaceInfoHandler(this.ac, this.models);
          tools.workspace_info = createWorkspaceInfoTool(
            getInfo.bind(null, options)
          );
          break;
        }
        // ===== Journal Tools =====
        case 'journalRead': {
          const readJournal = buildJournalReadHandler(
            this.ac,
            this.storage,
            this.docReader,
            this.models
          );
          tools.journal_read = createJournalReadTool(
            readJournal.bind(null, options)
          );
          break;
        }
        case 'journalWrite': {
          const writeJournal = buildJournalWriteHandler(
            this.ac,
            this.storage,
            this.docReader,
            this.docWriter,
            this.models
          );
          tools.journal_write = createJournalWriteTool(
            writeJournal.bind(null, options)
          );
          break;
        }
        // ===== Research Tools =====
        case 'academicSearch': {
          tools.academic_search = createAcademicSearchTool();
          break;
        }
        case 'arxivSearch': {
          tools.arxiv_search = createArxivSearchTool();
          break;
        }
        case 'webSearchFree': {
          tools.web_search_free = createFreeWebSearchTool(this.config);
          break;
        }
        case 'urlContentRead': {
          tools.url_content_read = createUrlContentReadTool();
          break;
        }
        case 'wikipediaSearch': {
          tools.wikipedia_search = createWikipediaSearchTool();
          break;
        }
        case 'citationFormat': {
          tools.citation_format = createCitationFormatTool();
          break;
        }
        case 'translateText': {
          tools.translate_text = createTranslateTextTool(runPromptText);
          break;
        }
        case 'docSynthesis': {
          if (!(await canUseSyncedWorkspaceTools())) {
            break;
          }
          const getDoc = buildDocContentGetter(
            this.ac,
            this.docReader,
            this.models
          );
          tools.doc_synthesis = createDocSynthesisTool(
            getDoc.bind(null, options),
            runPromptText
          );
          break;
        }
        // ===== Phase 2: Organization =====
        case 'tagList': {
          const listTags = buildTagListHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.tag_list = createTagListTool(listTags.bind(null, options));
          break;
        }
        case 'tagCreate': {
          const createTag = buildTagCreateHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.tag_create = createTagCreateTool(createTag.bind(null, options));
          break;
        }
        case 'tagAddToDoc': {
          const addTag = buildTagAddToDocHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.tag_add_to_doc = createTagAddToDocTool(
            addTag.bind(null, options)
          );
          break;
        }
        case 'tagRemoveFromDoc': {
          const removeTag = buildTagRemoveFromDocHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.tag_remove_from_doc = createTagRemoveFromDocTool(
            removeTag.bind(null, options)
          );
          break;
        }
        case 'favoriteList': {
          const listFavorites = buildFavoriteListHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.favorite_list = createFavoriteListTool(
            listFavorites.bind(null, options)
          );
          break;
        }
        case 'favoriteAdd': {
          const addFavorite = buildFavoriteAddHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.favorite_add = createFavoriteAddTool(
            addFavorite.bind(null, options)
          );
          break;
        }
        case 'favoriteRemove': {
          const removeFavorite = buildFavoriteRemoveHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.favorite_remove = createFavoriteRemoveTool(
            removeFavorite.bind(null, options)
          );
          break;
        }
        case 'collectionList': {
          const listCollections = buildCollectionListHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.collection_list = createCollectionListTool(
            listCollections.bind(null, options)
          );
          break;
        }
        case 'collectionCreate': {
          const createCollection = buildCollectionCreateHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.collection_create = createCollectionCreateTool(
            createCollection.bind(null, options)
          );
          break;
        }
        case 'collectionAddDoc': {
          const addDoc = buildCollectionAddDocHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.collection_add_doc = createCollectionAddDocTool(
            addDoc.bind(null, options)
          );
          break;
        }
        case 'collectionRemoveDoc': {
          const removeDoc = buildCollectionRemoveDocHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.collection_remove_doc = createCollectionRemoveDocTool(
            removeDoc.bind(null, options)
          );
          break;
        }
        case 'folderList': {
          const listFolders = buildFolderListHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.folder_list = createFolderListTool(
            listFolders.bind(null, options)
          );
          break;
        }
        case 'folderCreate': {
          const createFolder = buildFolderCreateHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.folder_create = createFolderCreateTool(
            createFolder.bind(null, options)
          );
          break;
        }
        case 'folderAddDoc': {
          const addDoc = buildFolderAddDocHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.folder_add_doc = createFolderAddDocTool(
            addDoc.bind(null, options)
          );
          break;
        }
        case 'folderRemoveDoc': {
          const removeDoc = buildFolderRemoveDocHandler(
            this.ac,
            this.storage,
            this.models,
            this.docWriter
          );
          tools.folder_remove_doc = createFolderRemoveDocTool(
            removeDoc.bind(null, options)
          );
          break;
        }
        // ===== Phase 3: Database =====
        case 'databaseCreate': {
          const createDb = buildDatabaseCreateHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.database_create = createDatabaseCreateTool(
            createDb.bind(null, options)
          );
          break;
        }
        case 'databaseQuery': {
          const queryDb = buildDatabaseQueryHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.database_query = createDatabaseQueryTool(
            queryDb.bind(null, options)
          );
          break;
        }
        case 'databaseAddRow': {
          const addRow = buildDatabaseAddRowHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.database_add_row = createDatabaseAddRowTool(
            addRow.bind(null, options)
          );
          break;
        }
        case 'databaseAddView': {
          const addView = buildDatabaseAddViewHandler(
            this.ac,
            this.storage,
            this.models
          );
          tools.database_add_view = createDatabaseAddViewTool(
            addView.bind(null, options)
          );
          break;
        }
      }
    }

    return tools;
  }

  createNativeAdapter(
    backend: ToolLoopBackend,
    tools: CopilotToolSet,
    options: {
      maxSteps?: number;
      nodeTextMiddleware?: NodeTextMiddleware[];
    } = {}
  ) {
    return createNativeToolLoopAdapter(backend, tools, options);
  }
}

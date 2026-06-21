import { LitElement, html, css } from 'lit';
import { property, state, query } from 'lit/decorators.js';
import { WithDisposable } from '@blocksuite/affine/global/lit';
import type { EditorHost } from '@blocksuite/affine/std';
import type { BaseSelection } from '@blocksuite/affine/store';
import type { FrameworkProvider } from '@toeverything/infra';
import { AIProvider } from '../provider';
import { AIChatContent } from './ai-chat-content/ai-chat-content';
import { DocCommentManagerService } from '../../../modules/comment/services/doc-comment-manager';
import { getPreviewFromSelections } from '../../view-extensions/comment/comment-provider';
import { NotificationProvider } from '@blocksuite/affine/shared/services';
import { AIReasoningService } from '@affine/core/modules/ai-button/services/reasoning';
import { CollectionService } from '@affine/core/modules/collection';
import { DocsService } from '@affine/core/modules/doc';
import { DocDisplayMetaService } from '@affine/core/modules/doc-display-meta';
import { DocsSearchService } from '@affine/core/modules/docs-search';
import { TagService } from '@affine/core/modules/tag';
import { WorkspaceService } from '@affine/core/modules/workspace';
import { SearchMenuService } from '@affine/core/modules/search-menu/services';
import { ServerService, SubscriptionService } from '@affine/core/modules/cloud';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { WorkspaceDialogService } from '@affine/core/modules/dialogs';
import { AppThemeService } from '@affine/core/modules/theme';
import {
  AIDraftService,
  AIToolsConfigService,
} from '@affine/core/modules/ai-button';
import { AIModelService } from '@affine/core/modules/ai-button/services/models';
import { PeekViewService } from '@affine/core/modules/peek-view';
import { createSignalFromObservable } from '@blocksuite/affine/shared/utils';
import { extractSelectedContent } from '../utils/extract';
import { isChatMessage, isChatAction } from './ai-chat-messages';
import { CloseIcon, CommentIcon } from '@blocksuite/icons/lit';

export class AskAIChatDialog extends WithDisposable(LitElement) {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 420px;
      height: 520px;
      border-radius: 8px;
      border: 1px solid var(--affine-border-color, #e3e3e3);
      background: var(--affine-background-overlay-panel-color, #ffffff);
      box-shadow: var(--affine-overlay-shadow, 0 4px 12px rgba(0, 0, 0, 0.1));
      z-index: var(--affine-z-index-popover, 99);
      font-family: var(--affine-font-sans-family);
      overflow: hidden;
    }

    .dialog-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      border-bottom: 1px solid var(--affine-border-color, #e3e3e3);
      background: var(--affine-background-secondary-color, #f9f9f9);
      user-select: none;
    }

    .dialog-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--affine-text-primary-color, #1f1f1f);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .action-button {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid var(--affine-border-color, #e3e3e3);
      background: var(--affine-background-primary-color, #ffffff);
      color: var(--affine-text-primary-color, #1f1f1f);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
    }

    .action-button:hover:not(:disabled) {
      background: var(--affine-background-hover-color, #f0f0f0);
    }

    .action-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .close-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 4px;
      border: none;
      background: transparent;
      color: var(--affine-text-secondary-color, #8a8a8a);
      cursor: pointer;
      transition:
        background 0.15s,
        color 0.15s;
    }

    .close-button:hover {
      background: var(--affine-background-hover-color, #f0f0f0);
      color: var(--affine-text-primary-color, #1f1f1f);
    }

    .dialog-body {
      flex: 1;
      height: 0;
      position: relative;
    }

    ai-chat-content {
      height: 100% !important;
      width: 100% !important;
    }
  `;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor framework!: FrameworkProvider;

  @property({ attribute: false })
  accessor selections!: BaseSelection[];

  @property({ attribute: false })
  accessor workspaceId!: string;

  @property({ attribute: false })
  accessor docId!: string;

  @property({ attribute: false })
  accessor initialPrompt!: string;

  @property({ attribute: false })
  accessor onClose!: () => void;

  @state()
  private accessor session: any = null;

  @state()
  private accessor isCreatingSession = true;

  @state()
  private accessor isAddingComment = false;

  @query('ai-chat-content')
  private accessor chatContentElement!: AIChatContent | null;

  private _cleanedUp = false;

  private async _createTempSession() {
    this.isCreatingSession = true;
    try {
      const session = await AIProvider.session?.createSessionWithHistory({
        docId: this.docId,
        workspaceId: this.workspaceId,
        promptName: 'Chat With AFFiNE AI',
        reuseLatestChat: false,
      });
      this.session = session;
    } catch (e) {
      console.error('Failed to create temporary AI chat session:', e);
    } finally {
      this.isCreatingSession = false;
    }

    if (this.session) {
      // Trigger initial prompt in next tick after DOM renders
      setTimeout(async () => {
        const chatInput = this.shadowRoot?.querySelector(
          'ai-chat-input'
        ) as any;
        if (chatInput) {
          const context = await extractSelectedContent(this.host);
          if (context) {
            chatInput.updateContext?.(context);
          }
          chatInput.send?.(this.initialPrompt);
        }
      }, 100);
    }
  }

  private async _cleanupSession() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    if (this.session?.sessionId) {
      try {
        await AIProvider.histories?.cleanup(this.workspaceId, this.docId, [
          this.session.sessionId,
        ]);
      } catch (e) {
        console.error('Failed to clean up temporary AI chat session:', e);
      }
    }
  }

  async addAsComment() {
    if (this.isAddingComment || !this.chatContentElement) return;
    this.isAddingComment = true;

    try {
      const messages = this.chatContentElement.messages;
      if (!messages || messages.length === 0) {
        alert('Chưa có nội dung hội thoại nào để thêm vào comment.');
        this.isAddingComment = false;
        return;
      }

      // Format chat history
      const formatted: string[] = [];
      messages.forEach(msg => {
        if (isChatMessage(msg)) {
          const roleName = msg.role === 'user' ? 'User' : 'AI';
          formatted.push(`**${roleName}:** ${msg.content}`);
        } else if (isChatAction(msg)) {
          msg.messages.forEach(subMsg => {
            const roleName = subMsg.role === 'user' ? 'User' : 'AI';
            formatted.push(`**${roleName}:** ${subMsg.content}`);
          });
        }
      });
      const commentText = formatted.join('\n\n');

      // Create comment thread programmatically
      const docCommentManager = this.framework.get(DocCommentManagerService);
      docCommentManager.std = this.host.std;
      const commentEntity = docCommentManager.get(this.docId).obj;

      const preview = getPreviewFromSelections(this.host.std, this.selections);
      const commentId = await commentEntity.addComment(
        this.selections,
        preview
      );

      const pendingComment = commentEntity.pendingComment$.value;
      if (pendingComment && pendingComment.id === commentId) {
        const store = pendingComment.doc;
        const paragraph = store.getModelsByFlavour('affine:paragraph')[0];
        if (paragraph && paragraph.text) {
          paragraph.text.insert(commentText, 0);
        }
        await commentEntity.commitComment(commentId);

        // Show toast using NotificationProvider
        const notificationProvider =
          this.host.std.getOptional(NotificationProvider);
        notificationProvider?.toast('Thêm comment thành công');
      }

      // Close dialog
      this.closeDialog();
    } catch (e) {
      console.error('Failed to add chat as comment:', e);
      alert('Không thể tạo comment từ cuộc hội thoại này.');
    } finally {
      this.isAddingComment = false;
    }
  }

  closeDialog() {
    this._cleanupSession().catch(console.error);
    this.onClose();
  }

  override connectedCallback() {
    super.connectedCallback();
    this._createTempSession().catch(console.error);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSession().catch(console.error);
  }

  override render() {
    if (this.isCreatingSession) {
      return html`
        <div class="dialog-header">
          <span class="dialog-title">AI Chat (Đang kết nối...)</span>
          <button class="close-button" @click=${this.closeDialog}>
            ${CloseIcon()}
          </button>
        </div>
        <div
          class="dialog-body"
          style="display:flex;align-items:center;justify-content:center;color:var(--affine-text-secondary-color)"
        >
          Đang khởi tạo phiên chat...
        </div>
      `;
    }

    if (!this.session) {
      return html`
        <div class="dialog-header">
          <span class="dialog-title">AI Chat (Lỗi)</span>
          <button class="close-button" @click=${this.closeDialog}>
            ${CloseIcon()}
          </button>
        </div>
        <div
          class="dialog-body"
          style="display:flex;align-items:center;justify-content:center;color:var(--affine-text-secondary-color)"
        >
          Không thể khởi tạo phiên chat AI. Vui lòng thử lại.
        </div>
      `;
    }

    // Resolve configs for AIChatContent
    const reasoningService = this.framework.get(AIReasoningService);
    const docDisplayMetaService = this.framework.get(DocDisplayMetaService);
    const workspaceService = this.framework.get(WorkspaceService);
    const searchMenuService = this.framework.get(SearchMenuService);
    const docsSearchService = this.framework.get(DocsSearchService);
    const tagService = this.framework.get(TagService);
    const collectionService = this.framework.get(CollectionService);
    const docsService = this.framework.get(DocsService);

    const reasoningConfig = {
      enabled: reasoningService.enabled,
      setEnabled: reasoningService.setEnabled,
    };

    const docDisplayConfig = {
      getIcon: (docId: string) => {
        return docDisplayMetaService.icon$(docId, { type: 'lit' }).value;
      },
      getTitle: (docId: string) => {
        return docDisplayMetaService.title$(docId).value;
      },
      getTitleSignal: (docId: string) => {
        const title$ = docDisplayMetaService.title$(docId);
        return createSignalFromObservable(title$, '');
      },
      getDocMeta: (docId: string) => {
        const docRecord = docsService.list.doc$(docId).value;
        return docRecord?.meta$.value ?? null;
      },
      getDocPrimaryMode: (docId: string) => {
        const docRecord = docsService.list.doc$(docId).value;
        return docRecord?.primaryMode$.value ?? 'page';
      },
      getDoc: (docId: string) => {
        const doc = workspaceService.workspace.docCollection.getDoc(docId);
        return doc?.getStore() ?? null;
      },
      getReferenceDocs: (docIds: string[]) => {
        const docs$ = docsSearchService.watchRefsFrom(docIds);
        return createSignalFromObservable(docs$, []);
      },
      getTags: () => {
        const tagMetas$ = tagService.tagList.tagMetas$;
        return createSignalFromObservable(tagMetas$, []);
      },
      getTagTitle: (tagId: string) => {
        const tag$ = tagService.tagList.tagByTagId$(tagId);
        return tag$.value?.value$.value ?? '';
      },
      getTagPageIds: (tagId: string) => {
        const tag$ = tagService.tagList.tagByTagId$(tagId);
        if (!tag$) return [];
        return tag$.value?.pageIds$.value ?? [];
      },
      getCollections: () => {
        const collectionMetas$ = collectionService.collectionMetas$;
        return createSignalFromObservable(collectionMetas$, []);
      },
      getCollectionPageIds: (collectionId: string) => {
        const collection$ = collectionService.collection$(collectionId);
        return collection$.value?.info$.value.allowList ?? [];
      },
    };

    const searchMenuConfig = {
      getDocMenuGroup: (
        query: string,
        action: any,
        abortSignal: AbortSignal
      ) => {
        return searchMenuService.getDocMenuGroup(query, action, abortSignal);
      },
      getTagMenuGroup: (
        query: string,
        action: any,
        abortSignal: AbortSignal
      ) => {
        return searchMenuService.getTagMenuGroup(query, action, abortSignal);
      },
      getCollectionMenuGroup: (
        query: string,
        action: any,
        abortSignal: AbortSignal
      ) => {
        return searchMenuService.getCollectionMenuGroup(
          query,
          action,
          abortSignal
        );
      },
    };

    const notificationService = this.host.std.get(NotificationProvider);

    return html`
      <div class="dialog-header">
        <span class="dialog-title">AI Chat</span>
        <div class="header-actions">
          <button
            class="action-button"
            ?disabled=${this.isAddingComment}
            @click=${this.addAsComment}
          >
            ${CommentIcon()} Add as comment
          </button>
          <button class="close-button" @click=${this.closeDialog}>
            ${CloseIcon()}
          </button>
        </div>
      </div>
      <div class="dialog-body">
        <ai-chat-content
          .independentMode=${true}
          .host=${this.host}
          .session=${this.session}
          .workspaceId=${this.workspaceId}
          .docId=${this.docId}
          .reasoningConfig=${reasoningConfig}
          .searchMenuConfig=${searchMenuConfig}
          .docDisplayConfig=${docDisplayConfig}
          .extensions=${[]}
          .serverService=${this.framework.get(ServerService)}
          .affineFeatureFlagService=${this.framework.get(FeatureFlagService)}
          .affineWorkspaceDialogService=${this.framework.get(
            WorkspaceDialogService
          )}
          .affineThemeService=${this.framework.get(AppThemeService)}
          .notificationService=${notificationService}
          .aiDraftService=${this.framework.get(AIDraftService)}
          .aiToolsConfigService=${this.framework.get(AIToolsConfigService)}
          .peekViewService=${this.framework.get(PeekViewService)}
          .subscriptionService=${this.framework.get(SubscriptionService)}
          .aiModelService=${this.framework.get(AIModelService)}
        ></ai-chat-content>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ask-ai-chat-dialog': AskAIChatDialog;
  }
}

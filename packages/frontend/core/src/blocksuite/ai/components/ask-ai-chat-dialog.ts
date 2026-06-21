import { LitElement, html, css, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { ref } from 'lit/directives/ref.js';
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
import { isChatMessage, isChatAction } from './ai-chat-messages';
import { CloseIcon, CommentIcon } from '@blocksuite/icons/lit';
import type { CopilotChatHistoryFragment } from '@affine/graphql';

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
      min-height: 0;
      position: relative;
      overflow: hidden;
    }

    .loading-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--affine-text-secondary-color, #8a8a8a);
      font-size: 14px;
    }

    .error-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--affine-text-secondary-color, #8a8a8a);
      font-size: 14px;
      padding: 16px;
      text-align: center;
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
  private accessor session: CopilotChatHistoryFragment | null | undefined =
    undefined;

  @state()
  private accessor isCreatingSession = true;

  @state()
  private accessor isAddingComment = false;

  private _chatContentEl: AIChatContent | null = null;

  private _cleanedUp = false;

  private readonly _createTempSession = async (): Promise<
    CopilotChatHistoryFragment | undefined
  > => {
    if (!AIProvider.session) return undefined;
    const session = await AIProvider.session.createSessionWithHistory({
      docId: this.docId,
      workspaceId: this.workspaceId,
      promptName: 'Chat With AFFiNE AI',
      reuseLatestChat: false,
    });
    return session ?? undefined;
  };

  private async _initSession() {
    this.isCreatingSession = true;
    try {
      const session = await this._createTempSession();
      this.session = session ?? null;
    } catch (e) {
      console.error('Failed to create temporary AI chat session:', e);
      this.session = null;
    } finally {
      this.isCreatingSession = false;
    }

    // After session is ready + DOM updates, send initialPrompt
    if (this.session) {
      await this.updateComplete;
      // Small delay to allow ai-chat-content to finish rendering
      setTimeout(() => {
        const chatInput = this._chatContentEl?.shadowRoot?.querySelector(
          'ai-chat-composer'
        ) as any;
        const inputEl = chatInput?.shadowRoot?.querySelector(
          'ai-chat-input'
        ) as any;
        if (inputEl && this.initialPrompt) {
          inputEl.send?.(this.initialPrompt);
        }
      }, 300);
    }
  }

  private async _cleanupSession() {
    if (this._cleanedUp) return;
    this._cleanedUp = true;
    const sessionId = this.session?.sessionId;
    if (sessionId) {
      try {
        await AIProvider.histories?.cleanup(this.workspaceId, this.docId, [
          sessionId,
        ]);
      } catch (e) {
        console.error('Failed to clean up temporary AI chat session:', e);
      }
    }
  }

  private readonly _closeDialog = () => {
    this._cleanupSession().catch(console.error);
    this.onClose();
  };

  private readonly _addAsComment = async () => {
    if (this.isAddingComment || !this._chatContentEl) return;
    this.isAddingComment = true;

    try {
      const messages = this._chatContentEl.messages;
      if (!messages || messages.length === 0) {
        alert('Chưa có nội dung hội thoại nào để thêm vào comment.');
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

        // Show toast
        const notificationProvider =
          this.host.std.getOptional(NotificationProvider);
        notificationProvider?.toast('Thêm comment thành công');
      }

      this._closeDialog();
    } catch (e) {
      console.error('Failed to add chat as comment:', e);
      alert('Không thể tạo comment từ cuộc hội thoại này.');
    } finally {
      this.isAddingComment = false;
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this._initSession().catch(console.error);
  }

  override updated(changedProperties: PropertyValues) {
    super.updated(changedProperties);
    // When session becomes available, update chat content props
    if (changedProperties.has('session') && this.session) {
      this._updateChatContentProps();
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._cleanupSession().catch(console.error);
  }

  private _mountChatContent(container: HTMLElement | null) {
    if (!container) {
      this._chatContentEl = null;
      return;
    }

    // Avoid re-mounting if already attached
    if (
      this._chatContentEl &&
      this._chatContentEl.parentElement === container
    ) {
      // Update mutable props
      this._updateChatContentProps();
      return;
    }

    // Clean up any previous element
    if (this._chatContentEl) {
      this._chatContentEl.remove();
    }

    const el = new AIChatContent();
    this._chatContentEl = el;
    this._updateChatContentProps();
    container.appendChild(el);
  }

  private _updateChatContentProps() {
    const el = this._chatContentEl;
    if (!el || !this.session) return;

    const reasoningService = this.framework.get(AIReasoningService);
    const docDisplayMetaService = this.framework.get(DocDisplayMetaService);
    const workspaceService = this.framework.get(WorkspaceService);
    const searchMenuService = this.framework.get(SearchMenuService);
    const docsSearchService = this.framework.get(DocsSearchService);
    const tagService = this.framework.get(TagService);
    const collectionService = this.framework.get(CollectionService);
    const docsService = this.framework.get(DocsService);

    el.independentMode = true;
    el.host = this.host;
    el.session = this.session;
    el.createSession = this._createTempSession;
    el.workspaceId = this.workspaceId;
    el.docId = this.docId;
    el.extensions = [];
    el.reasoningConfig = {
      enabled: reasoningService.enabled,
      setEnabled: reasoningService.setEnabled,
    };
    el.docDisplayConfig = {
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
    el.searchMenuConfig = {
      getDocMenuGroup: (query: string, action: any, abortSignal: AbortSignal) =>
        searchMenuService.getDocMenuGroup(query, action, abortSignal),
      getTagMenuGroup: (query: string, action: any, abortSignal: AbortSignal) =>
        searchMenuService.getTagMenuGroup(query, action, abortSignal),
      getCollectionMenuGroup: (
        query: string,
        action: any,
        abortSignal: AbortSignal
      ) => searchMenuService.getCollectionMenuGroup(query, action, abortSignal),
    };
    el.serverService = this.framework.get(ServerService);
    el.affineFeatureFlagService = this.framework.get(FeatureFlagService);
    el.affineWorkspaceDialogService = this.framework.get(
      WorkspaceDialogService
    );
    el.affineThemeService = this.framework.get(AppThemeService);
    el.notificationService = this.host.std.get(NotificationProvider);
    el.aiDraftService = this.framework.get(AIDraftService);
    el.aiToolsConfigService = this.framework.get(AIToolsConfigService);
    el.peekViewService = this.framework.get(PeekViewService);
    el.subscriptionService = this.framework.get(SubscriptionService);
    el.aiModelService = this.framework.get(AIModelService);
    el.onContextChange = () => {};
    el.onOpenDoc = () => {};
    el.onAISubscribe = async () => {};
    el.style.cssText =
      'display:flex;flex-direction:column;height:100%;width:100%;';
  }

  override render() {
    const headerTitle = this.isCreatingSession
      ? 'AI Chat (Đang kết nối...)'
      : !this.session
        ? 'AI Chat (Lỗi)'
        : 'AI Chat';

    const body = this.isCreatingSession
      ? html`<div class="loading-state">Đang khởi tạo phiên chat...</div>`
      : !this.session
        ? html`<div class="error-state">
            Không thể khởi tạo phiên chat AI. Vui lòng thử lại.
          </div>`
        : html`<div
            class="chat-host"
            style="height:100%;width:100%;"
            ${ref((el: Element | undefined) => {
              if (el instanceof HTMLElement) {
                this._mountChatContent(el);
              } else {
                this._mountChatContent(null);
              }
            })}
          ></div>`;

    return html`
      <div class="dialog-header">
        <span class="dialog-title">${headerTitle}</span>
        <div class="header-actions">
          ${this.session
            ? html`<button
                class="action-button"
                ?disabled=${this.isAddingComment}
                @click=${this._addAsComment}
              >
                ${CommentIcon()} Add as comment
              </button>`
            : nothing}
          <button class="close-button" @click=${this._closeDialog}>
            ${CloseIcon()}
          </button>
        </div>
      </div>
      <div class="dialog-body">${body}</div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'ask-ai-chat-dialog': AskAIChatDialog;
  }
}

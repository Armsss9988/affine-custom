import { useConfirmModal } from '@affine/component';
import { AIProvider } from '@affine/core/blocksuite/ai';
import type { AppSidebarConfig } from '@affine/core/blocksuite/ai/chat-panel/chat-config';
import {
  AIChatContent,
  type ChatContextValue,
} from '@affine/core/blocksuite/ai/components/ai-chat-content';
import type { ChatStatus } from '@affine/core/blocksuite/ai/components/ai-chat-messages';
import type { AIChatToolbar } from '@affine/core/blocksuite/ai/components/ai-chat-toolbar';
import {
  AIChatTabs,
  configureAIChatToolbar,
  getOrCreateAIChatToolbar,
} from '@affine/core/blocksuite/ai/components/ai-chat-toolbar';
import { createPlaygroundModal } from '@affine/core/blocksuite/ai/components/playground/modal';
import { registerAIAppEffects } from '@affine/core/blocksuite/ai/effects/app';
import type { AffineEditorContainer } from '@affine/core/blocksuite/block-suite-editor';
import { NotificationServiceImpl } from '@affine/core/blocksuite/view-extensions/editor-view/notification-service';
import { useAIChatConfig } from '@affine/core/components/hooks/affine/use-ai-chat-config';
import { useAISpecs } from '@affine/core/components/hooks/affine/use-ai-specs';
import { useAISubscribe } from '@affine/core/components/hooks/affine/use-ai-subscribe';
import {
  AgentRuntimeService,
  createAgentContextSnapshot,
} from '@affine/core/modules/agent-runtime';
import {
  AIDraftService,
  AIToolsConfigService,
} from '@affine/core/modules/ai-button';
import { AIModelService } from '@affine/core/modules/ai-button/services/models';
import { ServerService, SubscriptionService } from '@affine/core/modules/cloud';
import { WorkspaceDialogService } from '@affine/core/modules/dialogs';
import { useSignalValue } from '@affine/core/modules/doc-info/utils';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { PeekViewService } from '@affine/core/modules/peek-view';
import { AppThemeService } from '@affine/core/modules/theme';
import { WorkbenchService } from '@affine/core/modules/workbench';
import type {
  ContextEmbedStatus,
  CopilotChatHistoryFragment,
  UpdateChatSessionInput,
} from '@affine/graphql';
import { useI18n } from '@affine/i18n';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import { DocModeProvider } from '@blocksuite/affine/shared/services';
import { createSignalFromObservable } from '@blocksuite/affine/shared/utils';
import { CenterPeekIcon, Logo1Icon } from '@blocksuite/icons/rc';
import type { Signal } from '@preact/signals-core';
import { useFramework, useService } from '@toeverything/infra';
import { html } from 'lit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  createSessionDeleteHandler,
  useAIChatOpenTabs,
} from '../../chat-panel-utils';
import * as styles from './chat.css';
import {
  resolveInitialSession,
  shouldResetChatPanelOnUserInfoChange,
  type WorkbenchLike,
} from './chat-panel-session';

registerAIAppEffects();

export interface SidebarTabProps {
  editor: AffineEditorContainer | null;
  onLoad?: ((component: HTMLElement) => void) | null;
}

export const EditorChatPanel = ({ editor, onLoad }: SidebarTabProps) => {
  const framework = useFramework();
  const workbench = useService(WorkbenchService).workbench;
  const t = useI18n();

  const { closeConfirmModal, openConfirmModal } = useConfirmModal();
  const notificationService = useMemo(
    () => new NotificationServiceImpl(closeConfirmModal, openConfirmModal),
    [closeConfirmModal, openConfirmModal]
  );
  const specs = useAISpecs();
  const handleAISubscribe = useAISubscribe();

  const {
    docDisplayConfig,
    searchMenuConfig,
    reasoningConfig,
    playgroundConfig,
  } = useAIChatConfig();
  const playgroundVisible = useSignalValue(playgroundConfig.visible) ?? false;

  const [session, setSession] = useState<
    CopilotChatHistoryFragment | null | undefined
  >(undefined);
  const [embeddingProgress, setEmbeddingProgress] = useState<[number, number]>([
    0, 0,
  ]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [_hasPinned, setHasPinned] = useState(false);

  // Map of sessionKey -> AIChatContent DOM node (preserved across tab switches)
  const chatContentMapRef = useRef<Map<string, AIChatContent>>(new Map());
  // The currently visible AIChatContent instance
  const [chatContent, setChatContent] = useState<AIChatContent | null>(null);
  const [chatToolbar, setChatToolbar] = useState<AIChatToolbar | null>(null);
  const [chatTabs, setChatTabs] = useState<AIChatTabs | null>(null);
  const [isBodyProvided, setIsBodyProvided] = useState(false);
  const [isHeaderProvided, setIsHeaderProvided] = useState(false);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const chatToolbarContainerRef = useRef<HTMLDivElement | null>(null);
  const chatTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const lastDocIdRef = useRef<string | null>(null);
  const sessionLoadSeqRef = useRef(0);
  const userIdRef = useRef<string | null | undefined>(undefined);

  const doc = editor?.doc;
  const host = editor?.host;
  const workspaceId = doc?.workspace.id;

  const agentRuntime = useService(AgentRuntimeService);
  const featureFlags = useService(FeatureFlagService).flags;
  const enableAgentRuntime = featureFlags.enable_agent_runtime.value;

  /**
   * Background chat send handler.
   * When `enable_agent_runtime` is on, intercepts every chat send and routes
   * it through AgentRuntimeService as a `background_chat` job so the stream
   * continues even when the user navigates away from the chat panel.
   */
  const handleSendMessage = useCallback(
    async (userInput: string) => {
      if (!doc || !workspaceId) return;
      // Use the active visible content
      const activeContent = chatContent;
      if (!activeContent) return;

      // Get or create a session — mirrors what send() does internally.
      let sessionId = activeContent.session?.sessionId;
      if (!sessionId) {
        try {
          const newSession = await activeContent.createSession();
          sessionId = newSession?.sessionId;
        } catch (err) {
          console.error(
            '[AgentRuntime] handleSendMessage: createSession failed',
            err
          );
          return;
        }
        // Immediately update session title with user input
        const sessionTitle = userInput.slice(0, 50).trim() || 'Chat';
        (AIProvider.session as any)
          ?.updateSession({
            sessionId,
            title: sessionTitle,
          })
          .catch((err: any) => {
            console.warn('[TitleUpdate] failed:', err);
          });
      }

      const context = createAgentContextSnapshot({
        workspaceId,
        docId: doc.id,
        docTitle: doc.meta?.title || 'Untitled',
        viewMode: 'page',
      });

      const modelId = framework.get(AIModelService).modelId.value;

      agentRuntime.enqueue({
        workspaceId,
        title: userInput.slice(0, 60),
        userPrompt: userInput,
        context,
        priority: 'high',
        workflow: 'background_chat',
        chatOptions: {
          sessionId,
          userInput,
          docId: doc.id,
          isRootSession: true,
          reasoning: reasoningConfig.enabled.value,
          modelId: modelId ?? undefined,
          toolsConfig: activeContent.aiToolsConfigService.config.value,
        },
      });
    },
    [agentRuntime, chatContent, doc, framework, reasoningConfig, workspaceId]
  );

  const [sessionServiceReady, setSessionServiceReady] = useState(
    () => !!AIProvider.session
  );

  useEffect(() => {
    if (sessionServiceReady) return;
    if (AIProvider.session) {
      setSessionServiceReady(true);
      return;
    }
    const sub = AIProvider.slots.sessionReady.subscribe(ready => {
      if (ready) setSessionServiceReady(true);
    });
    return () => sub.unsubscribe();
  }, [sessionServiceReady]);

  const loadSession = useMemo(() => {
    if (!sessionServiceReady || !workspaceId) return null;
    const sessionService = AIProvider.session;
    if (!sessionService) return null;
    return async (
      sessionId: string
    ): Promise<CopilotChatHistoryFragment | null | undefined> =>
      sessionService.getSession(workspaceId, sessionId);
  }, [sessionServiceReady, workspaceId]);

  const { openTabs, setOpenTabs } =
    useAIChatOpenTabs<CopilotChatHistoryFragment>(loadSession);

  const appSidebarConfig = useMemo<AppSidebarConfig>(() => {
    return {
      getWidth: () =>
        createSignalFromObservable<number | undefined>(
          workbench.sidebarWidth$.asObservable(),
          0
        ),
      isOpen: () =>
        createSignalFromObservable<boolean | undefined>(
          workbench.sidebarOpen$.asObservable(),
          true
        ),
    };
  }, [workbench]);

  const [sidebarWidthSignal, setSidebarWidthSignal] =
    useState<Signal<number | undefined>>();

  useEffect(() => {
    const { signal, cleanup } = appSidebarConfig.getWidth();
    setSidebarWidthSignal(signal);
    return cleanup;
  }, [appSidebarConfig]);

  const resetPanel = useCallback(() => {
    sessionLoadSeqRef.current += 1;
    setSession(undefined);
    setEmbeddingProgress([0, 0]);
    setHasPinned(false);
    // Hide all cached content nodes when resetting
    chatContentMapRef.current.forEach(node => {
      node.style.display = 'none';
    });
  }, []);

  const initPanel = useCallback(async () => {
    const requestSeq = ++sessionLoadSeqRef.current;
    try {
      const nextSession = await resolveInitialSession({
        sessionService: AIProvider.session ?? undefined,
        doc,
        workbench: workbench as WorkbenchLike,
      });

      if (requestSeq !== sessionLoadSeqRef.current) return;
      if (nextSession === undefined) {
        return;
      }

      setSession(nextSession);
      setHasPinned(!!nextSession?.pinned);
    } catch (error) {
      console.error(error);
    }
  }, [doc, workbench]);

  const createSession = useCallback(
    async (options: Partial<BlockSuitePresets.AICreateSessionOptions> = {}) => {
      if (session || !AIProvider.session || !doc) {
        return session ?? undefined;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      const nextSession = await AIProvider.session.createSessionWithHistory({
        docId: doc.id,
        workspaceId: doc.workspace.id,
        promptName: 'Chat With AFFiNE AI',
        reuseLatestChat: false,
        ...options,
      });
      if (requestSeq !== sessionLoadSeqRef.current) return undefined;
      setSession(nextSession ?? null);
      setHasPinned(!!nextSession?.pinned);
      return nextSession ?? undefined;
    },
    [doc, session]
  );

  const updateSession = useCallback(
    async (options: UpdateChatSessionInput) => {
      if (!AIProvider.session || !doc) {
        return undefined;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      await AIProvider.session.updateSession(options);
      const nextSession = await AIProvider.session.getSession(
        doc.workspace.id,
        options.sessionId
      );
      if (requestSeq !== sessionLoadSeqRef.current) return undefined;
      setSession(nextSession ?? null);
      setHasPinned(!!nextSession?.pinned);
      return nextSession ?? undefined;
    },
    [doc]
  );

  const newSession = useCallback(async () => {
    resetPanel();
    const requestSeq = sessionLoadSeqRef.current;
    setSession(null);

    if (!AIProvider.session || !doc) {
      return;
    }

    try {
      const nextSession = await AIProvider.session.createSessionWithHistory({
        docId: doc.id,
        workspaceId: doc.workspace.id,
        promptName: 'Chat With AFFiNE AI',
        reuseLatestChat: false,
      });
      if (requestSeq === sessionLoadSeqRef.current) {
        setSession(nextSession ?? null);
        setHasPinned(!!nextSession?.pinned);
      }
    } catch (error) {
      console.error(error);
    }
  }, [doc, resetPanel]);

  const openSession = useCallback(
    async (sessionId: string) => {
      if (session?.sessionId === sessionId || !AIProvider.session || !doc) {
        return;
      }
      const requestSeq = ++sessionLoadSeqRef.current;
      try {
        const nextSession = await AIProvider.session.getSession(
          doc.workspace.id,
          sessionId
        );
        if (requestSeq !== sessionLoadSeqRef.current) return;
        if (!nextSession) {
          // Drop stale tab if session no longer exists.
          setOpenTabs(prev => prev.filter(tab => tab.sessionId !== sessionId));
          return;
        }
        setSession(nextSession);
        setHasPinned(!!nextSession.pinned);
      } catch (error) {
        console.error(error);
      }
    },
    [doc, session?.sessionId, setOpenTabs]
  );

  const openDoc = useCallback(
    async (docId: string, sessionId?: string) => {
      if (!doc) {
        return;
      }
      if (doc.id === docId) {
        if (session?.sessionId === sessionId || session?.pinned) {
          return;
        }
        if (sessionId) {
          await openSession(sessionId);
        }
        return;
      }
      if (session?.pinned || !sessionId) {
        workbench.open(`/${docId}`, { at: 'active' });
        return;
      }
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: 'active' });
    },
    [doc, openSession, session?.pinned, session?.sessionId, workbench]
  );

  const deleteSession = useMemo(
    () =>
      createSessionDeleteHandler({
        t,
        notificationService,
        canDeleteSession: () => Boolean(AIProvider.histories),
        cleanupSession: async sessionToDelete => {
          await AIProvider.histories?.cleanup(
            sessionToDelete.workspaceId,
            sessionToDelete.docId || undefined,
            [sessionToDelete.sessionId]
          );
        },
        isActiveSession: sessionToDelete =>
          sessionToDelete.sessionId === session?.sessionId,
        onActiveSessionDeleted: () => {
          newSession().catch(console.error);
        },
      }),
    [newSession, notificationService, session?.sessionId, t]
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      // Remove and destroy the cached AIChatContent node for the closed tab.
      const cached = chatContentMapRef.current.get(sessionId);
      if (cached) {
        cached.remove();
        chatContentMapRef.current.delete(sessionId);
        if (chatContent === cached) setChatContent(null);
      }

      let fallback: CopilotChatHistoryFragment | undefined;
      setOpenTabs(prev => {
        const idx = prev.findIndex(tab => tab.sessionId === sessionId);
        if (idx === -1) return prev;
        const next = prev.filter(tab => tab.sessionId !== sessionId);
        fallback = next[idx] ?? next[idx - 1] ?? next[0];
        return next;
      });
      if (session?.sessionId !== sessionId) return;
      if (fallback) {
        openSession(fallback.sessionId).catch(console.error);
      } else {
        newSession().catch(console.error);
      }
    },
    [chatContent, newSession, openSession, session?.sessionId, setOpenTabs]
  );

  const togglePin = useCallback(async () => {
    const pinned = !session?.pinned;
    setHasPinned(true);
    if (!session) {
      await createSession({ pinned });
      return;
    }
    setSession(prev => (prev ? { ...prev, pinned } : prev));
    await updateSession({
      sessionId: session.sessionId,
      pinned,
    });
  }, [createSession, session, updateSession]);

  const rebindSession = useCallback(async () => {
    if (!session || !doc) {
      return;
    }
    if (session.docId !== doc.id) {
      await updateSession({
        sessionId: session.sessionId,
        docId: doc.id,
      });
    }
  }, [doc, session, updateSession]);

  const onEmbeddingProgressChange = useCallback(
    (count: Record<ContextEmbedStatus, number>) => {
      const total = count.finished + count.processing + count.failed;
      setEmbeddingProgress([count.finished, total]);
    },
    []
  );

  const onContextChange = useCallback(
    (context: Partial<ChatContextValue>) => {
      setStatus(context.status ?? 'idle');
      if (context.status === 'success') {
        rebindSession().catch(console.error);
      }
    },
    [rebindSession]
  );

  // When session resets to undefined (loading/resetting), tear down toolbar+tabs only.
  // chatContent nodes are cached in chatContentMapRef and kept alive.
  useEffect(() => {
    if (session !== undefined) return;
    if (chatToolbar) {
      chatToolbar.remove();
      setChatToolbar(null);
    }
    if (chatTabs) {
      chatTabs.remove();
      setChatTabs(null);
    }
  }, [chatTabs, chatToolbar, session]);

  useEffect(() => {
    if (!session?.sessionId) return;
    setOpenTabs(prev => {
      const existing = prev.findIndex(
        tab => tab.sessionId === session.sessionId
      );
      if (existing !== -1) {
        if (prev[existing] === session) return prev;
        const next = prev.slice();
        next[existing] = session;
        return next;
      }
      return [...prev, session];
    });
  }, [session, setOpenTabs]);

  useEffect(() => {
    let disposed = false;
    Promise.resolve(AIProvider.userInfo)
      .then(userInfo => {
        if (!disposed && userIdRef.current === undefined) {
          userIdRef.current = userInfo?.id ?? null;
        }
      })
      .catch(console.error);
    const subscription = AIProvider.slots.userInfo.subscribe(userInfo => {
      const nextUserId = userInfo?.id ?? null;
      const shouldReset = shouldResetChatPanelOnUserInfoChange({
        previousUserId: userIdRef.current,
        nextUserId,
      });
      userIdRef.current = nextUserId;
      if (!shouldReset) {
        return;
      }
      resetPanel();
      initPanel().catch(console.error);
    });
    return () => {
      disposed = true;
      subscription.unsubscribe();
    };
  }, [initPanel, resetPanel]);

  useEffect(() => {
    const docId = doc?.id;
    if (!docId) {
      return;
    }
    if (
      lastDocIdRef.current &&
      lastDocIdRef.current !== docId &&
      !session?.pinned
    ) {
      resetPanel();
    }
    lastDocIdRef.current = docId;
  }, [doc?.id, resetPanel, session?.pinned]);

  useEffect(() => {
    if (!doc || session !== undefined) {
      return;
    }
    if (AIProvider.session) {
      initPanel().catch(console.error);
      return;
    }
    const subscription = AIProvider.slots.sessionReady.subscribe(ready => {
      if (!ready || session !== undefined) return;
      initPanel().catch(console.error);
    });
    return () => subscription.unsubscribe();
  }, [doc, initPanel, session]);

  // Derive a stable key for the cache: prefer sessionId, fallback to docId.
  // This replaces the old contentKey / prevSession logic.
  const sessionCacheKey = session?.sessionId ?? doc?.id ?? 'chat-panel';

  // Show/hide cached AIChatContent nodes; create on first visit for each session.
  useEffect(() => {
    if (!isBodyProvided || !chatContainerRef.current || !doc || !host) return;
    if (session === undefined) return;

    const map = chatContentMapRef.current;
    const container = chatContainerRef.current;

    // Transfer 'new' cached node (doc-keyed) to real session key on first
    // session creation. Prevents discarding the optimistic message already
    // being streamed when the session transitions from null -> real.
    if (session && doc && sessionCacheKey !== doc.id && map.has(doc.id)) {
      const node = map.get(doc.id)!;
      map.delete(doc.id);
      map.set(sessionCacheKey, node);
    }

    // Hide all currently visible nodes.
    map.forEach(node => {
      node.style.display = 'none';
    });

    // Get or create the node for the active session key.
    let content = map.get(sessionCacheKey) ?? null;
    if (!content) {
      content = new AIChatContent();
      map.set(sessionCacheKey, content);
    }

    // Always update mutable props BEFORE appending (connectedCallback fires on first append).
    content.style.display = '';
    content.host = host;
    content.session = session;
    content.createSession = createSession;
    content.workspaceId = doc.workspace.id;
    content.docId = doc.id;
    content.reasoningConfig = reasoningConfig;
    content.searchMenuConfig = searchMenuConfig;
    content.docDisplayConfig = docDisplayConfig;
    content.extensions = specs;
    content.serverService = framework.get(ServerService);
    content.affineFeatureFlagService = framework.get(FeatureFlagService);
    content.affineWorkspaceDialogService = framework.get(
      WorkspaceDialogService
    );
    content.affineThemeService = framework.get(AppThemeService);
    content.notificationService = notificationService;
    content.aiDraftService = framework.get(AIDraftService);
    content.aiToolsConfigService = framework.get(AIToolsConfigService);
    content.peekViewService = framework.get(PeekViewService);
    content.subscriptionService = framework.get(SubscriptionService);
    content.aiModelService = framework.get(AIModelService);
    content.onAISubscribe = handleAISubscribe;
    content.onRunAgentJob = undefined;
    content.onSendMessage = enableAgentRuntime ? handleSendMessage : undefined;
    content.onEmbeddingProgressChange = onEmbeddingProgressChange;
    content.onContextChange = onContextChange;
    content.width = sidebarWidthSignal;
    content.onOpenDoc = (docId: string, sessionId?: string) => {
      openDoc(docId, sessionId).catch(console.error);
    };

    // Re-attach any detached cached nodes to the (possibly new) container,
    // then append the active one if it is not yet in the DOM.
    map.forEach((node, key) => {
      if (node.parentElement !== container) {
        node.style.display = 'none';
        container.append(node);
      }
      if (key !== sessionCacheKey) {
        node.style.display = 'none';
      }
    });
    if (content.parentElement !== container) {
      container.append(content);
      onLoad?.(content);
    }

    setChatContent(content);
  }, [
    createSession,
    doc,
    docDisplayConfig,
    enableAgentRuntime,
    framework,
    handleAISubscribe,
    handleSendMessage,
    host,
    isBodyProvided,
    notificationService,
    onContextChange,
    onEmbeddingProgressChange,
    onLoad,
    openDoc,
    reasoningConfig,
    searchMenuConfig,
    session,
    sessionCacheKey,
    sidebarWidthSignal,
    specs,
  ]);

  useEffect(() => {
    if (!isHeaderProvided || !chatToolbarContainerRef.current || !doc) {
      return;
    }
    if (session === undefined) {
      return;
    }

    const tool = getOrCreateAIChatToolbar(chatToolbar);
    configureAIChatToolbar(tool, {
      session,
      workspaceId: doc.workspace.id,
      docId: doc.id,
      status,
      docDisplayConfig,
      notificationService,
      onNewSession: () => {
        newSession().catch(console.error);
      },
      onTogglePin: togglePin,
      onOpenSession: (sessionId: string) => {
        openSession(sessionId).catch(console.error);
      },
      onOpenDoc: (docId: string, sessionId: string) => {
        openDoc(docId, sessionId).catch(console.error);
      },
      onSessionDelete: (sessionToDelete: BlockSuitePresets.AIRecentSession) => {
        deleteSession(sessionToDelete).catch(console.error);
      },
    });

    if (!chatToolbar) {
      chatToolbarContainerRef.current.append(tool);
      setChatToolbar(tool);
    }
  }, [
    chatToolbar,
    deleteSession,
    doc,
    docDisplayConfig,
    isHeaderProvided,
    newSession,
    notificationService,
    openDoc,
    openSession,
    session,
    status,
    togglePin,
  ]);

  useEffect(() => {
    if (!chatTabsContainerRef.current || !doc) {
      return;
    }
    if (session === undefined) {
      return;
    }

    let tabs = chatTabs;
    if (!tabs) {
      tabs = new AIChatTabs();
      chatTabsContainerRef.current.append(tabs);
      setChatTabs(tabs);
    }
    tabs.sessions = openTabs;
    tabs.activeSessionId = session?.sessionId;
    tabs.onSelectTab = (sessionId: string) => {
      openSession(sessionId).catch(console.error);
    };
    tabs.onCloseTab = (sessionId: string) => {
      closeTab(sessionId);
    };
  }, [chatTabs, closeTab, doc, openSession, openTabs, session]);

  useEffect(() => {
    if (!editor?.host || !chatContent) {
      return;
    }
    const docModeService = editor.host.std.get(DocModeProvider);
    const refNodeService = editor.host.std.getOptional(RefNodeSlotsProvider);
    const disposable = [
      refNodeService?.docLinkClicked.subscribe(({ host: clickedHost }) => {
        if (clickedHost === editor.host) {
          chatContent.docId = editor.doc.id;
        }
      }),
      docModeService?.onPrimaryModeChange(() => {
        if (!editor.host) {
          return;
        }
        chatContent.host = editor.host;
      }, editor.doc.id),
    ];

    return () => disposable.forEach(item => item?.unsubscribe());
  }, [chatContent, editor]);

  // Reload history when a background_chat job for the current session completes.
  useEffect(() => {
    if (!chatContent || !enableAgentRuntime) return;

    const sub = agentRuntime.jobs$.subscribe(jobs => {
      const sessionId = chatContent.session?.sessionId;
      if (!sessionId) return;

      const completedChatJob = jobs.find(
        j =>
          j.workflow === 'background_chat' &&
          j.status === 'succeeded' &&
          (j.chatOptions as { sessionId?: string } | undefined)?.sessionId ===
            sessionId
      );
      if (completedChatJob) {
        // Reload history to display the AI response that was saved by the server.
        chatContent.updateHistory().catch(console.error);
      }
    });

    return () => sub.unsubscribe();
  }, [agentRuntime.jobs$, chatContent, enableAgentRuntime]);

  const [autoResized, setAutoResized] = useState(false);
  useEffect(() => {
    if (autoResized) {
      return;
    }
    const subscription = AIProvider.slots.previewPanelOpenChange.subscribe(
      open => {
        if (!open) {
          return;
        }
        const sidebarWidth = workbench.sidebarWidth$.value;
        const minSidebarWidth = 1080;
        if (!sidebarWidth || sidebarWidth < minSidebarWidth) {
          workbench.setSidebarWidth(minSidebarWidth);
          setAutoResized(true);
        }
      }
    );
    return () => {
      subscription.unsubscribe();
    };
  }, [autoResized, workbench]);

  const openPlayground = useCallback(() => {
    if (!doc || !host) {
      return;
    }
    const playgroundContent = html`
      <playground-content
        .host=${host}
        .doc=${doc}
        .reasoningConfig=${reasoningConfig}
        .playgroundConfig=${playgroundConfig}
        .appSidebarConfig=${appSidebarConfig}
        .searchMenuConfig=${searchMenuConfig}
        .docDisplayConfig=${docDisplayConfig}
        .extensions=${specs}
        .serverService=${framework.get(ServerService)}
        .affineFeatureFlagService=${framework.get(FeatureFlagService)}
        .affineThemeService=${framework.get(AppThemeService)}
        .notificationService=${notificationService}
        .affineWorkspaceDialogService=${framework.get(WorkspaceDialogService)}
        .aiToolsConfigService=${framework.get(AIToolsConfigService)}
        .subscriptionService=${framework.get(SubscriptionService)}
        .aiModelService=${framework.get(AIModelService)}
      ></playground-content>
    `;

    createPlaygroundModal(playgroundContent, 'AI Playground');
  }, [
    appSidebarConfig,
    doc,
    docDisplayConfig,
    framework,
    host,
    notificationService,
    playgroundConfig,
    reasoningConfig,
    searchMenuConfig,
    specs,
  ]);

  const onChatContainerRef = useCallback((node: HTMLDivElement) => {
    if (!node) {
      return;
    }
    setIsBodyProvided(true);
    chatContainerRef.current = node;
  }, []);

  const onChatToolContainerRef = useCallback((node: HTMLDivElement) => {
    if (!node) {
      return;
    }
    setIsHeaderProvided(true);
    chatToolbarContainerRef.current = node;
  }, []);

  const onChatTabsContainerRef = useCallback((node: HTMLDivElement | null) => {
    chatTabsContainerRef.current = node;
  }, []);

  const isEmbedding =
    embeddingProgress[1] > 0 && embeddingProgress[0] < embeddingProgress[1];
  const [done, total] = embeddingProgress;
  const isInitialized = session !== undefined;

  return (
    <div className={styles.root}>
      {!isInitialized ? (
        <div className={styles.loadingContainer}>
          <div className={styles.loading}>
            <Logo1Icon className={styles.loadingIcon} />
            <div className={styles.loadingTitle}>
              {t['com.affine.ai.chat-panel.loading-history']()}
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.title}>
              {isEmbedding ? (
                <span data-testid="chat-panel-embedding-progress">
                  {t.t('com.affine.ai.chat-panel.embedding-progress', {
                    done,
                    total,
                  })}
                </span>
              ) : (
                t['com.affine.ai.chat-panel.title']()
              )}
            </div>
            {playgroundVisible && !featureFlags.enable_agent_runtime.$ ? (
              <div className={styles.playground} onClick={openPlayground}>
                <CenterPeekIcon />
              </div>
            ) : null}
            <div
              className={styles.tabsContainer}
              ref={onChatTabsContainerRef}
            />
            <div ref={onChatToolContainerRef} />
          </div>
          <div className={styles.content} ref={onChatContainerRef} />
        </div>
      )}
    </div>
  );
};

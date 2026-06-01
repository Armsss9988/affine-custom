import { observeResize, useConfirmModal } from '@affine/component';
import { CopilotClient } from '@affine/core/blocksuite/ai';
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
import type { PromptKey } from '@affine/core/blocksuite/ai/provider/prompt';
import { getViewManager } from '@affine/core/blocksuite/manager/view';
import { NotificationServiceImpl } from '@affine/core/blocksuite/view-extensions/editor-view/notification-service';
import { useAIChatConfig } from '@affine/core/components/hooks/affine/use-ai-chat-config';
import { useAISpecs } from '@affine/core/components/hooks/affine/use-ai-specs';
import { useAISubscribe } from '@affine/core/components/hooks/affine/use-ai-subscribe';
import {
  AIDraftService,
  AIToolsConfigService,
} from '@affine/core/modules/ai-button';
import { AIModelService } from '@affine/core/modules/ai-button/services/models';
import {
  EventSourceService,
  GraphQLService,
  ServerService,
  SubscriptionService,
} from '@affine/core/modules/cloud';
import { WorkspaceDialogService } from '@affine/core/modules/dialogs';
import { FeatureFlagService } from '@affine/core/modules/feature-flag';
import { PeekViewService } from '@affine/core/modules/peek-view';
import { AppThemeService } from '@affine/core/modules/theme';
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewService,
  ViewTitle,
  WorkbenchService,
} from '@affine/core/modules/workbench';
import {
  WorkspaceService,
  WorkspaceLocalState,
} from '@affine/core/modules/workspace';
import { useI18n } from '@affine/i18n';
import { RefNodeSlotsProvider } from '@blocksuite/affine/inlines/reference';
import { BlockStdScope } from '@blocksuite/affine/std';
import type { Workspace } from '@blocksuite/affine/store';
import { type Signal, signal } from '@preact/signals-core';
import { useFramework, useService } from '@toeverything/infra';
import { nanoid } from 'nanoid';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createSessionDeleteHandler } from '../chat-panel-utils';
import * as styles from './index.css';

type CopilotSession = NonNullable<
  Awaited<ReturnType<CopilotClient['getSession']>>
>;

const createPlaceholderNewSession = (): CopilotSession => ({
  sessionId: 'new',
  workspaceId: '',
  docId: null,
  parentSessionId: null,
  promptName: 'Chat With AFFiNE AI',
  model: '',
  optionalModels: [],
  action: null,
  pinned: false,
  title: 'New chat',
  tokens: 0,
  messages: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

// Module-level caches so chat state survives route unmount/remount cycles.
// Keyed by workspaceId to avoid cross-workspace conflicts.
const _chatContentMaps = new Map<string, Map<string, AIChatContent>>();
const _cachedSessions = new Map<string, CopilotSession | null>();
const _cachedOpenTabs = new Map<string, CopilotSession[]>();
const AI_CHAT_OPEN_TABS_KEY = 'aiChatOpenTabs';

function useCopilotClient() {
  const graphqlService = useService(GraphQLService);
  const eventSourceService = useService(EventSourceService);

  return useMemo(
    () => new CopilotClient(graphqlService.gql, eventSourceService.eventSource),
    [graphqlService, eventSourceService]
  );
}

function createMockStd(workspace: Workspace) {
  workspace.meta.initialize();
  // just pick a random doc for now
  const store = workspace.docs.values().next().value?.getStore();
  if (!store) return null;
  const std = new BlockStdScope({
    store,
    extensions: [...getViewManager().config.init().value.get('page')],
  });
  std.render();
  return std;
}

function useMockStd() {
  const workspace = useService(WorkspaceService).workspace;
  const std = useMemo(() => {
    if (!workspace) return null;
    return createMockStd(workspace.docCollection);
  }, [workspace]);
  return std;
}

export const Component = () => {
  const t = useI18n();
  const framework = useFramework();
  const workspaceId = useService(WorkspaceService).workspace.id;
  const workspaceLocalState = useService(WorkspaceLocalState);
  const client = useCopilotClient();
  const workbench = useService(WorkbenchService).workbench;

  const [isBodyProvided, setIsBodyProvided] = useState(false);
  const [isHeaderProvided, setIsHeaderProvided] = useState(false);
  const [chatContent, setChatContent] = useState<AIChatContent | null>(null);
  const [chatTool, setChatTool] = useState<AIChatToolbar | null>(null);
  const [chatTabs, setChatTabs] = useState<AIChatTabs | null>(null);
  const [currentSession, setCurrentSession] = useState<CopilotSession | null>(
    () => _cachedSessions.get(workspaceId) ?? null
  );
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [isTogglingPin, setIsTogglingPin] = useState(false);
  const [isOpeningSession, setIsOpeningSession] = useState(false);
  const hasRestoredPinnedSessionRef = useRef(false);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const chatToolContainerRef = useRef<HTMLDivElement>(null);
  const chatTabsContainerRef = useRef<HTMLDivElement | null>(null);
  const widthSignalRef = useRef<Signal<number>>(signal(0));

  // Map of sessionId -> AIChatContent DOM node (preserved across route switches).
  // Uses a workspace-scoped map from the module-level cache so nodes survive
  // component unmount/remount within the same workspace session.
  const getWorkspaceMap = useCallback(() => {
    let map = _chatContentMaps.get(workspaceId);
    if (!map) {
      map = new Map();
      _chatContentMaps.set(workspaceId, map);
    }
    return map;
  }, [workspaceId]);

  const chatContentMapRef =
    useRef<Map<string, AIChatContent>>(getWorkspaceMap());

  useEffect(() => {
    chatContentMapRef.current = getWorkspaceMap();
  }, [getWorkspaceMap]);

  // Sync currentSession to module-level cache so it survives route unmount/remount.
  useEffect(() => {
    _cachedSessions.set(workspaceId, currentSession);
  }, [currentSession, workspaceId]);

  const loadSession = useCallback(
    (sessionId: string) => client.getSession(workspaceId, sessionId),
    [client, workspaceId]
  );

  const [openTabs, setOpenTabsState] = useState<CopilotSession[]>(() => {
    return _cachedOpenTabs.get(workspaceId) ?? [];
  });

  // Hydrate openTabs from localState on mount if not already in memory cache
  useEffect(() => {
    if (_cachedOpenTabs.has(workspaceId)) return;

    const ids = workspaceLocalState.get<string[]>(AI_CHAT_OPEN_TABS_KEY) ?? [];
    if (!ids.length) return;

    let cancelled = false;
    Promise.all(ids.map(id => loadSession(id).catch(() => null)))
      .then(results => {
        if (cancelled) return;
        const valid = (results as (CopilotSession | null | undefined)[]).filter(
          (entry): entry is CopilotSession => {
            if (!entry || !entry.sessionId) return false;
            const hasMessages = !!(entry.messages && entry.messages.length > 0);
            const hasCustomTitle = !!(
              entry.title &&
              entry.title !== 'New chat' &&
              entry.title !== 'Chat With AFFiNE AI'
            );
            return hasMessages || hasCustomTitle;
          }
        );
        if (valid.length) {
          setOpenTabsState(valid);
          _cachedOpenTabs.set(workspaceId, valid);
        }
      })
      .catch(console.error);

    return () => {
      cancelled = true;
    };
  }, [loadSession, workspaceId, workspaceLocalState]);

  const setOpenTabs = useCallback(
    (updater: React.SetStateAction<CopilotSession[]>) => {
      setOpenTabsState(prev => {
        const next = typeof updater === 'function' ? updater(prev) : updater;
        _cachedOpenTabs.set(workspaceId, next);
        if (next.length) {
          workspaceLocalState.set(
            AI_CHAT_OPEN_TABS_KEY,
            next.map(tab => tab.sessionId).filter(id => id !== 'new')
          );
        } else {
          workspaceLocalState.del(AI_CHAT_OPEN_TABS_KEY);
        }
        return next;
      });
    },
    [workspaceId, workspaceLocalState]
  );

  useEffect(() => {
    hasRestoredPinnedSessionRef.current = false;
  }, [workspaceId]);

  const { docDisplayConfig, searchMenuConfig, reasoningConfig } =
    useAIChatConfig();

  const createSession = useCallback(
    async (options: Partial<BlockSuitePresets.AICreateSessionOptions> = {}) => {
      if (currentSession && currentSession.sessionId !== 'new') {
        return currentSession;
      }
      const session = await client.createSessionWithHistory({
        workspaceId,
        promptName: 'Chat With AFFiNE AI' satisfies PromptKey,
        reuseLatestChat: false,
        ...options,
      });
      setOpenTabs(prev => {
        const existingNewIndex = prev.findIndex(t => t.sessionId === 'new');
        if (existingNewIndex !== -1) {
          const next = prev.slice();
          next[existingNewIndex] = session;
          return next;
        }
        return [...prev, session];
      });
      setCurrentSession(session);
      return session;
    },
    [client, currentSession, workspaceId, setOpenTabs]
  );

  const togglePin = useCallback(async () => {
    if (isTogglingPin) return;
    setIsTogglingPin(true);
    try {
      const pinned = !currentSession?.pinned;
      if (!currentSession || currentSession.sessionId === 'new') {
        await createSession({ pinned });
      } else {
        await client.updateSession({
          sessionId: currentSession.sessionId,
          pinned,
        });
        // retrieve the latest session and update the state
        const session = await client.getSession(
          workspaceId,
          currentSession.sessionId
        );
        setCurrentSession(session ?? null);
      }
    } finally {
      setIsTogglingPin(false);
    }
  }, [client, createSession, currentSession, isTogglingPin, workspaceId]);

  // Hide all cached nodes (used when switching sessions without remounting).
  const hideCachedContent = useCallback(() => {
    chatContentMapRef.current.forEach(node => {
      node.style.display = 'none';
    });
  }, []);

  const createFreshSession = useCallback(async () => {
    if (isOpeningSession) return;
    setIsOpeningSession(true);
    try {
      hideCachedContent();
      setCurrentSession(createPlaceholderNewSession());
    } catch (error) {
      console.error(error);
    } finally {
      setIsOpeningSession(false);
    }
  }, [hideCachedContent, isOpeningSession]);

  const onOpenSession = useCallback(
    async (sessionId: string) => {
      if (currentSession?.sessionId === sessionId) return;

      // Look for the session in openTabs first
      const existing = openTabs.find(tab => tab.sessionId === sessionId);
      if (existing) {
        hideCachedContent();
        setCurrentSession(existing);
        chatTool?.closeHistoryMenu();
        // Fetch the latest from the server in the background to update it
        client
          .getSession(workspaceId, sessionId)
          .then(latestSession => {
            if (latestSession) {
              setOpenTabs(prev =>
                prev.map(t => (t.sessionId === sessionId ? latestSession : t))
              );
              setCurrentSession(prev =>
                prev?.sessionId === sessionId ? latestSession : prev
              );
            }
          })
          .catch(console.error);
        return;
      }

      if (isOpeningSession) return;
      setIsOpeningSession(true);
      try {
        const session = await client.getSession(workspaceId, sessionId);
        if (!session) {
          // Drop stale tab if session no longer exists.
          setOpenTabs(prev => prev.filter(tab => tab.sessionId !== sessionId));
          return;
        }
        hideCachedContent();
        setCurrentSession(session);
        chatTool?.closeHistoryMenu();
      } catch (error) {
        console.error(error);
      } finally {
        setIsOpeningSession(false);
      }
    },
    [
      chatTool,
      client,
      currentSession?.sessionId,
      hideCachedContent,
      isOpeningSession,
      openTabs,
      setOpenTabs,
      workspaceId,
    ]
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      // Remove and destroy the cached node for this tab.
      const cached = chatContentMapRef.current.get(sessionId);
      if (cached) {
        cached.remove();
        chatContentMapRef.current.delete(sessionId);
        if (chatContent === cached) setChatContent(null);
      }

      let fallback: NonNullable<CopilotSession> | undefined;
      setOpenTabs(prev => {
        const idx = prev.findIndex(tab => tab.sessionId === sessionId);
        if (idx === -1) return prev;
        const next = prev.filter(tab => tab.sessionId !== sessionId);
        fallback = next[idx] ?? next[idx - 1] ?? next[0];
        return next;
      });
      if (currentSession?.sessionId !== sessionId) return;
      if (fallback) {
        onOpenSession(fallback.sessionId).catch(console.error);
      } else {
        createFreshSession().catch(console.error);
      }
    },
    [
      chatContent,
      createFreshSession,
      currentSession?.sessionId,
      onOpenSession,
      setOpenTabs,
    ]
  );

  const currentSessionRef = useRef<CopilotSession | null>(null);
  useEffect(() => {
    currentSessionRef.current = currentSession;
  }, [currentSession]);

  const openTabsRef = useRef<CopilotSession[]>([]);
  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);

  const onSessionContextChange = useCallback(
    (sessionKey: string, context: Partial<ChatContextValue>) => {
      // 1. Only update the top-level toolbar status if this belongs to the active session
      const activeSessionKey = currentSessionRef.current?.sessionId ?? 'new';
      if (sessionKey === activeSessionKey) {
        if (context.status !== undefined) {
          setStatus(context.status);
        }
      }

      // 2. Handle instant tab title generation on the first user message
      if (context.messages && context.messages.length > 0) {
        const firstUserMsg = (context.messages as any[]).find(
          m => m.role === 'user'
        );
        if (firstUserMsg && (firstUserMsg as any).content) {
          const currentSessionForTab = openTabsRef.current.find(
            t => t.sessionId === sessionKey
          );
          const hasNoTitle =
            !currentSessionForTab?.title ||
            currentSessionForTab.title === 'New chat' ||
            currentSessionForTab.title === 'Chat With AFFiNE AI';

          if (hasNoTitle && sessionKey !== 'new') {
            const raw = (firstUserMsg as any).content.trim();
            const newlineIdx = raw.indexOf('\n');
            let newTitle = newlineIdx === -1 ? raw : raw.slice(0, newlineIdx);
            newTitle = newTitle.slice(0, 30).trim(); // Truncate to reasonable length

            if (newTitle) {
              // Update currentSession and openTabs locally
              setCurrentSession(prev => {
                if (prev && prev.sessionId === sessionKey) {
                  return { ...prev, title: newTitle };
                }
                return prev;
              });
              setOpenTabs(prev =>
                prev.map(t => {
                  if (t.sessionId === sessionKey) {
                    return { ...t, title: newTitle };
                  }
                  return t;
                })
              );

              // Update the title in backend DB via GQL updateSession mutation
              client
                .updateSession({
                  sessionId: sessionKey,
                  title: newTitle,
                })
                .catch(err => {
                  console.error('Failed to save session title to server:', err);
                });
            }
          }
        }
      }
    },
    [client, setOpenTabs]
  );

  const onOpenDoc = useCallback(
    (docId: string) => {
      workbench.openDoc(docId, { at: 'active' });
    },
    [workbench]
  );
  const onOpenSessionDoc = useCallback(
    (docId: string, sessionId: string) => {
      const { workbench } = framework.get(WorkbenchService);
      const viewService = framework.get(ViewService);
      workbench.open(`/${docId}?sessionId=${sessionId}`, { at: 'active' });
      workbench.openSidebar();
      viewService.view.activeSidebarTab('chat');
    },
    [framework]
  );

  const confirmModal = useConfirmModal();
  const notificationService = useMemo(
    () =>
      new NotificationServiceImpl(
        confirmModal.closeConfirmModal,
        confirmModal.openConfirmModal
      ),
    [confirmModal.closeConfirmModal, confirmModal.openConfirmModal]
  );
  const specs = useAISpecs();
  const mockStd = useMockStd();
  const handleAISubscribe = useAISubscribe();

  const deleteSession = useMemo(
    () =>
      createSessionDeleteHandler({
        t,
        notificationService,
        cleanupSession: async sessionToDelete => {
          await client.cleanupSessions({
            workspaceId: sessionToDelete.workspaceId,
            docId: sessionToDelete.docId || undefined,
            sessionIds: [sessionToDelete.sessionId],
          });
        },
        isActiveSession: sessionToDelete =>
          sessionToDelete.sessionId === currentSession?.sessionId,
        onActiveSessionDeleted: () => {
          hideCachedContent();
          setCurrentSession(null);
        },
      }),
    [
      client,
      currentSession?.sessionId,
      hideCachedContent,
      notificationService,
      t,
    ]
  );

  // Show/hide cached AIChatContent nodes; create on first visit for each session.
  useEffect(() => {
    if (!isBodyProvided || !chatContainerRef.current) return;

    const map = chatContentMapRef.current;
    const container = chatContainerRef.current;
    const sessionKey = currentSession?.sessionId ?? 'new';

    // Transfer 'new' cached node to real session key on first session creation.
    // Prevents creating a brand new AIChatContent when session transitions from
    // null -> real, which would discard the optimistic message already being streamed.
    if (sessionKey !== 'new' && map.has('new')) {
      const node = map.get('new')!;
      map.delete('new');
      map.set(sessionKey, node);
    }

    // Hide all existing nodes.
    map.forEach(node => {
      node.style.display = 'none';
    });

    // Get or create the node for the active session.
    let content = map.get(sessionKey) ?? null;
    if (!content) {
      content = new AIChatContent();
      content.independentMode = true;
      content.onboardingOffsetY = -100;
      map.set(sessionKey, content);
    }

    // Always update mutable props BEFORE appending (connectedCallback fires on first append).
    content.style.display = '';
    content.session = currentSession;
    content.workspaceId = workspaceId;
    content.extensions = specs;
    content.host = mockStd?.host;
    content.docDisplayConfig = docDisplayConfig;
    content.searchMenuConfig = searchMenuConfig;
    content.reasoningConfig = reasoningConfig;
    content.onContextChange = context => {
      onSessionContextChange(sessionKey, context);
    };
    content.affineFeatureFlagService = framework.get(FeatureFlagService);
    content.affineWorkspaceDialogService = framework.get(
      WorkspaceDialogService
    );
    content.peekViewService = framework.get(PeekViewService);
    content.affineThemeService = framework.get(AppThemeService);
    content.notificationService = notificationService;
    content.aiDraftService = framework.get(AIDraftService);
    content.aiToolsConfigService = framework.get(AIToolsConfigService);
    content.serverService = framework.get(ServerService);
    content.subscriptionService = framework.get(SubscriptionService);
    content.aiModelService = framework.get(AIModelService);
    content.onAISubscribe = handleAISubscribe;
    content.createSession = createSession;
    content.onOpenDoc = onOpenDoc;

    // Re-attach any detached cached nodes to the (possibly new) container.
    map.forEach((node, key) => {
      if (node.parentElement !== container) {
        node.style.display = 'none';
        container.append(node);
      }
      if (key !== sessionKey) {
        node.style.display = 'none';
      }
    });
    if (content.parentElement !== container) {
      container.append(content);
    }

    setChatContent(content);
    // Sync the top-level status state with the active tab's current status when swapping tabs
    setStatus(content.chatContextValue?.status ?? 'idle');
  }, [
    createSession,
    currentSession,
    docDisplayConfig,
    framework,
    isBodyProvided,
    mockStd,
    reasoningConfig,
    searchMenuConfig,
    workspaceId,
    onSessionContextChange,
    notificationService,
    specs,
    onOpenDoc,
    handleAISubscribe,
  ]);

  // init or update header ai-chat-toolbar
  useEffect(() => {
    if (!isHeaderProvided || !chatToolContainerRef.current) {
      return;
    }
    const tool = getOrCreateAIChatToolbar(chatTool);
    configureAIChatToolbar(tool, {
      session: currentSession,
      workspaceId,
      status,
      docDisplayConfig,
      notificationService,
      onOpenSession: sessionId => {
        onOpenSession(sessionId).catch(console.error);
      },
      onNewSession: () => {
        createFreshSession().catch(console.error);
      },
      onTogglePin: togglePin,
      onOpenDoc: (docId: string, sessionId: string) => {
        onOpenSessionDoc(docId, sessionId);
      },
      onSessionDelete: (sessionToDelete: BlockSuitePresets.AIRecentSession) => {
        deleteSession(sessionToDelete).catch(console.error);
      },
    });

    // initial props
    if (!chatTool) {
      // mount
      chatToolContainerRef.current.append(tool);
      setChatTool(tool);
    }
  }, [
    chatTool,
    currentSession,
    docDisplayConfig,
    isHeaderProvided,
    onOpenSession,
    togglePin,
    workspaceId,
    onOpenSessionDoc,
    deleteSession,
    status,
    notificationService,
    createFreshSession,
  ]);

  useEffect(() => {
    const refNodeSlots = mockStd?.getOptional(RefNodeSlotsProvider);
    if (!refNodeSlots) return;
    const sub = refNodeSlots.docLinkClicked.subscribe(event => {
      const { workbench } = framework.get(WorkbenchService);
      workbench.openDoc({
        docId: event.pageId,
        mode: event.params?.mode,
        blockIds: event.params?.blockIds,
        elementIds: event.params?.elementIds,
        refreshKey: nanoid(),
      });
    });
    return () => sub.unsubscribe();
  }, [framework, mockStd]);

  useEffect(() => {
    if (!currentSession?.sessionId) return;
    setOpenTabs(prev => {
      const existing = prev.findIndex(
        tab => tab.sessionId === currentSession.sessionId
      );
      if (existing !== -1) {
        if (prev[existing] === currentSession) return prev;
        const next = prev.slice();
        next[existing] = currentSession;
        return next;
      }
      return [...prev, currentSession];
    });
  }, [currentSession, setOpenTabs]);

  useEffect(() => {
    if (!chatTabsContainerRef.current) return;
    let tabs = chatTabs;
    if (!tabs) {
      tabs = new AIChatTabs();
      chatTabsContainerRef.current.append(tabs);
      setChatTabs(tabs);
    }
    tabs.sessions = openTabs as any;
    tabs.activeSessionId = currentSession?.sessionId;
    tabs.onSelectTab = (sessionId: string) => {
      onOpenSession(sessionId).catch(console.error);
    };
    tabs.onCloseTab = (sessionId: string) => {
      closeTab(sessionId);
    };
  }, [chatTabs, closeTab, currentSession?.sessionId, onOpenSession, openTabs]);

  // restore pinned session or last active session from sessionStorage
  useEffect(() => {
    if (hasRestoredPinnedSessionRef.current || currentSession) return;
    hasRestoredPinnedSessionRef.current = true;

    const controller = new AbortController();

    const restore = async () => {
      // Try sessionStorage first (persists across page navigations)
      try {
        const savedId = sessionStorage.getItem('affine_last_chat_session');
        if (savedId) {
          const session = await client.getSession(workspaceId, savedId);
          if (!controller.signal.aborted) {
            if (session) {
              let shouldRemount = false;
              setCurrentSession(prev => {
                if (prev) return prev;
                shouldRemount = true;
                return session;
              });
              if (shouldRemount) hideCachedContent();
              return;
            }
            // Saved session not found on server, clean up
            sessionStorage.removeItem('affine_last_chat_session');
          }
        }
      } catch {}

      // Fall back to pinned sessions
      if (controller.signal.aborted) return;
      try {
        const sessions = await client.getSessions(
          workspaceId,
          {},
          undefined,
          { pinned: true, limit: 1 },
          controller.signal
        );
        if (controller.signal.aborted || !Array.isArray(sessions)) {
          return;
        }
        const pinnedSession = sessions[0];
        if (pinnedSession) {
          let shouldRemount = false;
          setCurrentSession(prev => {
            if (prev) return prev;
            shouldRemount = true;
            return pinnedSession;
          });
          if (shouldRemount) hideCachedContent();
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        console.error(error);
      }

      if (!controller.signal.aborted) {
        setCurrentSession(prev => prev || createPlaceholderNewSession());
      }
    };

    restore().catch(error => {
      if (controller.signal.aborted) return;
      console.error(error);
    });

    return () => {
      controller.abort();
    };
  }, [client, currentSession, hideCachedContent, workspaceId]);

  // Save last active session ID to sessionStorage for persistence across navigations
  useEffect(() => {
    if (currentSession?.sessionId) {
      try {
        if (currentSession.sessionId === 'new') {
          sessionStorage.removeItem('affine_last_chat_session');
        } else {
          sessionStorage.setItem(
            'affine_last_chat_session',
            currentSession.sessionId
          );
        }
      } catch {}
    }
  }, [currentSession?.sessionId]);

  const onChatContainerRef = useCallback((node: HTMLDivElement) => {
    if (node) {
      setIsBodyProvided(true);
      chatContainerRef.current = node;
      widthSignalRef.current.value = node.clientWidth;
    }
  }, []);

  const onChatToolContainerRef = useCallback((node: HTMLDivElement) => {
    if (node) {
      setIsHeaderProvided(true);
      chatToolContainerRef.current = node;
    }
  }, []);

  const onChatTabsContainerRef = useCallback((node: HTMLDivElement | null) => {
    chatTabsContainerRef.current = node;
  }, []);

  // observe chat container width and provide to ai-chat-content
  useEffect(() => {
    if (!isBodyProvided || !chatContainerRef.current) return;
    return observeResize(chatContainerRef.current, entry => {
      widthSignalRef.current.value = entry.contentRect.width;
    });
  }, [isBodyProvided]);

  return (
    <>
      <ViewTitle title={t['com.affine.workspaceSubPath.chat']()} />
      <ViewIcon icon="ai" />
      <ViewHeader>
        <div className={styles.chatHeader}>
          <div
            className={styles.chatTabsContainer}
            ref={onChatTabsContainerRef}
          />
          <div ref={onChatToolContainerRef} />
        </div>
      </ViewHeader>
      <ViewBody>
        <div className={styles.chatRoot} ref={onChatContainerRef} />
      </ViewBody>
    </>
  );
};

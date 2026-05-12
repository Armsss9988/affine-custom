# AFFiNE Agent Runtime - Repo Map

Based on code inspection, here is the mapping of AFFiNE's current architecture to the Agent Runtime plan:

## 1. AI / Copilot Panel

- **File:** `packages/frontend/core/src/desktop/pages/workspace/detail-page/tabs/chat.tsx`
- **Component:** `EditorChatPanel`
- **Context:** Uses `@affine/core/blocksuite/ai` and talks to `AIProvider.session`.
- **Action:** We will need to intercept the submit action here to route to our new global `AgentRuntime` instead of the local chat session if the feature flag is enabled.

## 2. App Shell / Root Component

- **Files:** `packages/frontend/core/src/desktop/pages/workspace/index.tsx`, `packages/frontend/core/src/desktop/pages/workspace/layouts/workspace-layout.tsx`
- **Components:** `WorkspacePage`, `WorkspaceLayout`, `WorkbenchRoot`
- **Action:** The `Global AI Job Dock` UI should be mounted inside `WorkspaceLayout` or `WorkbenchRoot` so it persists across internal navigation.

## 3. State Management & Architecture

- **Framework:** `@toeverything/infra` (DI container, Services, Stores, Entities) and RxJS (`LiveData`).
- **Convention:** Modern AFFiNE modules (like `user-copilot-quota`) use `Service` -> `Entity` (with `LiveData` properties) -> `Store` (for persistence/API).
- **Action:** `AgentRuntime`, `AgentJobStore`, and `JobQueue` should be implemented as `@toeverything/infra` Services and Entities rather than pure Jotai atoms, to ensure they integrate properly with AFFiNE's DI container and workspace lifecycle.

## 4. Doc APIs

- **Core:** `@blocksuite/store` (Workspace, DocCollection, Doc, Block models).
- **Action:** Tools will interact with `Doc` directly for reading/writing. Markdown to BlockSuite conversion might need existing helpers.

## 5. UI Components (Modals/Toasts)

- **Services:** `NotificationServiceImpl` (for toasts), `GlobalDialogService`, `WorkspaceDialogService`.
- **Action:** Use `notificationService` for job success/fail toasts. Use standard dialogs for approval modals.

## 6. Location for New Module

- `packages/frontend/core/src/modules/agent-runtime/`

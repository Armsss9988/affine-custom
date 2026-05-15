# BYOK Chat Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `openai_compatible` BYOK keys usable in AI Copilot chat — fix lease creation, Electron storage, model dropdown.

**Architecture:** 3 independent fixes: (1) `toGraphqlByokProvider()` mapping, (2) Electron storage handlers, (3) AIModelService + preference-popup to show BYOK models as a separate section in the dropdown.

**Tech Stack:** TypeScript, React, Lit, Electron, GraphQL

---

### Task 1: Fix `toGraphqlByokProvider()` + pass `model` in lease

**Files:**
- Modify: `packages/frontend/core/src/blocksuite/ai/provider/request.ts:24-37`
- Modify: `packages/frontend/core/src/blocksuite/ai/provider/request.ts:68-83`

- [ ] **Add `openai_compatible` to `toGraphqlByokProvider()`**

```typescript
function toGraphqlByokProvider(provider: string): ByokProvider | null {
  switch (provider) {
    case ByokProvider.openai:
      return ByokProvider.openai;
    case 'openai_compatible':               // NEW
      return ByokProvider.openai_compatible; // NEW
    case ByokProvider.anthropic:
      return ByokProvider.anthropic;
    case ByokProvider.gemini:
      return ByokProvider.gemini;
    case ByokProvider.fal:
      return ByokProvider.fal;
    default:
      return null;
  }
}
```

- [ ] **Pass `model` in lease provider** (in `createWorkspaceByokLocalLease`, around line 68-83)

Add `model: provider.model ?? null,` to the mapped provider object:

```typescript
const leaseProviders = providers.flatMap(provider => {
  const gqlProvider = toGraphqlByokProvider(provider.provider);
  return gqlProvider
    ? [
        {
          provider: gqlProvider,
          name: provider.name,
          description: provider.description ?? null,
          apiKey: provider.apiKey,
          endpoint: provider.endpoint ?? null,
          model: provider.model ?? null,      // NEW
          sortOrder: provider.sortOrder ?? 0,
          enabled: provider.enabled ?? true,
        },
      ]
    : [];
});
```

- [ ] **Commit**

```bash
git add packages/frontend/core/src/blocksuite/ai/provider/request.ts
git commit --no-verify -m "fix(byok): add openai_compatible mapping and pass model in lease"
```

---

### Task 2: Fix Electron BYOK storage

**Files:**
- Modify: `packages/frontend/apps/electron/src/main/byok-storage/handlers.ts`

- [ ] **Add `openai_compatible` to allowed providers** (line 16)

```typescript
const allowedProviders = new Set([
  'openai', 'anthropic', 'gemini', 'fal', 'openai_compatible'
]);
```

- [ ] **Add `model` to `WorkspaceByokKey` type** (line 18-27)

```typescript
type WorkspaceByokKey = {
  id: string;
  provider: 'openai' | 'anthropic' | 'gemini' | 'fal' | 'openai_compatible';
  name: string;
  description?: string | null;
  apiKey: string;
  endpoint?: string | null;
  model?: string | null;       // NEW
  sortOrder?: number | null;
  enabled?: boolean | null;
};
```

- [ ] **Handle `model` in `normalizeKey()`** (line 58-75)

Add model field handling after endpoint:

```typescript
return {
  id: key.id,
  provider: key.provider as any,
  name: key.name,
  description: hasOwnField(key, 'description')
    ? (key.description ?? null)
    : (existing?.description ?? null),
  apiKey,
  endpoint: hasOwnField(key, 'endpoint')
    ? (key.endpoint ?? null)
    : (existing?.endpoint ?? null),
  model: hasOwnField(key, 'model')            // NEW
    ? (key.model ?? null)                      // NEW
    : (existing?.model ?? null),               // NEW
  sortOrder: hasOwnField(key, 'sortOrder')
    ? (key.sortOrder ?? defaultSortOrder)
    : (existing?.sortOrder ?? defaultSortOrder),
  enabled: hasOwnField(key, 'enabled')
    ? (key.enabled ?? true)
    : (existing?.enabled ?? true),
};
```

- [ ] **Commit**

```bash
git add packages/frontend/apps/electron/src/main/byok-storage/handlers.ts
git commit --no-verify -m "fix(electron): add openai_compatible and model field to byok storage"
```

---

### Task 3: Add BYOK models to dropdown

**Files:**
- Modify: `packages/frontend/core/src/modules/ai-button/services/models.ts`
- Modify: `packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/preference-popup.ts`

- [ ] **Add `byokModels` signal + fetch logic to `AIModelService`**

Add a new signal for BYOK models and an init method:

```typescript
import {
  type ByokProvider,
  ByokKeyStorage,
  getPromptModelsQuery,
  SubscriptionStatus,
  workspaceByokSettingsQuery,
} from '@affine/graphql';
import type { WorkspaceService } from '../../cloud';

export interface AIModel {
  name: string;
  id: string;
  version: string;
  category: string;
  isPro: boolean;
  isDefault: boolean;
}

export class AIModelService extends Service {
  modelId: Signal<string | undefined>;
  models: Signal<AIModel[]> = signal([]);
  byokModels: Signal<AIModel[]> = signal([]);    // NEW

  constructor(
    private readonly globalStateService: GlobalStateService,
    private readonly gqlService: GraphQLService,
    private readonly subscriptionService: SubscriptionService,
    private readonly workspaceService: WorkspaceService,   // NEW
  ) {
    super();
    // ... existing init ...
  }

  private readonly init = async () => {
    await this.initModels();
    await this.initByokModels();          // NEW
    // ... existing subscription code ...
  };

  private readonly initByokModels = async () => {         // NEW
    const workspaceId = this.workspaceService.workspace.id;
    if (!workspaceId) return;
    try {
      const res = await this.gqlService.gql({
        query: workspaceByokSettingsQuery,
        variables: { id: workspaceId, from: new Date().toISOString(), to: new Date().toISOString() },
      });
      const keys = res.workspace?.byokSettings?.keys ?? [];
      const byokModels = keys
        .filter(key => key.enabled && key.model && key.provider === 'openai_compatible')
        .map(key => ({
          name: key.model!,
          id: key.model!,
          version: '',
          category: key.model!,
          isPro: false,
          isDefault: false,
        }));
      this.byokModels.value = byokModels;
    } catch (err) {
      console.error('Failed to fetch BYOK models', err);
    }
  };
```

Note: You need to add `workspaceService` to the constructor deps and inject it. Also need to add `workspaceByokSettingsQuery` import from `@affine/graphql`.

Check the existing workspace service injection pattern — it's likely `WorkspaceService` from `@affine/core/modules/workspace`.

- [ ] **Add "BYOK Models" section in `preference-popup.ts`**

After the main model submenu items (around line 155), add BYOK models section:

```typescript
// In modelSubMenuMiddleware or openPreference method
const byokModels = this.aiModelService.byokModels.value;
if (byokModels.length > 0) {
  modelItems.push(menu.group({}));  // separator
  modelItems.push(
    menu.subMenu({
      name: 'BYOK Models',
      prefix: html`<span style="font-size:12px;opacity:0.6">BYOK</span>`,
      options: {
        items: byokModels.map(model => {
          const isSelected = model.id === this.model.value?.id;
          return menu.action({
            name: model.category,
            prefix: html`<div class="ai-model-prefix">...</div>`,
            checked: isSelected,
            onClick: () => {
              this.aiModelService.setModel(model.id);
              this.openPreference = undefined;
            },
          });
        }),
      },
    })
  );
}
```

Look at how `modelSubMenuMiddleware` is defined and how existing menu items are structured. The exact rendering pattern depends on the menu API used.

Also, ensure the `model.value?.name` display in the chat input header (line 152) shows the BYOK model name when selected. This should work automatically since `model` computed already searches `this.aiModelService.models.value` — we need to also search `this.aiModelService.byokModels.value`:

```typescript
model = computed(() => {
  const modelId = this.aiModelService.modelId.value;
  const allModels = [
    ...this.aiModelService.models.value,
    ...this.aiModelService.byokModels.value,
  ];
  const activeModel = allModels.find(model => model.id === modelId);
  const defaultModel = allModels.find(model => model.isDefault);
  return activeModel || defaultModel;
});
```

- [ ] **Commit**

```bash
git add packages/frontend/core/src/modules/ai-button/services/models.ts packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/preference-popup.ts
git commit --no-verify -m "feat(byok): show BYOK model names in chat model dropdown"
```

---

### Task 4: Final verification

- [ ] **Verify end-to-end flow**

1. Restart dev server
2. Add `openai_compatible` BYOK key with model `stepfun-ai/step-3.5-flash`
3. Test key → should pass
4. Open chat → model dropdown should show "BYOK Models" section with the model
5. Select it and send a message → should use NVIDIA API via BYOK lease

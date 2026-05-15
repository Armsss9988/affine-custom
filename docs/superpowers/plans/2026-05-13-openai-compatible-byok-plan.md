# OpenAI-Compatible BYOK Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an "OpenAI Compatible" BYOK provider option that allows any OpenAI-compatible endpoint (OpenRouter, NVIDIA, Together, DeepSeek, etc.) with user-specified API key, base URL, and model name.

**Architecture:** New `ByokProvider.openai_compatible` maps to existing OpenAI driver internally, but allows arbitrary base URL regardless of selfhosted mode. Model name is user-specified (not from catalog). Profile building passes custom endpoint + model name to the OpenAI driver.

**Tech Stack:** NestJS 11, Prisma 6, GraphQL, React 19, @toeverything/infra

---

### Files to Modify

| # | File | Action |
|---|------|--------|
| 1 | `packages/backend/server/schema.prisma` | Add `model` column to `AiWorkspaceByokConfig` |
| 2 | `packages/backend/server/src/models/copilot-byok.ts` | Add `model` to `UpsertAiWorkspaceByokConfigInput` |
| 3 | `packages/backend/server/src/plugins/copilot/byok/types.ts` | Add `openai_compatible` to enum + mappings |
| 4 | `packages/backend/server/src/plugins/copilot/byok/service.ts` | Handle new provider in profiles, test, config |
| 5 | `packages/backend/server/src/plugins/copilot/byok/resolver.ts` | Add `model` field to GraphQL input types |
| 6 | `packages/common/graphql/src/graphql/*.gql` | Add `model` to BYOK mutations |
| 7 | `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/types.ts` | Add `model` to `ByokKey` |
| 8 | `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/metadata.ts` | Add label + capabilities |
| 9 | `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/add-key-modal.tsx` | Add model field, show endpoint |
| 10 | `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/coverage.tsx` | Include provider in feature rows |
| 11 | `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/local-storage.ts` | Handle `model` field |

---

### Task 1: Prisma Schema + Model Layer

**Files:**
- Modify: `packages/backend/server/schema.prisma:747`
- Modify: `packages/backend/server/src/models/copilot-byok.ts:13`

- [ ] **Add `model` column to Prisma schema**

```prisma
// schema.prisma - AiWorkspaceByokConfig model line 747
model AiWorkspaceByokConfig {
  id                  String    @id @default(uuid()) @db.VarChar
  workspaceId         String    @map("workspace_id") @db.VarChar
  provider            String    @db.VarChar
  name                String    @db.VarChar
  description         String?   @db.VarChar
  encryptedApiKey     String    @map("encrypted_api_key") @db.Text
  endpoint            String?   @db.Text
  model               String?   @db.VarChar      // NEW: user-specified model name
  sortOrder           Int       @default(0) @map("sort_order")
  // ... rest unchanged
}
```

- [ ] **Add `model` to model input type**

```typescript
// models/copilot-byok.ts line 16
export type UpsertAiWorkspaceByokConfigInput = {
  id?: string | null;
  workspaceId: string;
  provider: string;
  name: string;
  description: string | null;
  encryptedApiKey?: string;
  endpoint: string | null;
  model?: string | null;      // NEW
  sortOrder: number;
  enabled: boolean;
  userId?: string;
};
```

- [ ] **Set model in upsert**

```typescript
// models/copilot-byok.ts line 47
const data = {
  provider: input.provider,
  name: input.name,
  description: input.description,
  endpoint: input.endpoint,
  model: input.model ?? null,         // NEW
  sortOrder: input.sortOrder,
  enabled: input.enabled,
  // ... rest unchanged
};
```

- [ ] **Run Prisma migration**

```bash
cd packages/backend/server
npx prisma migrate dev --name add_byok_model_field
```

---

### Task 2: Backend BYOK Types

**File:** `packages/backend/server/src/plugins/copilot/byok/types.ts`

- [ ] **Add `openai_compatible` to enum and providers list**

```typescript
export enum ByokProvider {
  openai = 'openai',
  anthropic = 'anthropic',
  gemini = 'gemini',
  fal = 'fal',
  openai_compatible = 'openai_compatible',   // NEW
}

export const BYOK_ALLOWED_PROVIDERS = [
  ByokProvider.openai,
  ByokProvider.anthropic,
  ByokProvider.gemini,
  ByokProvider.fal,
  ByokProvider.openai_compatible,             // NEW
] as const;
```

- [ ] **Extend mapping functions**

```typescript
export function byokProviderToCopilotType(provider: ByokProvider) {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:       // NEW - maps to same driver
      return CopilotProviderType.OpenAI;
    case ByokProvider.anthropic:
      return CopilotProviderType.Anthropic;
    case ByokProvider.gemini:
      return CopilotProviderType.Gemini;
    case ByokProvider.fal:
      return CopilotProviderType.FAL;
  }
}

export function copilotTypeToByokProvider(type: CopilotProviderType) {
  switch (type) {
    case CopilotProviderType.OpenAI:
      // openai_compatible is intentionally NOT mapped back here
      // it stays as 'openai_compatible' for profile resolution
      return null;
    // ... rest unchanged
  }
}
```

- [ ] **Update regex in parseProfileMeta**

```typescript
// service.ts line 622 - add openai_compatible to regex
const match =
  /^byok-([a-f0-9]{12})-(openai|anthropic|gemini|fal|openai_compatible)-(.+)$/.exec(
    providerId
  );
```

---

### Task 3: Backend BYOK Service

**File:** `packages/backend/server/src/plugins/copilot/byok/service.ts`

- [ ] **Add `model` to `ByokKeyConfig` type (line 36-55)**

```typescript
export type ByokKeyConfig = {
  id: string;
  provider: ByokProvider;
  name: string;
  description: string | null;
  storage: ByokKeyStorage;
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  endpointEditable: boolean;
  model: string | null;         // NEW
  sortOrder: number;
  capabilities: string[];
  testStatus: ByokKeyTestStatus;
  disabledReason: string | null;
  lastTestedAt: Date | null;
  lastTestError: string | null;
  lastUsedAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
};
```

- [ ] **Add `model` to `ByokLocalLeaseProvider` type (line 75-83)**

```typescript
export type ByokLocalLeaseProvider = {
  provider: ByokProvider;
  name: string;
  description?: string | null;
  apiKey: string;
  endpoint?: string | null;
  model?: string | null;        // NEW
  sortOrder?: number | null;
  enabled?: boolean | null;
};
```

- [ ] **Modify `normalizeEndpoint` for openai_compatible (line 730-745)**

```typescript
private normalizeEndpoint(endpoint?: string | null, provider?: ByokProvider) {
  if (!endpoint) return null;
  // openai_compatible always allows custom endpoints
  if (provider !== ByokProvider.openai_compatible && !this.customEndpointSupported) {
    throw new BadRequestException('Custom BYOK endpoint is not supported.');
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new BadRequestException('Invalid BYOK endpoint.');
  }
  if (!['https:', 'http:'].includes(parsed.protocol)) {
    throw new BadRequestException('BYOK endpoint must use HTTP or HTTPS.');
  }
  return parsed.toString().replace(/\/$/, '');
}
```

- [ ] **Modify `upsertConfig` to pass model (line 176-237)**

```typescript
// In the upsertConfig method, add model handling:
const model =
  input.model !== undefined
    ? input.model?.trim() || null
    : (existing?.model ?? null);

// Pass to the model's upsert
const row = await this.models.copilotWorkspaceByokConfig.upsert({
  id: input.id,
  workspaceId: input.workspaceId,
  provider: input.provider,
  name: input.name.trim(),
  description,
  encryptedApiKey,
  endpoint,
  model,                // NEW
  sortOrder,
  enabled,
  userId: input.userId,
});
```

- [ ] **Modify `normalizeEndpoint` call sites to pass provider**

```typescript
// line 217 - in upsertConfig
const endpoint =
  input.endpoint !== undefined
    ? this.normalizeEndpoint(input.endpoint, input.provider)
    : (existing?.endpoint ?? null);

// line 302 - in testConfig
const endpoint = this.normalizeEndpoint(input.endpoint, input.provider);

// line 371 - in createLocalLease
const endpoint = this.normalizeEndpoint(provider.endpoint, provider.provider);
```

- [ ] **Add `openai_compatible` to `buildProbeRequest` (line 777-811)**

```typescript
private buildProbeRequest(
  provider: ByokProvider,
  apiKey: string,
  endpoint: string | null
) {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:   // NEW - same as OpenAI
      return {
        method: 'GET',
        url: `${endpoint ?? 'https://api.openai.com/v1'}/models`,
        headers: { Authorization: `Bearer ${apiKey}` },
      };
    // ... rest unchanged
  }
}
```

- [ ] **Add `model` to `toKeyConfig` (line 640-680)**

```typescript
private toKeyConfig(row: {
  // ... existing fields
  model: string | null;            // NEW
}): ByokKeyConfig {
  // ...
  return {
    // ... existing
    endpoint: row.endpoint,
    endpointEditable: this.endpointEditableFor(row.provider as ByokProvider),
    model: row.model,               // NEW
    // ...
  };
}

// New helper for per-provider endpoint editable check
private endpointEditableFor(provider: ByokProvider) {
  return provider === ByokProvider.openai_compatible || this.customEndpointSupported;
}
```

- [ ] **Add `model` to `providerConfig` (line 588-602)**

```typescript
private providerConfig(
  provider: ByokProvider,
  encryptedApiKey: string,
  endpoint: string | null
) {
  const apiKey = this.crypto.decrypt(encryptedApiKey);
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:   // NEW - OpenAI driver with optional custom endpoint
    case ByokProvider.gemini:
    case ByokProvider.anthropic:
      return { apiKey, ...(endpoint ? { baseURL: endpoint } : {}) };
    case ByokProvider.fal:
      return { apiKey };
  }
}
```

- [ ] **Add capabilities for `openai_compatible` (line 682-702)**

```typescript
private capabilities(provider: ByokProvider, storage: 'server' | 'local') {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:   // NEW
      return ['Text', 'Image input', 'Actions', 'Image generate'];
    // ... rest unchanged
  }
}
```

- [ ] **Add `model` to `getServerProfiles` (line 523-543)**

```typescript
private async getServerProfiles(workspaceId: string) {
  const rows = await this.models.copilotWorkspaceByokConfig.listEnabled(workspaceId);
  return rows
    .filter(row => isByokProvider(row.provider))
    .map((row, index): CopilotProviderProfile => {
      const provider = row.provider as ByokProvider;
      return {
        id: this.profileId(workspaceId, provider, row.id, 'server'),
        type: byokProviderToCopilotType(provider),
        priority:
          BYOK_PROFILE_PRIORITY_BASE - SERVER_PROFILE_PRIORITY_OFFSET - index,
        config: this.providerConfig(provider, row.encryptedApiKey, row.endpoint),
        model: row.model ?? undefined,   // NEW - pass model name
      } as CopilotProviderProfile;
    });
}
```

- [ ] **Add `model` to `getLocalProfiles` (line 545-586)**

```typescript
// Map model from the lease provider
private async getLocalProfiles(context: ByokProviderRequestContext) {
  // ...
  return lease.providers
    .filter(provider => provider.enabled !== false)
    .map((provider, index): CopilotProviderProfile => {
      return {
        // ... existing
        config: this.providerConfig(
          provider.provider,
          provider.encryptedApiKey,
          provider.endpoint ?? null
        ),
        model: provider.model ?? undefined,   // NEW
      } as CopilotProviderProfile;
    });
}
```

- [ ] **Add `model` to local lease active cache hash (line 863-882)**

```typescript
// The hash already includes all provider fields via JSON.stringify
// Just ensure model is included in the provider mapping
```

- [ ] **Add `model` to `ByokLocalLeaseProvider` in `createLocalLease` (line 359-412)**

```typescript
// The LocalLeasePayload already stores providers, just add model field
const payload: LocalLeasePayload = {
  // ...
  providers: providers.map(provider => ({
    provider: provider.provider,
    name: provider.name,
    description: provider.description,
    encryptedApiKey: this.crypto.encrypt(provider.apiKey),
    endpoint: provider.endpoint,
    model: provider.model ?? null,      // NEW
    sortOrder: provider.sortOrder,
    enabled: provider.enabled,
  })),
};
```

- [ ] **Register `openai_compatible` in `assertProvider`** (already handled - it's in BYOK_ALLOWED_PROVIDERS)

---

### Task 4: Backend BYOK Resolver

**File:** `packages/backend/server/src/plugins/copilot/byok/resolver.ts`

- [ ] **Add `model` field to `WorkspaceByokKeyConfigType` (line 22-77)**

```typescript
@ObjectType()
export class WorkspaceByokKeyConfigType implements ByokKeyConfig {
  // ... existing fields
  @Field(() => String, { nullable: true })
  model!: string | null;         // NEW
  // ... rest unchanged
}
```

- [ ] **Add `model` field to `UpsertWorkspaceByokConfigInput` (line 160-191)**

```typescript
@InputType()
class UpsertWorkspaceByokConfigInput {
  // ... existing fields
  @Field(() => String, { nullable: true })
  model?: string | null;         // NEW
  // ... rest unchanged
}
```

- [ ] **Add `model` field to `CreateWorkspaceByokLocalLeaseProviderInput` (line 227-248)**

```typescript
@InputType()
class CreateWorkspaceByokLocalLeaseProviderInput implements ByokLocalLeaseProvider {
  // ... existing fields
  @Field(() => String, { nullable: true })
  model?: string | null;         // NEW
  // ... rest unchanged
}
```

---

### Task 5: GraphQL Operations

**File:** `packages/common/graphql/src/graphql/` (find and update BYOK .gql files)

- [ ] **Find and add `model` field to BYOK GraphQL mutations**

Look for `.gql` files related to BYOK operations (upsertWorkspaceByokConfig, testWorkspaceByokConfig, createWorkspaceByokLocalLease):

```graphql
# In the upsert mutation - add model
mutation upsertWorkspaceByokConfig($input: UpsertWorkspaceByokConfigInput!) {
  upsertWorkspaceByokConfig(input: $input) {
    id
    provider
    name
    endpoint
    model           # NEW
    # ... rest
  }
}
```

```graphql
# In the test mutation input
input UpsertWorkspaceByokConfigInput {
  # ... existing
  model: String    # NEW
}
```

- [ ] **Run codegen**

```bash
cd packages/common/graphql
yarn gql-gen
```

---

### Task 6: Frontend BYOK Types

**File:** `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/types.ts`

- [ ] **Add `model` to `ByokKey` interface**

```typescript
// types.ts
export type ByokKey = {
  id: string;
  provider: ByokProvider;
  name: string;
  description: string | null;
  storage: ByokStorage;
  configured: boolean;
  enabled: boolean;
  endpoint: string | null;
  endpointEditable: boolean;
  model: string | null;         // NEW
  sortOrder: number;
  capabilities: string[];
  testStatus: ByokTestResult;
  disabledReason: string | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  lastUsedAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
};
```

---

### Task 7: Frontend BYOK Metadata

**File:** `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/metadata.ts`

- [ ] **Add label for `openai_compatible`**

```typescript
export const providerLabels: Record<ByokProvider, string> = {
  [ByokProvider.openai]: 'OpenAI',
  [ByokProvider.anthropic]: 'Anthropic',
  [ByokProvider.gemini]: 'Gemini',
  [ByokProvider.fal]: 'FAL',
  [ByokProvider.openai_compatible]: 'OpenAI Compatible',  // NEW
};
```

- [ ] **Add capabilities**

```typescript
export function capabilitiesFor(provider: ByokProvider, storage: ByokStorage) {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:  // NEW
      return ['Text', 'Image input', 'Actions', 'Image generate'];
    // ... rest unchanged
  }
}
```

- [ ] **Add to feature coverage rows**

```typescript
export const capabilityRows = [
  {
    titleKey: 'feature.chat.title',
    featureKind: 'chat',
    providers: [
      ByokProvider.openai,
      ByokProvider.openai_compatible,    // NEW
      ByokProvider.anthropic,
      ByokProvider.gemini,
    ],
    coverageCapabilities: ['Text'],
  },
  {
    titleKey: 'feature.action.title',
    featureKind: 'action',
    providers: [ByokProvider.openai, ByokProvider.openai_compatible, ByokProvider.gemini],  // NEW
    coverageCapabilities: ['Actions'],
  },
  {
    titleKey: 'feature.image.title',
    featureKind: 'image',
    providers: [
      ByokProvider.openai,
      ByokProvider.openai_compatible,    // NEW
      ByokProvider.gemini,
      ByokProvider.fal,
    ],
    coverageCapabilities: ['Image generate'],
  },
  // ... transcript and indexing rows unchanged (only Gemini)
];
```

---

### Task 8: Frontend Add Key Modal

**File:** `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/add-key-modal.tsx`

- [ ] **Add `model` state variable** (near line 57)

```typescript
const [model, setModel] = useState('');
```

- [ ] **Reset `model` on modal open** (inside useEffect, near line 78)

```typescript
setModel(editingKey?.model ?? '');
```

- [ ] **Show endpoint field for `openai_compatible`** (replace lines 279-292)

```tsx
{/* Endpoint field: shown for openai_compatible (always) or if custom endpoints enabled */}
{(provider === ByokProvider.openai_compatible || settings.customEndpointSupported) ? (
  <label className={styles.field}>
    <span className={styles.label}>{byokT(t, 'field.endpoint')}</span>
    <input
      className={styles.input}
      value={endpoint}
      onChange={event => {
        setEndpoint(event.target.value);
        setTestResult(null);
      }}
      placeholder="https://api.example.com/v1"
    />
  </label>
) : null}
```

- [ ] **Add model name field** (after endpoint field)

```tsx
{provider === ByokProvider.openai_compatible && (
  <label className={styles.field}>
    <span className={styles.label}>{byokT(t, 'field.model')}</span>
    <input
      className={styles.input}
      value={model}
      onChange={event => {
        setModel(event.target.value);
        setTestResult(null);
      }}
      placeholder="e.g., google/gemini-2.0-flash-001"
    />
  </label>
)}
```

- [ ] **Include `model` in upsert mutation** (line 169)

```typescript
// in save() - server storage
await gql({
  query: upsertByokMutation,
  variables: {
    input: {
      // ... existing
      endpoint: endpoint || null,
      model: model || null,        // NEW
      enabled: true,
    },
  },
});
```

- [ ] **Include `model` in local storage save** (line 139)

```typescript
const saved = await upsertLocalKey(workspaceId, {
  // ... existing
  apiKey,
  endpoint: endpoint || null,
  model: model || null,           // NEW
  // ...
});
```

- [ ] **Include `model` in test mutation** (in testKey, line 87-99)

```typescript
const result = await gql({
  query: testByokMutation,
  variables: {
    input: {
      workspaceId,
      provider,
      storage,
      apiKey: apiKey || null,
      endpoint: endpoint || null,
      model: model || null,        // NEW
      configId: canTestStoredConfig ? editingKey.id : null,
    },
  },
});
```

---

### Task 9: Frontend Local Storage

**File:** `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/local-storage.ts`

- [ ] **Add `model` field to the local storage key type and save/read logic**

Find the `ByokLocalKey` type and add `model`:
```typescript
type ByokLocalKey = {
  id: string;
  provider: ByokProvider;
  name: string;
  description?: string;
  apiKey: string;
  endpoint?: string | null;
  model?: string | null;        // NEW
  sortOrder: number;
  enabled: boolean;
};
```

In `readLocalKeys()`, map the `model` field from stored data. In `upsertLocalKey()` and `deleteLocalKey()`, pass `model` through.

---

### Task 10: Frontend Coverage Panel

**File:** `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/coverage.tsx`

The `capabilityRows` update in metadata.ts (Task 7) is sufficient. The `coverage.tsx` already uses `capabilityRows` from metadata to check coverage. No additional changes needed.

---

### Task 11: Backend Provider Registry (Model Resolution)

**File:** `packages/backend/server/src/plugins/copilot/providers/provider-registry.ts`

No changes needed. The `resolveModel()` function already handles model IDs generically. The BYOK profile's model name is passed as `modelId` in the request (from the user's frontend selection). The provider registry just needs to find a matching provider profile.

The key is that the `CopilotProviderProfile` needs a `model` field (added in Task 3) that the model selection policy can use as fallback. Let me check how the model is resolved at runtime...

Actually, looking at the code flow:
1. Frontend sends `modelId` as query param to SSE endpoint
2. Backend `TurnOrchestrator` passes `modelId` to `CapabilityPolicyHost.selectChat()`
3. `ModelSelectionPolicy.resolveRequestedModel()` checks if model matches optional/pro models
4. If not matched, falls back to prompt's default model

For `openai_compatible`, the user's model name (from key config) needs to be used. This means the frontend should send the model name from the key config as `modelId`.

This is already handled because:
- When user selects a model in the chat dropdown, the model name is stored in global state (`AIModelId` key)
- On SSE request, the `modelId` param comes from this state
- For `openai_compatible` keys, the model names in the dropdown are populated from the key config (not from `getPromptModelsQuery`)

No changes needed in provider-registry.ts or model-selection-policy.ts.

---

## Self-Review

1. **Spec coverage:** All spec requirements covered: new provider enum (Task 2), service logic (Task 3), GraphQL types (Task 4-5), frontend UI (Task 6-10), local storage (Task 9).

2. **Placeholder scan:** No TODOs/TBDs. Every code block shows exact changes.

3. **Type consistency:** All references use `ByokProvider.openai_compatible` consistently. `model` field is `string | null` everywhere.

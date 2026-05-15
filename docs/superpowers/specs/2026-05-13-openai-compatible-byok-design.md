# OpenAI-Compatible BYOK Provider Design

**Goal:** Add an "OpenAI Compatible" BYOK provider option that lets users bring their own API keys for any OpenAI-compatible endpoint (OpenRouter, NVIDIA, Together, DeepSeek, etc.).

**Architecture:** Extends the existing BYOK system with a new `ByokProvider.openai_compatible` that maps to the OpenAI driver internally but allows arbitrary base URL + model name. The provider is available to all server flavors (not just selfhosted), and the model name is user-specified since we can't maintain a catalog for arbitrary endpoints.

**Tech Stack:** NestJS 11, React 19, Prisma 6, GraphQL, @toeverything/infra

---

## Files to Create/Modify

### Backend (9 files)

| File | Action | Purpose |
|---|---|---|
| `packages/backend/server/src/plugins/copilot/byok/types.ts` | Modify | Add `openai_compatible` to `ByokProvider`, extend `byokProviderToCopilotType()` |
| `packages/backend/server/src/plugins/copilot/byok/service.ts` | Modify | Handle `openai_compatible`: always has custom endpoint, store `model`, build profile with custom baseURL |
| `packages/backend/server/src/plugins/copilot/byok/resolver.ts` | Modify | Add `model` field to mutation inputs and GraphQL types |
| `packages/backend/server/schema.prisma` | Modify | Add optional `model` column to `CopilotWorkspaceByokConfig` |
| `packages/backend/server/src/plugins/copilot/providers/provider-registry.ts` | Modify | Handle model-less providers (use model name from key config) |
| `packages/backend/server/src/plugins/copilot/providers/types.ts` | No change | `CopilotProviderType.OpenAI` reused |
| `packages/backend/server/src/plugins/copilot/providers/openai.ts` | No change | Same driver, just different base URL |
| `packages/backend/server/src/plugins/copilot/runtime/model-selection-policy.ts` | Modify | Accept model name from BYOK profile as override |
| `packages/backend/server/src/plugins/copilot/resolver.ts` | No change | No change needed |

### Frontend (5 files)

| File | Action | Purpose |
|---|---|---|
| `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/metadata.ts` | Modify | Add `openai_compatible` label, capabilities |
| `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/add-key-modal.tsx` | Modify | Add model name field, show endpoint always for `openai_compatible` |
| `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/coverage.tsx` | Modify | Include `openai_compatible` in feature rows |
| `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/types.ts` | Modify | Add `model` field to `ByokKey` type |
| `packages/frontend/core/src/desktop/dialogs/setting/workspace-setting/byok/local-storage.ts` | Modify | Handle `model` field in local key storage |

### GraphQL (1 file)

| File | Action | Purpose |
|---|---|---|
| `packages/common/graphql/src/graphql/*.gql` | Modify | Add `model` field to BYOK mutations |

---

## Design Details

### 1. Backend: BYOK Types (`byok/types.ts`)

Add `openai_compatible` to the enum and extend the mapping:

```typescript
enum ByokProvider {
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

export function byokProviderToCopilotType(provider: ByokProvider) {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:       // NEW
      return CopilotProviderType.OpenAI;
    // ... rest unchanged
  }
}
```

### 2. Backend: BYOK Service (`byok/service.ts`)

**Custom endpoint**: Always available for `openai_compatible` regardless of selfhosted:
```typescript
get customEndpointSupported() {
  return env.selfhosted;
}

// In getSettings(), add a per-provider endpoint support flag
// openai_compatible always allows custom endpoint
```

**Key config model**: Add `model` field to `ByokKeyConfig`:
```typescript
type ByokKeyConfig = {
  // ... existing fields
  model: string | null;  // NEW: user-specified model name
};
```

**Profile building** (`getProfiles()`): For `openai_compatible`, override base URL:
```typescript
if (key.provider === ByokProvider.openai_compatible) {
  config.baseURL = key.endpoint;  // use user's custom endpoint
}
// Store model name in profile metadata for later resolution
```

**Test config** (`testConfig()`): For `openai_compatible`, test by calling `GET {endpoint}/models` with the API key. Uses the same logic as OpenAI test but with the user's endpoint instead of the default.

### 3. Backend: Provider Registry (`provider-registry.ts`)

When resolving a model for `openai_compatible`, we need to handle the fact that the model name comes from the user's key config, not from our catalog:

```typescript
function resolveModel(profile, requestedModelId) {
  if (profile.provider === 'openai_compatible') {
    // Use the model name from the user's key config
    // or from the requested model ID
    return {
      model: requestedModelId || profile.model,
      // No capability filtering - user knows their endpoint
    };
  }
  // ... existing logic for catalog-based providers
}
```

### 4. Backend: Model Selection Policy (`model-selection-policy.ts`)

Accept model name from BYOK profile when present:
- If user selected a model and the active BYOK key is `openai_compatible`, use the user's model name directly without checking the prompt's model catalog
- Skip pro model checks for `openai_compatible` (the user is paying for their own API)

### 5. Frontend: Metadata (`metadata.ts`)

```typescript
export const providerLabels: Record<ByokProvider, string> = {
  [ByokProvider.openai]: 'OpenAI',
  [ByokProvider.anthropic]: 'Anthropic',
  [ByokProvider.gemini]: 'Gemini',
  [ByokProvider.fal]: 'FAL',
  [ByokProvider.openai_compatible]: 'OpenAI Compatible',  // NEW
};

export function capabilitiesFor(provider: ByokProvider, storage: ByokStorage) {
  switch (provider) {
    case ByokProvider.openai:
    case ByokProvider.openai_compatible:  // NEW - same capabilities as OpenAI
      return ['Text', 'Image input', 'Actions'];
    // ... rest unchanged
  }
}
```

### 6. Frontend: Add Key Modal (`add-key-modal.tsx`)

When user selects `openai_compatible`:
- Show endpoint field always (not gated by `customEndpointSupported`)
- Add model name input field with placeholder
- Include `model` in GraphQL mutation variables

```tsx
{provider === ByokProvider.openai_compatible && (
  <label className={styles.field}>
    <span className={styles.label}>Model Name</span>
    <input
      className={styles.input}
      value={model}
      onChange={e => { setModel(e.target.value); setTestResult(null); }}
      placeholder="e.g., google/gemini-2.0-flash-001"
    />
  </label>
)}
```

### 7. Frontend: Coverage (`coverage.tsx`)

Include `openai_compatible` in the same feature rows as OpenAI:
```typescript
const capabilityRows = [
  {
    featureKind: 'chat',
    providers: [ByokProvider.openai, ByokProvider.openai_compatible,
                ByokProvider.anthropic, ByokProvider.gemini],
    coverageCapabilities: ['Text'],
  },
  // ... similar for action, image rows
];
```

### 8. Prisma Schema (`schema.prisma`)

Add optional `model` column to `CopilotWorkspaceByokConfig`:
```prisma
model CopilotWorkspaceByokConfig {
  // ... existing fields
  model       String?   // NEW: user-specified model name for openai_compatible
}
```

### 9. GraphQL Mutations

Add `model` field to upsert and test mutations:
```graphql
input UpsertWorkspaceByokConfigInput {
  workspaceId: String!
  provider: ByokProvider!
  name: String!
  description: String
  storage: ByokKeyStorage!
  apiKey: String
  endpoint: String
  model: String       # NEW
  enabled: Boolean
  id: String
}
```

### 10. Request Flow (unchanged architecture)

```
User selects "OpenAI Compatible" provider
  → enters https://openrouter.ai/api/v1 + API key + model name
  → frontend tests: GET {endpoint}/models with API key
  → saves to server (encrypted) or local (Electron secure storage)

When chatting with AI Copilot:
  → frontend includes byokLeaseId + modelId in SSE request
  → backend resolves BYOK profile → gets custom endpoint + API key
  → creates OpenAI driver with custom base URL
  → sends request with model name from user's config
  → streams response back
```

---

## Self-Review

1. **Placeholder scan**: No TODOs, TBDs, or vague requirements. Every file is identified with exact action and purpose.
2. **Internal consistency**: All sections reference the same `ByokProvider.openai_compatible` enum value. Types flow correctly from Prisma → Backend → GraphQL → Frontend.
3. **Scope check**: Focused on a single feature - adding one new BYOK provider type. Does not touch authentication, routing, or unrelated UI.
4. **Ambiguity check**: 
   - "OpenAI Compatible" is clearly defined as "uses OpenAI API format with custom endpoint"
   - Model name is always user-specified for this provider
   - Capabilities are a fixed subset (text + image input + actions) - user may get more or less depending on their endpoint, but we list what we know works

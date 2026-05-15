# BYOK OpenAI Compatible Chat Integration Design

**Goal:** Make `openai_compatible` BYOK keys actually usable in AI Copilot chat — fix lease creation, Electron storage, and add BYOK model names to the model selection dropdown.

**Gaps to fix:**
1. `toGraphqlByokProvider()` drops `openai_compatible` → no lease created
2. Electron BYOK storage lacks `openai_compatible` support and `model` field
3. Model dropdown only shows server models — BYOK model names invisible

**Approach for Gap 3:** Separate "BYOK Models" section in the dropdown (option B).

---

## Files to Modify

| # | File | Change |
|---|------|--------|
| 1 | `packages/frontend/core/src/blocksuite/ai/provider/request.ts:24-37` | Add `openai_compatible` to `toGraphqlByokProvider()` |
| 2 | `packages/frontend/apps/electron/src/main/byok-storage/handlers.ts` | Add `openai_compatible` to allowedProviders, add `model` field |
| 3a | `packages/frontend/core/src/modules/ai-button/services/models.ts` | Fetch BYOK keys with model names, expose as `byokModels` signal |
| 3b | `packages/frontend/core/src/blocksuite/ai/components/ai-chat-input/preference-popup.ts` | Render "BYOK Models" section in dropdown |

---

## Design Details

### 1. Fix Lease Creation

**File:** `request.ts` — function `toGraphqlByokProvider()`:
```typescript
case 'openai_compatible':
  return ByokProvider.openai_compatible;
```

Also needs to pass `model` from the BYOK local key to the `createWorkspaceByokLocalLease` mutation. Currently the lease sends only `provider + apiKey + endpoint`. Add `model` from the key.

### 2. Fix Electron Storage

**File:** `handlers.ts`:
```typescript
const allowedProviders = new Set([
  'openai', 'anthropic', 'gemini', 'fal', 'openai_compatible'
]);
```

Add `model` to `WorkspaceByokKey` type and propagate through `normalizeKey()` / `encryptKey()` / `decryptKey()`.

### 3. BYOK Models in Dropdown

**File:** `models.ts` — `AIModelService`:
- Add `byokModels$` signal: `LiveData<ByokKey[]>` from workspace BYOK settings query
- Filter keys that have a `model` name and are `enabled`
- Expose `allModels` computed: `[...serverModels, ...byokModels]` or keep separate

**File:** `preference-popup.ts`:
- After rendering server models in `modelSubMenuMiddleware`, check if BYOK models exist
- If yes, render separator + "BYOK Models" label + each BYOK model as a selectable item
- On select: call `aiModelService.setModel(modelId)` with the BYOK model name

---

## Self-Review

1. **Placeholder scan**: No TODOs. Every change is specified.
2. **Consistency**: All changes use `ByokProvider.openai_compatible`. `model` field is `string | null` everywhere.
3. **Scope**: Focused on 3 specific gaps. No unrelated changes.

# Mermaid Preview Improvements Design

Date: 2026-05-09
Status: Approved

## Summary

Improve Mermaid preview in AFFiNE by fixing error handling, adding renderer debugging capabilities, implementing auto-fallback, and investigating font/text rendering issues.

## Problem Statement

Current Mermaid preview has several issues:

1. Error messages are generic and unhelpful ("Failed to render diagram")
2. Text sometimes doesn't appear in preview without clear indication of why
3. No way to switch between renderer implementations for debugging
4. WASM renderer failures don't fallback to more stable JS renderer
5. No way to investigate rendering issues in production

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     MermaidPreview Component                  │
├─────────────────────────────────────────────────────────────┤
│  Controls: Zoom In/Out/Reset | Renderer Toggle | Error ⚠️   │
├─────────────────────────────────────────────────────────────┤
│                      SVG Container                           │
│                      (pan/zoom enabled)                      │
├─────────────────────────────────────────────────────────────┤
│                      Error Panel                            │
│  (expandable: compact → full → debug)                       │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │  Classic JS     │             │  WASM (Rust)    │
    │  (mermaid@11)    │   ─FALLBACK→│  (mermaid-rs)   │
    └─────────────────┘             └─────────────────┘
              │                               │
              └───────────────┬─────────────────┘
                              ▼
                   ┌─────────────────┐
                   │   Bridge Layer  │
                   │ (sanitization)  │
                   └─────────────────┘
```

## Changes

### 1. Error Display Component

**States:**

- **Compact**: Icon + tooltip on hover showing error message
- **Expanded**: Always visible error message + copy button
- **Debug Mode**: Full error details + renderer info + SVG output logging

**Location:** `packages/frontend/core/src/blocksuite/view-extensions/code-block-preview/mermaid-preview.ts`

**New properties:**

```typescript
interface ErrorState {
  visible: boolean;
  mode: 'compact' | 'expanded' | 'debug';
  message: string;
  stack?: string;
  rendererUsed?: 'classic' | 'wasm';
  svgOutput?: string; // for debug mode
}
```

**UI Changes:**

- Add error toggle button (⚠️ icon)
- Click to cycle: hidden → compact → expanded → debug
- Copy button for error message
- "Debug" shows extra: renderer used, full error stack

### 2. Renderer Toggle

**Location:** Same component, add dropdown control

**Options:**

- Auto (default) - try WASM first, fallback to Classic
- Classic JS - always use JS renderer
- WASM Rust - always use WASM renderer (if available)

**Display:** Shows current renderer in use + toggle button

### 3. Auto-Fallback Mechanism

**Location:** `packages/frontend/core/src/modules/code-block-preview-renderer/platform-backend.ts`

**Logic:**

```
1. Try active renderer (WASM by default)
2. If fails OR detects text missing:
   a. Log attempt with details
   b. Try fallback renderer (Classic JS)
3. If fallback succeeds:
   a. Show indicator (subtle, non-intrusive)
   b. Log successful fallback
4. If both fail:
   a. Show full error
```

**Detection of text missing:**

- After render, check if SVG contains `<text>` elements
- If SVG has no text but Mermaid code likely contains text → potential issue

### 4. Improved Sanitization

**Location:** `packages/frontend/core/src/modules/code-block-preview-renderer/bridge.ts`

**Change:** Currently removes all `foreignObject` elements which may remove text. Update to:

- Only remove `foreignObject` with dangerous attributes
- Preserve text content
- Add logging to track when foreignObject is removed

### 5. Enhanced Logging

**Location:** Throughout render pipeline

**Logged Information (Console):**

```typescript
const log = {
  timestamp: Date,
  renderer: 'classic' | 'wasm',
  attempt: number, // 1, 2 for fallback
  codeLength: number,
  success: boolean,
  error?: {
    message: string,
    stack?: string
  },
  svgOutput?: string, // only in debug mode
  textElementsFound: number,
  foreignObjectRemoved: number
};
```

### 6. WASM Font Fix (Investigation)

**Location:** `packages/frontend/native/src/preview.rs` + `packages/frontend/core/src/modules/mermaid/renderer/`

**Investigation Tasks:**

1. Check if fonts are embedded correctly in WASM binary
2. Verify font-family is passed correctly to Rust
3. Check if CJK/Unicode fonts work in WASM context
4. Compare output between classic and WASM for same input

**Fix Strategy:**

- If issue found: patch in Rust renderer
- If fix not possible for certain cases: rely on fallback mechanism

## Component Structure

```
MermaidPreview
├── controls-bar (absolute positioned)
│   ├── renderer-indicator [current] ▼
│   ├── zoom-buttons (+, -, ⟳)
│   ├── error-toggle (⚠️) [if has error]
│   └── error-dropdown [if expanded/debug]
│       ├── error-message
│       ├── copy-button
│       ├── renderer-info [debug only]
│       └── full-stack [debug only]
├── svg-container (pan/zoom enabled)
│   └── svg-content
└── loading/fallback/error overlays
```

## Files to Modify

| File                  | Changes                            |
| --------------------- | ---------------------------------- |
| `mermaid-preview.ts`  | Error UI, renderer toggle, logging |
| `platform-backend.ts` | Auto-fallback logic                |
| `bridge.ts`           | Improved sanitization              |
| `runtime-config.ts`   | Add renderer selection             |
| `mermaid.worker.ts`   | Better error propagation           |

## Testing Strategy

1. **Unit tests** - test fallback logic, error parsing
2. **Visual tests** - screenshot comparisons for different states
3. **Manual testing** - various Mermaid inputs to verify rendering

## Implementation Order

1. Enhanced error display (most visible improvement)
2. Renderer toggle and indicator
3. Auto-fallback mechanism
4. Improved sanitization with logging
5. WASM font investigation and fix (if needed)

## Success Criteria

- [ ] Error messages show actual error details
- [ ] Users can switch between renderer implementations
- [ ] WASM failures automatically fallback to Classic
- [ ] Text rendering verified for both renderers
- [ ] Debug information available in console
- [ ] No regression in existing Mermaid rendering

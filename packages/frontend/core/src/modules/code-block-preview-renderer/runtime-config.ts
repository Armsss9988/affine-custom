import type {
  MermaidRenderRequest,
  MermaidRenderResult,
} from '@affine/core/modules/mermaid/renderer';
import type {
  TypstRenderRequest,
  TypstRenderResult,
} from '@affine/core/modules/typst/renderer';

/**
 * Mermaid renderer selection mode:
 * - 'auto': Try WASM first, fallback to Classic JS on failure
 * - 'classic': Always use Classic JS renderer
 * - 'wasm': Always use WASM Rust renderer (if available)
 */
export type MermaidRendererMode = 'auto' | 'classic' | 'wasm';

type NativePreviewHandlers = {
  renderMermaidSvg?: (
    request: MermaidRenderRequest
  ) => Promise<MermaidRenderResult>;
  renderTypstSvg?: (request: TypstRenderRequest) => Promise<TypstRenderResult>;
};

// Store for renderer mode selection
let mermaidRendererMode: MermaidRendererMode = 'auto';

let enableMermaidWasmNativeRenderer =
  BUILD_CONFIG.isIOS || BUILD_CONFIG.isAndroid;
let nativePreviewHandlers: NativePreviewHandlers | null = null;

/**
 * Set the mermaid renderer mode (auto/classic/wasm)
 */
export function setMermaidRendererMode(mode: MermaidRendererMode) {
  mermaidRendererMode = mode;
}

/**
 * Get the current mermaid renderer mode
 */
export function getMermaidRendererMode(): MermaidRendererMode {
  return mermaidRendererMode;
}

export function setMermaidWasmNativeRendererEnabled(enabled: boolean) {
  enableMermaidWasmNativeRenderer = enabled;
}

export function isMermaidWasmNativeRendererEnabled() {
  return enableMermaidWasmNativeRenderer;
}

export function registerNativePreviewHandlers(
  handlers: NativePreviewHandlers | null
) {
  nativePreviewHandlers = handlers;
}

export function getNativePreviewHandlers() {
  return nativePreviewHandlers;
}

export type { NativePreviewHandlers };

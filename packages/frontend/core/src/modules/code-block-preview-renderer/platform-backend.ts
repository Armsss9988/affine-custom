import { getMermaidRenderer } from '@affine/core/modules/mermaid/renderer';
import { getTypstRenderer } from '@affine/core/modules/typst/renderer';

import { renderClassicMermaidSvg } from './classic-mermaid';
import {
  getMermaidRendererMode,
  isMermaidWasmNativeRendererEnabled,
} from './runtime-config';
import type { PreviewRenderRequestMap, PreviewRenderResultMap } from './types';

interface RenderLogEntry {
  timestamp: Date;
  renderer: 'classic' | 'wasm';
  attempt: number;
  codeLength: number;
  success: boolean;
  error?: {
    message: string;
    stack?: string;
  };
  fallbackUsed?: boolean;
}

function logRenderAttempt(entry: RenderLogEntry): void {
  const { timestamp, renderer, attempt, codeLength, success, error, fallbackUsed } = entry;

  console.debug('[Mermaid Render]', {
    timestamp: timestamp.toISOString(),
    renderer,
    attempt,
    codeLength,
    success,
    errorMessage: error?.message,
    errorStack: error?.stack,
    fallbackUsed,
  });
}

export async function renderMermaidSvgBackend(
  request: PreviewRenderRequestMap['mermaid']
): Promise<PreviewRenderResultMap['mermaid']> {
  const codeLength = request.code.length;
  const rendererMode = getMermaidRendererMode();

  // If Classic mode, always use Classic JS renderer
  if (rendererMode === 'classic') {
    logRenderAttempt({
      timestamp: new Date(),
      renderer: 'classic',
      attempt: 1,
      codeLength,
      success: true,
    });
    return renderClassicMermaidSvg(request);
  }

  // Check if WASM is available
  const wasmEnabled = isMermaidWasmNativeRendererEnabled();

  // If WASM mode requested but not available, fallback to Classic
  if (rendererMode === 'wasm' && !wasmEnabled) {
    logRenderAttempt({
      timestamp: new Date(),
      renderer: 'wasm',
      attempt: 1,
      codeLength,
      success: false,
      error: { message: 'WASM renderer not available' },
      fallbackUsed: true,
    });
    return renderClassicMermaidSvg(request);
  }

  // Try WASM first (or Classic if WASM not enabled)
  if (rendererMode === 'auto' || (rendererMode === 'wasm' && wasmEnabled)) {
    if (wasmEnabled) {
      try {
        const result = await getMermaidRenderer().render(request);
        logRenderAttempt({
          timestamp: new Date(),
          renderer: 'wasm',
          attempt: 1,
          codeLength,
          success: true,
        });
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        console.warn('[Mermaid] WASM render failed, trying Classic JS:', err.message);

        // Fallback to Classic JS
        try {
          logRenderAttempt({
            timestamp: new Date(),
            renderer: 'wasm',
            attempt: 1,
            codeLength,
            success: false,
            error: { message: err.message, stack: err.stack },
          });

          const fallbackResult = await renderClassicMermaidSvg(request);
          logRenderAttempt({
            timestamp: new Date(),
            renderer: 'classic',
            attempt: 2,
            codeLength,
            success: true,
            fallbackUsed: true,
          });
          return fallbackResult;
        } catch (fallbackError) {
          const fallbackErr =
            fallbackError instanceof Error
              ? fallbackError
              : new Error(String(fallbackError));
          logRenderAttempt({
            timestamp: new Date(),
            renderer: 'classic',
            attempt: 2,
            codeLength,
            success: false,
            error: { message: fallbackErr.message, stack: fallbackErr.stack },
          });
          throw fallbackErr;
        }
      }
    }
  }

  // If we get here, use Classic JS
  logRenderAttempt({
    timestamp: new Date(),
    renderer: 'classic',
    attempt: 1,
    codeLength,
    success: true,
  });
  return renderClassicMermaidSvg(request);
}

export async function renderTypstSvgBackend(
  request: PreviewRenderRequestMap['typst']
): Promise<PreviewRenderResultMap['typst']> {
  return getTypstRenderer().render(request);
}

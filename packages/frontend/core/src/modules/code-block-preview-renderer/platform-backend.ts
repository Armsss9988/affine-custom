import { getMermaidRenderer } from '@affine/core/modules/mermaid/renderer';
import { getTypstRenderer } from '@affine/core/modules/typst/renderer';

import { renderClassicMermaidSvg } from './classic-mermaid';
import {
  getMermaidRendererMode,
  isMermaidWasmNativeRendererEnabled,
} from './runtime-config';
import type { PreviewRenderRequestMap, PreviewRenderResultMap } from './types';

export async function renderMermaidSvgBackend(
  request: PreviewRenderRequestMap['mermaid']
): Promise<PreviewRenderResultMap['mermaid']> {
  const mode = getMermaidRendererMode();

  // Classic mode - always use JS renderer
  if (mode === 'classic') {
    return renderClassicMermaidSvg(request);
  }

  // WASM mode - try WASM first, fallback to Classic
  const wasmEnabled = isMermaidWasmNativeRendererEnabled();

  if (mode === 'wasm' && wasmEnabled) {
    try {
      const result = await getMermaidRenderer().render(request);
      return { ...result, rendererUsed: 'wasm' as const };
    } catch (error) {
      console.warn('WASM renderer failed, falling back to Classic:', error);
      const result = await renderClassicMermaidSvg(request);
      return { ...result, rendererUsed: 'classic' as const };
    }
  }

  // Auto mode - try WASM first if enabled, fallback to Classic
  if (wasmEnabled) {
    try {
      const result = await getMermaidRenderer().render(request);
      return { ...result, rendererUsed: 'wasm' as const };
    } catch (error) {
      console.warn('WASM renderer failed, falling back to Classic:', error);
      const result = await renderClassicMermaidSvg(request);
      return { ...result, rendererUsed: 'classic' as const };
    }
  }

  // WASM not available, use Classic
  const result = await renderClassicMermaidSvg(request);
  return { ...result, rendererUsed: 'classic' as const };
}

export async function renderTypstSvgBackend(
  request: PreviewRenderRequestMap['typst']
): Promise<PreviewRenderResultMap['typst']> {
  return getTypstRenderer().render(request);
}

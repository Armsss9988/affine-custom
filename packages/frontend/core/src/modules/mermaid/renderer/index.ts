import { WorkerOpRenderer } from '../../shared/worker-op-renderer';
import type {
  MermaidOps,
  MermaidRenderOptions,
  MermaidRenderRequest,
} from './types';

class MermaidRenderer extends WorkerOpRenderer<MermaidOps> {
  constructor() {
    super('mermaid');
  }

  init(options?: MermaidRenderOptions) {
    return this.ensureInitialized(() => this.call('init', options));
  }

  async render(request: MermaidRenderRequest) {
    await this.init();
    return this.call('render', request);
  }
}

let sharedMermaidRenderer: MermaidRenderer | null = null;

export function getMermaidRenderer() {
  if (!sharedMermaidRenderer) {
    sharedMermaidRenderer = new MermaidRenderer();
  }
  return sharedMermaidRenderer;
}

export {
  MERMAID_MODERN_FONT_FAMILY,
  MERMAID_MODERN_THEME_VARIABLES,
} from './theme';
export type {
  MermaidOps,
  MermaidRenderOptions,
  MermaidRenderRequest,
  MermaidRenderResult,
  MermaidRenderTheme,
  MermaidTextMetrics,
} from './types';

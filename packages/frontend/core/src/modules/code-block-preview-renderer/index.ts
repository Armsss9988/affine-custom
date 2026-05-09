import type { Framework } from '@toeverything/infra';

import { FeatureFlagService } from '../feature-flag';
import { PreviewRendererFeatureSyncService } from './services/preview-renderer-feature-sync';

export { renderMermaidSvg, renderTypstSvg, sanitizeSvg } from './bridge';
export {
  registerNativePreviewHandlers,
  setMermaidWasmNativeRendererEnabled,
  setMermaidRendererMode,
  getMermaidRendererMode,
  isMermaidWasmNativeRendererEnabled,
} from './runtime-config';
export type { MermaidRendererMode } from './runtime-config';

export function configureCodeBlockPreviewRendererModule(framework: Framework) {
  framework.service(PreviewRendererFeatureSyncService, [FeatureFlagService]);
}

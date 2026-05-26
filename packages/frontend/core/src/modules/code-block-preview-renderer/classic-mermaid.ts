import type { Mermaid, MermaidConfig } from 'mermaid';

import type {
  MermaidRenderOptions,
  MermaidRenderRequest,
  MermaidRenderResult,
  MermaidRenderTheme,
} from '../mermaid/renderer';
import {
  MERMAID_MODERN_FONT_FAMILY,
  MERMAID_MODERN_THEME_VARIABLES,
} from '../mermaid/renderer/theme';

let mermaidPromise: Promise<Mermaid> | null = null;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

function toTheme(theme: MermaidRenderTheme | undefined) {
  return theme === 'default' ? ('default' as const) : ('base' as const);
}

function createClassicMermaidConfig(
  options?: MermaidRenderOptions
): MermaidConfig {
  const theme = toTheme(options?.theme);
  const fontFamily = options?.fontFamily ?? MERMAID_MODERN_FONT_FAMILY;

  return {
    startOnLoad: false,
    theme,
    darkMode: false,
    securityLevel: 'strict' as const,
    fontFamily,
    themeVariables:
      theme === 'base'
        ? {
            ...MERMAID_MODERN_THEME_VARIABLES,
            fontFamily,
          }
        : undefined,
    htmlLabels: true,
    flowchart: { useMaxWidth: true, htmlLabels: true },
    sequence: { useMaxWidth: true },
    gantt: { useMaxWidth: true },
    pie: { useMaxWidth: true },
    journey: { useMaxWidth: true },
    gitGraph: { useMaxWidth: true },
  };
}

async function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(module => module.default);
  }
  return mermaidPromise;
}

function createDiagramId() {
  return `mermaid-diagram-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function enqueueClassicMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task);
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function renderClassicMermaidSvg(
  request: MermaidRenderRequest
): Promise<MermaidRenderResult> {
  return enqueueClassicMermaidRender(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize(createClassicMermaidConfig(request.options));

    const { svg } = await mermaid.render(createDiagramId(), request.code);
    return { svg, rendererUsed: 'classic' };
  });
}

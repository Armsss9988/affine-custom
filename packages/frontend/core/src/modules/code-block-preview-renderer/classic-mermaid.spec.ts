import { beforeEach, describe, expect, test, vi } from 'vitest';

const { initialize, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render,
  },
}));

import {
  MERMAID_MODERN_FONT_FAMILY,
  MERMAID_MODERN_THEME_VARIABLES,
} from '../mermaid/renderer/theme';
import { renderClassicMermaidSvg } from './classic-mermaid';

describe('renderClassicMermaidSvg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('serializes initialize and render across concurrent calls', async () => {
    const events: string[] = [];
    let releaseFirstRender!: () => void;

    initialize.mockImplementation(config => {
      events.push(`init:${config.theme}`);
    });
    render
      .mockImplementationOnce(async () => {
        events.push('render:first:start');
        await new Promise<void>(resolve => {
          releaseFirstRender = resolve;
        });
        events.push('render:first:end');
        return { svg: '<svg>first</svg>' };
      })
      .mockImplementationOnce(async () => {
        events.push('render:second:start');
        return { svg: '<svg>second</svg>' };
      });

    const first = renderClassicMermaidSvg({
      code: 'flowchart TD;A-->B',
      options: { theme: 'default' },
    });
    const second = renderClassicMermaidSvg({
      code: 'flowchart TD;B-->C',
      options: { theme: 'modern' },
    });

    await vi.waitFor(() => {
      expect(events).toEqual(['init:default', 'render:first:start']);
    });

    releaseFirstRender();

    await expect(first).resolves.toEqual({
      svg: '<svg>first</svg>',
      rendererUsed: 'classic',
    });
    await expect(second).resolves.toEqual({
      svg: '<svg>second</svg>',
      rendererUsed: 'classic',
    });
    expect(events).toEqual([
      'init:default',
      'render:first:start',
      'render:first:end',
      'init:base',
      'render:second:start',
    ]);
    expect(initialize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        theme: 'base',
        fontFamily: MERMAID_MODERN_FONT_FAMILY,
        themeVariables: expect.objectContaining({
          primaryTextColor: MERMAID_MODERN_THEME_VARIABLES.primaryTextColor,
          primaryColor: MERMAID_MODERN_THEME_VARIABLES.primaryColor,
        }),
      })
    );
  });

  test('uses modern high contrast theme by default', async () => {
    initialize.mockImplementation(() => {});
    render.mockResolvedValue({ svg: '<svg>diagram</svg>' });

    await expect(
      renderClassicMermaidSvg({
        code: 'flowchart TD;A-->B',
      })
    ).resolves.toEqual({
      svg: '<svg>diagram</svg>',
      rendererUsed: 'classic',
    });

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'base',
        darkMode: false,
        fontFamily: MERMAID_MODERN_FONT_FAMILY,
        themeVariables: expect.objectContaining({
          textColor: MERMAID_MODERN_THEME_VARIABLES.textColor,
          primaryTextColor: MERMAID_MODERN_THEME_VARIABLES.primaryTextColor,
          primaryBorderColor: MERMAID_MODERN_THEME_VARIABLES.primaryBorderColor,
        }),
      })
    );
  });
});

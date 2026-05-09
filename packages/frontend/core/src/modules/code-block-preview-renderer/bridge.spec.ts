import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mermaidRender, typstRender } = vi.hoisted(() => ({
  mermaidRender: vi.fn(),
  typstRender: vi.fn(),
}));

vi.mock(
  '@affine/core/modules/code-block-preview-renderer/platform-backend',
  () => ({
    renderMermaidSvgBackend: mermaidRender,
    renderTypstSvgBackend: typstRender,
  })
);

vi.mock('dompurify', () => ({
  default: {
    sanitize: vi.fn((value: unknown) => value),
  },
}));

import { renderMermaidSvg, renderTypstSvg } from './bridge';

describe('preview render bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('mermaid skips DOMPurify and preserves foreignObject content', async () => {
    mermaidRender.mockResolvedValue({
      svg: '<svg><foreignObject><div>Block</div></foreignObject><text>mermaid</text></svg>',
      rendererUsed: 'classic',
    });
    typstRender.mockResolvedValue({
      svg: '<div><script>window.__xss__=1</script><svg><text>typst</text></svg></div>',
    });

    const mermaid = await renderMermaidSvg({ code: 'classDiagram' });
    const typst = await renderTypstSvg({ code: '= Title' });

    expect(mermaidRender).toHaveBeenCalledTimes(1);
    expect(typstRender).toHaveBeenCalledTimes(1);
    // Mermaid output is NOT sanitized - foreignObject preserved
    expect(mermaid.svg).toContain('<foreignObject>');
    expect(mermaid.svg).toContain('<div>Block</div>');
    expect(mermaid.rendererUsed).toBe('classic');
    expect(typst.svg).toBe(
      '<div><script>window.__xss__=1</script><svg><text>typst</text></svg></div>'
    );
  });

  test('throws when svg is not a valid svg element', async () => {
    mermaidRender.mockResolvedValue({
      svg: '<div><text>invalid</text></div>',
      rendererUsed: 'classic',
    });

    await expect(
      renderMermaidSvg({ code: 'flowchart TD;A-->B' })
    ).rejects.toThrow('Preview renderer returned invalid SVG.');
  });

  test('throws when svg is empty', async () => {
    mermaidRender.mockResolvedValue({
      svg: '',
      rendererUsed: 'wasm',
    });

    await expect(
      renderMermaidSvg({ code: 'flowchart TD;A-->B' })
    ).rejects.toThrow('Preview renderer returned invalid SVG.');
  });
});

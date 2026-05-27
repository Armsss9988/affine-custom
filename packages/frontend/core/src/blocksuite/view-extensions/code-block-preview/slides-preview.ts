import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import type { CodeBlockModel } from '@blocksuite/affine/model';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/std';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';

export class SlidesPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .slideshow-container {
      width: 100%;
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      border-radius: 8px;
      background: #1e1e1e;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      position: relative;
      font-family: Inter, system-ui, sans-serif;
    }

    .slideshow-viewport {
      width: 100%;
      aspect-ratio: 16 / 9;
      background: linear-gradient(
        135deg,
        #1f1c2c 0%,
        #928dab 100%
      ); /* Elegant Gradient background */
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      outline: none;
    }

    .slide-canvas {
      width: 80%;
      height: 75%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      color: #ffffff;
      padding: 24px;
      transition: all 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94);
      opacity: 0;
      transform: translateY(20px) scale(0.95);
      pointer-events: none;
      position: absolute;
    }

    .slide-canvas.active {
      opacity: 1;
      transform: translateY(0) scale(1);
      pointer-events: auto;
    }

    /* Premium Markdown Slide Elements styles */
    .slide-canvas h1,
    .slide-canvas h2 {
      font-size: 28px;
      margin: 0 0 16px 0;
      font-weight: 800;
      color: #fff;
      text-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
      letter-spacing: -0.5px;
    }

    .slide-canvas h2 {
      font-size: 22px;
      color: #ffd700; /* Gold accents */
    }

    .slide-canvas p {
      font-size: 14px;
      line-height: 1.6;
      color: #e2e8f0;
      max-width: 580px;
      margin: 0 0 12px 0;
    }

    .slide-canvas ul {
      text-align: left;
      display: inline-block;
      margin: 0;
      padding-left: 20px;
      font-size: 13px;
      color: #e2e8f0;
    }

    .slide-canvas li {
      margin-bottom: 8px;
    }

    .slide-canvas code {
      background: rgba(0, 0, 0, 0.4);
      color: #f1c40f;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
    }

    /* Controls overlay */
    .slideshow-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: #151515;
      border-top: 1px solid #2d2d2d;
      height: 38px;
      z-index: 10;
    }

    .controls-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .slide-btn {
      background: #2d2d2d;
      color: #fff;
      border: none;
      width: 26px;
      height: 26px;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }

    .slide-btn:hover {
      background: #444;
    }

    .slide-btn svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    .slide-counter {
      font-size: 12px;
      font-weight: 500;
      color: #a0a0a0;
    }

    .controls-center {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .indicator-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #444;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .indicator-dot.active {
      background: #0e639c;
      transform: scale(1.3);
    }

    .controls-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Fullscreen Mode override */
    .slideshow-container:fullscreen {
      width: 100vw;
      height: 100vh;
      border-radius: 0;
      border: none;
    }

    .slideshow-container:fullscreen .slideshow-viewport {
      height: calc(100vh - 44px);
      aspect-ratio: auto;
    }

    .slideshow-container:fullscreen .slide-canvas h1 {
      font-size: 48px;
    }
    .slideshow-container:fullscreen .slide-canvas p {
      font-size: 20px;
      max-width: 800px;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @state()
  accessor activeIndex: number = 0;

  @state()
  accessor slides: string[] = [];

  @state()
  accessor isPlaying: boolean = false;

  @query('.slideshow-container')
  accessor slideshowContainer!: HTMLDivElement;

  @query('.slideshow-viewport')
  accessor viewport!: HTMLDivElement;

  private _autoplayTimer: ReturnType<typeof setInterval> | null = null;

  override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._parseSlides();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._parseSlides();
        })
      );
    }

    // Bind keydown events for slide triggers
    this.disposables.addFromEvent(window, 'keydown', this._handleKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopAutoplay();
  }

  private _parseSlides() {
    if (!this.model) return;
    const content = this.model.props.text.toString();

    // Split by standard markdown divider "---"
    const parsed = content
      .split(/\n---\s*\n/)
      .map(s => s.trim())
      .filter(Boolean);

    this.slides =
      parsed.length > 0
        ? parsed
        : ['# Title Slide\nUse `---` to separate slides.'];
    if (this.activeIndex >= this.slides.length) {
      this.activeIndex = this.slides.length - 1;
    }
  }

  private readonly _handleKeyDown = (e: KeyboardEvent) => {
    // Only capture events if container is focused or in fullscreen mode
    const isFullscreen = document.fullscreenElement === this.slideshowContainer;
    const isFocused = document.activeElement === this.viewport;

    if (!isFullscreen && !isFocused) return;

    if (e.key === 'ArrowRight' || e.key === ' ') {
      e.preventDefault();
      this._nextSlide();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this._prevSlide();
    }
  };

  private _nextSlide() {
    if (this.slides.length === 0) return;
    this.activeIndex = (this.activeIndex + 1) % this.slides.length;
  }

  private _prevSlide() {
    if (this.slides.length === 0) return;
    this.activeIndex =
      (this.activeIndex - 1 + this.slides.length) % this.slides.length;
  }

  private _jumpToSlide(idx: number) {
    this.activeIndex = idx;
  }

  private _toggleAutoplay() {
    if (this.isPlaying) {
      this._stopAutoplay();
    } else {
      this._startAutoplay();
    }
  }

  private _startAutoplay() {
    this.isPlaying = true;
    this._autoplayTimer = setInterval(() => {
      this._nextSlide();
    }, 3000); // 3 seconds loop
  }

  private _stopAutoplay() {
    this.isPlaying = false;
    if (this._autoplayTimer) {
      clearInterval(this._autoplayTimer);
      this._autoplayTimer = null;
    }
  }

  private _toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.slideshowContainer.requestFullscreen().catch(err => {
        console.error(`Fullscreen request failed: ${err.message}`);
      });
    } else {
      document.exitFullscreen().catch(console.error);
    }
  }

  // Parses Markdown strings inside slide content dynamic layouts
  private _renderSlideContent(slideText: string) {
    const lines = slideText.split('\n');
    const elements: any[] = [];
    let listItems: any[] = [];

    const flushList = () => {
      if (listItems.length > 0) {
        elements.push(
          html`<ul>
            ${listItems}
          </ul>`
        );
        listItems = [];
      }
    };

    lines.forEach((line, idx) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('# ')) {
        flushList();
        elements.push(html`<h1>${trimmed.slice(2)}</h1>`);
      } else if (trimmed.startsWith('## ')) {
        flushList();
        elements.push(html`<h2>${trimmed.slice(3)}</h2>`);
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        listItems.push(
          html`<li>${this._parseInlineFormatting(trimmed.slice(2))}</li>`
        );
      } else if (trimmed !== '') {
        flushList();
        elements.push(html`<p>${this._parseInlineFormatting(trimmed)}</p>`);
      }
    });

    flushList();
    return elements;
  }

  // Simple parser for markdown inline bold and code snippets
  private _parseInlineFormatting(text: string) {
    // Matches `code` and **bold**
    const parts: any[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      const codeIdx = remaining.indexOf('`');
      const boldIdx = remaining.indexOf('**');

      if (codeIdx === -1 && boldIdx === -1) {
        parts.push(remaining);
        break;
      }

      // Check which style is closer
      const isCode = codeIdx !== -1 && (boldIdx === -1 || codeIdx < boldIdx);

      if (isCode) {
        // Plain text before backtick
        parts.push(remaining.substring(0, codeIdx));
        const endCode = remaining.indexOf('`', codeIdx + 1);
        if (endCode === -1) {
          parts.push(remaining.substring(codeIdx));
          break;
        }
        parts.push(
          html`<code>${remaining.substring(codeIdx + 1, endCode)}</code>`
        );
        remaining = remaining.substring(endCode + 1);
      } else {
        // Bold formatting
        parts.push(remaining.substring(0, boldIdx));
        const endBold = remaining.indexOf('**', boldIdx + 2);
        if (endBold === -1) {
          parts.push(remaining.substring(boldIdx));
          break;
        }
        parts.push(
          html`<strong>${remaining.substring(boldIdx + 2, endBold)}</strong>`
        );
        remaining = remaining.substring(endBold + 2);
      }
    }

    return parts;
  }

  override render() {
    const prevIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
      </svg>
    `;

    const nextIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
      </svg>
    `;

    const playIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z" />
      </svg>
    `;

    const pauseIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
      </svg>
    `;

    const fullscreenIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path
          d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"
        />
      </svg>
    `;

    return html`
      <div class="slideshow-container">
        <!-- Interactive Viewport Canvas -->
        <div class="slideshow-viewport" tabindex="0">
          ${this.slides.map(
            (slide, idx) => html`
              <div
                class="slide-canvas ${idx === this.activeIndex ? 'active' : ''}"
              >
                ${this._renderSlideContent(slide)}
              </div>
            `
          )}
        </div>

        <!-- Controls Toolbar -->
        <div class="slideshow-controls">
          <div class="controls-left">
            <button
              class="slide-btn"
              @click=${this._prevSlide}
              title="Previous (Left Arrow)"
            >
              ${prevIcon()}
            </button>
            <button
              class="slide-btn"
              @click=${this._nextSlide}
              title="Next (Right Arrow / Space)"
            >
              ${nextIcon()}
            </button>
            <span class="slide-counter">
              ${this.activeIndex + 1} / ${this.slides.length}
            </span>
          </div>

          <!-- Indicator dots -->
          <div class="controls-center">
            ${this.slides.map(
              (_, idx) => html`
                <span
                  class="indicator-dot ${idx === this.activeIndex
                    ? 'active'
                    : ''}"
                  @click=${() => this._jumpToSlide(idx)}
                ></span>
              `
            )}
          </div>

          <div class="controls-right">
            <button
              class="slide-btn"
              @click=${this._toggleAutoplay}
              title=${this.isPlaying ? 'Pause' : 'Autoplay'}
            >
              ${this.isPlaying ? pauseIcon() : playIcon()}
            </button>
            <button
              class="slide-btn"
              @click=${this._toggleFullscreen}
              title="Fullscreen View"
            >
              ${fullscreenIcon()}
            </button>
          </div>
        </div>
      </div>
    `;
  }
}

export const CodeBlockSlidesPreviews = [
  CodeBlockPreviewExtension(
    'slides',
    model => html`<slides-deck-preview .model=${model}></slides-deck-preview>`
  ),
  CodeBlockPreviewExtension(
    'slide',
    model => html`<slides-deck-preview .model=${model}></slides-deck-preview>`
  ),
];

export function effects() {
  customElements.define('slides-deck-preview', SlidesPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    'slides-deck-preview': SlidesPreview;
  }
}

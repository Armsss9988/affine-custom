import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import type { CodeBlockModel } from '@blocksuite/affine/model';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/std';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { choose } from 'lit/directives/choose.js';
import { styleMap } from 'lit/directives/style-map.js';

// Monaco dynamic CDN loader utility helper
let monacoLoaderPromise: Promise<any> | null = null;
function loadMonacoInApi(): Promise<any> {
  if ((window as any).monaco) return Promise.resolve((window as any).monaco);
  if (monacoLoaderPromise) return monacoLoaderPromise;

  monacoLoaderPromise = new Promise((resolve, reject) => {
    if (!(window as any).require) {
      const loaderScript = document.createElement('script');
      loaderScript.src =
        'https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js';
      loaderScript.onload = () => {
        const require = (window as any).require;
        require.config({
          paths: {
            vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs',
          },
        });
        require(['vs/editor/editor.main'], () =>
          resolve((window as any).monaco), (err: any) => reject(err));
      };
      loaderScript.onerror = err => reject(err);
      document.body.appendChild(loaderScript);
    } else {
      const require = (window as any).require;
      require(['vs/editor/editor.main'], () =>
        resolve((window as any).monaco), (err: any) => reject(err));
    }
  });

  return monacoLoaderPromise;
}

interface HttpConfig {
  method: string;
  url: string;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  body: string;
}

export class ApiPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .api-client-container {
      width: 100%;
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      border-radius: 8px;
      background: #1e1e1e;
      color: #d4d4d4;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: Inter, system-ui, sans-serif;
    }

    .api-client-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      background: #252526;
      border-bottom: 1px solid #2d2d2d;
    }

    .method-select {
      background: #3c3c3c;
      border: 1px solid #555;
      color: #fff;
      padding: 6px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      outline: none;
    }

    .method-select option[value='GET'] {
      color: #2ecc71;
    }
    .method-select option[value='POST'] {
      color: #e67e22;
    }
    .method-select option[value='PUT'] {
      color: #3498db;
    }
    .method-select option[value='DELETE'] {
      color: #e74c3c;
    }
    .method-select option[value='PATCH'] {
      color: #f1c40f;
    }

    .url-input {
      flex: 1;
      background: #1e1e1e;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 6px 12px;
      color: #fff;
      font-size: 12px;
      font-family: monospace;
    }

    .url-input:focus {
      outline: 1px solid #0e639c;
    }

    .send-button {
      background: #0e639c;
      color: #fff;
      border: none;
      padding: 6px 16px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: background 0.2s ease;
    }

    .send-button:hover {
      background: #1177bb;
    }

    .send-button.running {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .send-button svg {
      width: 12px;
      height: 12px;
      fill: currentColor;
    }

    /* Tabs workspace */
    .tab-bar {
      display: flex;
      background: #252526;
      border-bottom: 1px solid #2d2d2d;
      padding: 0 8px;
    }

    .tab-item {
      padding: 8px 16px;
      font-size: 12px;
      cursor: pointer;
      color: #a0a0a0;
      border-bottom: 2px solid transparent;
      transition: all 0.2s ease;
    }

    .tab-item:hover {
      color: #e1e1e1;
    }

    .tab-item.active {
      color: #fff;
      border-bottom-color: #0e639c;
      font-weight: 500;
    }

    .tab-pane {
      padding: 12px 16px;
      background: #1e1e1e;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    /* Headers Editor */
    .headers-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 160px;
      overflow-y: auto;
    }

    .header-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .header-input {
      background: #1e1e1e;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 4px 8px;
      color: #fff;
      font-size: 11px;
      flex: 1;
    }

    .header-input:focus {
      outline: 1px solid #0e639c;
    }

    .header-checkbox {
      cursor: pointer;
    }

    .remove-header-btn {
      background: none;
      border: none;
      color: #a0a0a0;
      cursor: pointer;
      font-size: 14px;
      padding: 2px;
    }

    .remove-header-btn:hover {
      color: #f44747;
    }

    .add-header-btn {
      align-self: flex-start;
      background: #3c3c3c;
      border: none;
      color: #fff;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      transition: background 0.2s ease;
    }

    .add-header-btn:hover {
      background: #4e4e4e;
    }

    /* Body Monaco Pane */
    .body-editor-container {
      width: 100%;
      height: 140px;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      overflow: hidden;
    }

    /* Response Console */
    .response-pane {
      background: #181818;
      border-top: 1px solid #2d2d2d;
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .response-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 11px;
      padding-bottom: 6px;
      border-bottom: 1px solid #2d2d2d;
    }

    .status-tag {
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 700;
      font-size: 10px;
      letter-spacing: 0.5px;
    }

    .status-tag.success {
      background: rgba(46, 204, 113, 0.2);
      color: #2ecc71;
      border: 1px solid rgba(46, 204, 113, 0.4);
    }
    .status-tag.error {
      background: rgba(231, 76, 60, 0.2);
      color: #e74c3c;
      border: 1px solid rgba(231, 76, 60, 0.4);
    }

    .response-stat {
      color: #808080;
    }

    .response-stat strong {
      color: #d4d4d4;
    }

    .response-content-wrapper {
      position: relative;
    }

    .copy-response-btn {
      position: absolute;
      top: 6px;
      right: 12px;
      background: #3c3c3c;
      border: none;
      color: #fff;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
      z-index: 10;
      opacity: 0.7;
      transition: opacity 0.2s ease;
    }

    .copy-response-btn:hover {
      opacity: 1;
    }

    .response-body-viewer {
      background: #151515;
      color: #9cdcfe;
      font-family: monospace;
      font-size: 11px;
      padding: 10px;
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .response-headers-viewer {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 150px;
      overflow-y: auto;
      padding: 6px;
      background: #151515;
      border-radius: 4px;
    }

    .response-header-line {
      font-size: 11px;
      font-family: monospace;
    }

    .response-header-line strong {
      color: #569cd6;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @state()
  accessor activeTab: 'headers' | 'body' | 'response' = 'headers';

  @state()
  accessor method: string = 'GET';

  @state()
  accessor url: string = 'https://httpbin.org/get';

  @state()
  accessor headers: Array<{ key: string; value: string; enabled: boolean }> = [
    { key: 'Accept', value: 'application/json', enabled: true },
  ];

  @state()
  accessor body: string = '{\n  "name": "AFFiNE"\n}';

  @state()
  accessor isExecuting: boolean = false;

  // Response Data
  @state()
  accessor responseStatus: number | null = null;
  @state()
  accessor responseStatusText: string = '';
  @state()
  accessor responseTime: string = '';
  @state()
  accessor responseSize: string = '';
  @state()
  accessor responseHeaders: Record<string, string> = {};
  @state()
  accessor responseBody: string = '';
  @state()
  accessor responseError: string = '';
  @state()
  accessor copiedState: boolean = false;

  @query('.body-editor-container')
  accessor editorTarget!: HTMLDivElement;

  private _bodyMonacoInstance: any = null;
  private _isRestoring = false;

  override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);

    this._restoreConfigFromModel();

    // Load Monaco for Raw Body input tab
    loadMonacoInApi()
      .then(monaco => {
        this._initMonacoEditor(monaco);
      })
      .catch(err => console.error('Failed to init Monaco in API client:', err));
  }

  private _initMonacoEditor(monaco: any) {
    if (!this.editorTarget) return;

    this._bodyMonacoInstance = monaco.editor.create(this.editorTarget, {
      value: this.body,
      language: 'json',
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 11,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 4, bottom: 4 },
      lineNumbers: 'off',
    });

    this._bodyMonacoInstance.onDidChangeModelContent(() => {
      this.body = this._bodyMonacoInstance.getValue();
      this._saveConfigToModel();
    });
  }

  // Restore payload configs from the block's text model if formatted as JSON
  private _restoreConfigFromModel() {
    if (!this.model) return;
    this._isRestoring = true;

    const rawText = this.model.props.text.toString().trim();
    if (rawText.startsWith('{') && rawText.endsWith('}')) {
      try {
        const config: HttpConfig = JSON.parse(rawText);
        if (config.method) this.method = config.method;
        if (config.url) this.url = config.url;
        if (Array.isArray(config.headers)) this.headers = config.headers;
        if (config.body) {
          this.body = config.body;
          if (this._bodyMonacoInstance) {
            this._bodyMonacoInstance.setValue(config.body);
          }
        }
      } catch {
        // Not a JSON config block, keep standard default values
      }
    }
    this._isRestoring = false;
  }

  // Saves Method/URL/Headers/Body as a serialized string inside Y.js model
  private _saveConfigToModel() {
    if (!this.model || this._isRestoring) return;

    const config: HttpConfig = {
      method: this.method,
      url: this.url,
      headers: this.headers,
      body: this.body,
    };

    const serialized = JSON.stringify(config, null, 2);
    const yText = this.model.props.text.yText;

    // Mutate safely to trigger reactive propagation
    yText.delete(0, yText.length);
    yText.insert(0, serialized);
  }

  private _changeMethod(e: Event) {
    const target = e.target as HTMLSelectElement;
    this.method = target.value;
    this._saveConfigToModel();
  }

  private _changeUrl(e: Event) {
    const target = e.target as HTMLInputElement;
    this.url = target.value;
    this._saveConfigToModel();
  }

  private _changeHeader(index: number, field: 'key' | 'value', value: string) {
    this.headers = this.headers.map((h, i) => {
      if (i === index) {
        return { ...h, [field]: value };
      }
      return h;
    });
    this._saveConfigToModel();
  }

  private _toggleHeader(index: number) {
    this.headers = this.headers.map((h, i) => {
      if (i === index) {
        return { ...h, enabled: !h.enabled };
      }
      return h;
    });
    this._saveConfigToModel();
  }

  private _addHeader() {
    this.headers = [...this.headers, { key: '', value: '', enabled: true }];
    this._saveConfigToModel();
  }

  private _removeHeader(index: number) {
    this.headers = this.headers.filter((_, i) => i !== index);
    this._saveConfigToModel();
  }

  private async _sendRequest() {
    if (this.isExecuting) return;

    this.isExecuting = true;
    this.activeTab = 'response';
    this.responseStatus = null;
    this.responseError = '';
    this.responseBody = '';
    this.responseHeaders = {};

    const activeHeaders = this.headers
      .filter(h => h.enabled && h.key.trim() !== '')
      .reduce(
        (acc, h) => {
          acc[h.key] = h.value;
          return acc;
        },
        {} as Record<string, string>
      );

    const fetchOptions: RequestInit = {
      method: this.method,
      headers: activeHeaders,
    };

    if (this.method !== 'GET' && this.method !== 'HEAD' && this.body) {
      fetchOptions.body = this.body;
    }

    const startTime = performance.now();

    try {
      const res = await fetch(this.url, fetchOptions);
      const duration = Math.round(performance.now() - startTime);
      this.responseTime = `${duration} ms`;

      this.responseStatus = res.status;
      this.responseStatusText = res.statusText;

      // Extract response headers
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        resHeaders[key] = val;
      });
      this.responseHeaders = resHeaders;

      // Body extraction
      const contentType = res.headers.get('content-type') || '';
      let bodyText = '';
      if (contentType.includes('application/json')) {
        const json = await res.json();
        bodyText = JSON.stringify(json, null, 2);
      } else {
        bodyText = await res.text();
      }

      this.responseBody = bodyText;

      // Calculate payload size
      const bytes = new Blob([bodyText]).size;
      this.responseSize =
        bytes > 1024 ? `${(bytes / 1024).toFixed(2)} KB` : `${bytes} B`;
    } catch (err: any) {
      console.error('Request failed:', err);
      this.responseError = `Network Request Failed: ${err.message}. Ensure the remote endpoint is valid and supports CORS or check console error logs.`;
    } finally {
      this.isExecuting = false;
    }
  }

  private async _copyResponseBody() {
    const text = this.responseBody || this.responseError;
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
      this.copiedState = true;
      setTimeout(() => (this.copiedState = false), 1500);
    } catch (err) {
      console.error('Failed to copy response body:', err);
    }
  }

  override render() {
    const sendIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
      </svg>
    `;

    return html`
      <div class="api-client-container">
        <!-- Input URL Panel -->
        <div class="api-client-header">
          <select
            class="method-select"
            .value=${this.method}
            @change=${this._changeMethod}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="DELETE">DELETE</option>
            <option value="PATCH">PATCH</option>
          </select>
          <input
            type="text"
            class="url-input"
            .value=${this.url}
            @input=${this._changeUrl}
            placeholder="https://api.example.com/endpoint"
          />
          <button
            class="send-button ${this.isExecuting ? 'running' : ''}"
            @click=${this._sendRequest}
            ?disabled=${this.isExecuting}
          >
            ${sendIcon()}
            <span>${this.isExecuting ? 'Sending...' : 'Send'}</span>
          </button>
        </div>

        <!-- Navigation Tabs -->
        <div class="tab-bar">
          <div
            class="tab-item ${this.activeTab === 'headers' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'headers')}
          >
            Headers (${this.headers.length})
          </div>
          <div
            class="tab-item ${this.activeTab === 'body' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'body')}
          >
            Body (JSON)
          </div>
          <div
            class="tab-item ${this.activeTab === 'response' ? 'active' : ''}"
            @click=${() => (this.activeTab = 'response')}
          >
            Response
          </div>
        </div>

        <!-- Working Tab Panel -->
        <div class="tab-pane">
          ${choose(this.activeTab, [
            [
              'headers',
              () => html`
                <div class="headers-list">
                  ${this.headers.map(
                    (header, index) => html`
                      <div class="header-row">
                        <input
                          type="checkbox"
                          class="header-checkbox"
                          .checked=${header.enabled}
                          @change=${() => this._toggleHeader(index)}
                        />
                        <input
                          type="text"
                          class="header-input"
                          placeholder="Header Key"
                          .value=${header.key}
                          @input=${(e: any) =>
                            this._changeHeader(index, 'key', e.target.value)}
                        />
                        <input
                          type="text"
                          class="header-input"
                          placeholder="Header Value"
                          .value=${header.value}
                          @input=${(e: any) =>
                            this._changeHeader(index, 'value', e.target.value)}
                        />
                        <button
                          class="remove-header-btn"
                          @click=${() => this._removeHeader(index)}
                        >
                          ✕
                        </button>
                      </div>
                    `
                  )}
                </div>
                <button class="add-header-btn" @click=${this._addHeader}>
                  + Add Header
                </button>
              `,
            ],
            [
              'body',
              () => html`
                <div
                  class="body-editor-container"
                  style=${styleMap({
                    display: this.activeTab === 'body' ? 'block' : 'none',
                  })}
                ></div>
              `,
            ],
            [
              'response',
              () => html`
                <div class="response-pane">
                  <!-- Response status info -->
                  ${this.responseStatus !== null || this.responseError
                    ? html`
                        <div class="response-meta">
                          ${this.responseStatus !== null
                            ? html`
                                <span
                                  class="status-tag ${this.responseStatus < 400
                                    ? 'success'
                                    : 'error'}"
                                >
                                  ${this.responseStatus}
                                  ${this.responseStatusText}
                                </span>
                                <span class="response-stat">
                                  Time: <strong>${this.responseTime}</strong>
                                </span>
                                <span class="response-stat">
                                  Size: <strong>${this.responseSize}</strong>
                                </span>
                              `
                            : nothing}
                        </div>
                      `
                    : html`
                        <div
                          class="console-welcome"
                          style="color:#808080; font-size:12px;"
                        >
                          No active response yet. Fire a request to view results
                          here.
                        </div>
                      `}

                  <!-- Response Content Display -->
                  ${this.responseBody || this.responseError
                    ? html`
                        <div class="response-content-wrapper">
                          <button
                            class="copy-response-btn"
                            @click=${this._copyResponseBody}
                          >
                            ${this.copiedState ? 'Copied!' : 'Copy'}
                          </button>

                          ${this.responseError
                            ? html`<div
                                class="response-body-viewer"
                                style="color: #f44747;"
                              >
                                ${this.responseError}
                              </div>`
                            : html`
                                <div
                                  style="display:flex; flex-direction:column; gap:8px;"
                                >
                                  <!-- Body Output -->
                                  <div class="response-body-viewer">
                                    ${this.responseBody}
                                  </div>

                                  <!-- Headers Output -->
                                  <div
                                    style="font-size: 10px; color:#808080; text-transform:uppercase; margin-top:8px;"
                                  >
                                    Headers:
                                  </div>
                                  <div class="response-headers-viewer">
                                    ${Object.entries(this.responseHeaders).map(
                                      ([key, value]) => html`
                                        <div class="response-header-line">
                                          <strong>${key}:</strong> ${value}
                                        </div>
                                      `
                                    )}
                                  </div>
                                </div>
                              `}
                        </div>
                      `
                    : nothing}
                </div>
              `,
            ],
          ])}
        </div>
      </div>
    `;
  }
}

export const CodeBlockApiPreviews = [
  CodeBlockPreviewExtension(
    'http',
    model => html`<api-test-preview .model=${model}></api-test-preview>`
  ),
  CodeBlockPreviewExtension(
    'api',
    model => html`<api-test-preview .model=${model}></api-test-preview>`
  ),
];

export function effects() {
  customElements.define('api-test-preview', ApiPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    'api-test-preview': ApiPreview;
  }
}

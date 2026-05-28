import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import type { CodeBlockModel } from '@blocksuite/affine/model';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/std';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

// Predefined Judge0 Language IDs
const JUDGE0_LANG_IDS: Record<string, number> = {
  python: 71, // Python (3.8.1)
  javascript: 63, // JavaScript (Node.js 12.14.0)
  typescript: 74, // TypeScript (3.7.4)
  c: 75, // C (Clang 7.0.1)
  cpp: 76, // C++ (Clang 7.0.1)
  csharp: 51, // C# (Mono 6.6.0.161)
  java: 62, // Java (OpenJDK 13.0.1)
  rust: 73, // Rust (1.40.0)
  go: 60, // Go (1.13.5)
  bash: 46, // Bash (5.0.0)
};

// Monaco dynamic CDN loader
let monacoLoadingPromise: Promise<any> | null = null;
function loadMonaco(): Promise<any> {
  if ((window as any).monaco) return Promise.resolve((window as any).monaco);
  if (monacoLoadingPromise) return monacoLoadingPromise;

  monacoLoadingPromise = new Promise((resolve, reject) => {
    // 1. Create container script for require.js if not existing
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
        require(['vs/editor/editor.main'], () => {
          resolve((window as any).monaco);
        }, (err: any) => reject(err));
      };
      loaderScript.onerror = err => reject(err);
      document.body.appendChild(loaderScript);
    } else {
      const require = (window as any).require;
      require(['vs/editor/editor.main'], () => {
        resolve((window as any).monaco);
      }, (err: any) => reject(err));
    }
  });

  return monacoLoadingPromise;
}

export class PlaygroundPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .playground-container {
      width: 100%;
      border: 1px solid ${unsafeCSSVarV2('layer/insideBorder/border')};
      border-radius: 8px;
      background: #1e1e1e; /* Premium Dark Theme base */
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-family: Inter, system-ui, sans-serif;
    }

    .playground-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: #252526;
      border-bottom: 1px solid #2d2d2d;
      color: #e1e1e1;
      height: 36px;
    }

    .playground-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .lang-badge {
      padding: 3px 8px;
      background: #3c3c3c;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #569cd6;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #a0a0a0;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #808080;
    }

    .status-dot.idle {
      background: #3794ff;
    }
    .status-dot.running {
      background: #e5c07b;
      animation: pulse 1.2s infinite;
    }
    .status-dot.success {
      background: #4ec9b0;
    }
    .status-dot.error {
      background: #f44747;
    }

    @keyframes pulse {
      0% {
        opacity: 0.4;
      }
      50% {
        opacity: 1;
      }
      100% {
        opacity: 0.4;
      }
    }

    .playground-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .action-button {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      border-radius: 4px;
      border: 1px solid transparent;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      background: #3c3c3c;
      color: #ffffff;
    }

    .action-button:hover {
      background: #4e4e4e;
    }

    .action-button.run {
      background: #0e639c;
    }

    .action-button.run:hover {
      background: #1177bb;
    }

    .action-button.run:active {
      transform: scale(0.97);
    }

    .action-button.disabled {
      opacity: 0.5;
      cursor: not-allowed;
      pointer-events: none;
    }

    .action-button svg {
      width: 14px;
      height: 14px;
      fill: currentColor;
    }

    /* Settings Dialog Overlay */
    .settings-panel {
      position: absolute;
      top: 40px;
      right: 16px;
      width: 280px;
      background: #252526;
      border: 1px solid #3c3c3c;
      border-radius: 6px;
      padding: 12px;
      z-index: 20;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .settings-panel h4 {
      margin: 0 0 4px 0;
      font-size: 13px;
      color: #ffffff;
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .settings-field label {
      font-size: 10px;
      color: #a0a0a0;
      text-transform: uppercase;
    }

    .settings-field input {
      background: #1e1e1e;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 4px 8px;
      color: #ffffff;
      font-size: 11px;
    }

    .settings-field input:focus {
      outline: 1px solid #0e639c;
    }

    /* Editor workspace */
    .playground-body {
      display: flex;
      flex-direction: column;
      width: 100%;
    }

    .editor-pane {
      width: 100%;
      height: 280px;
      position: relative;
    }

    .monaco-target {
      width: 100%;
      height: 100%;
    }

    /* Terminal Console */
    .console-pane {
      background: #181818;
      border-top: 1px solid #2d2d2d;
      color: #d4d4d4;
      font-family: 'Consolas', 'Fira Code', 'IBM Plex Mono', Courier, monospace;
      font-size: 12px;
      padding: 12px 16px;
      min-height: 120px;
      max-height: 240px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .console-welcome {
      color: #6a9955;
      font-style: italic;
    }

    .console-stdout {
      color: #e1e1e1;
      white-space: pre-wrap;
    }

    .console-stderr {
      color: #f44747;
      white-space: pre-wrap;
    }

    .console-system {
      color: #808080;
      font-size: 11px;
      display: flex;
      gap: 12px;
      margin-top: 4px;
      padding-top: 4px;
      border-top: 1px dashed #2d2d2d;
    }

    .system-metric {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .system-metric.time {
      color: #b5cea8;
    }
    .system-metric.memory {
      color: #ce9178;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: true })
  accessor lang: string = 'python';

  @state()
  accessor executionState: 'idle' | 'running' | 'success' | 'error' = 'idle';

  @state()
  accessor showSettings: boolean = false;

  @state()
  accessor apiEndpoint: string = 'http://localhost:2358';

  @state()
  accessor apiToken: string = '';

  // Terminal Outputs
  @state()
  accessor consoleWelcomeMsg: string =
    'Console initialized. Write code and click "Run Code" to execute.';
  @state()
  accessor stdout: string = '';
  @state()
  accessor stderr: string = '';
  @state()
  accessor compileOutput: string = '';
  @state()
  accessor execTime: string = '';
  @state()
  accessor execMemory: string = '';

  @query('.monaco-target')
  accessor monacoTarget!: HTMLDivElement;

  private _editorInstance: any = null;
  private _isSyncing = false;

  override connectedCallback() {
    super.connectedCallback();

    // Load configs from localStorage
    const savedEndpoint = localStorage.getItem('affine_playground_endpoint');
    if (savedEndpoint) this.apiEndpoint = savedEndpoint;

    const savedToken = localStorage.getItem('affine_playground_token');
    if (savedToken) this.apiToken = savedToken;
  }

  override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);

    // Load and mount Monaco Editor
    loadMonaco()
      .then(monaco => {
        this._initMonaco(monaco);
      })
      .catch(err => {
        console.error('Failed to load Monaco Editor from CDN:', err);
        this.consoleWelcomeMsg =
          'Error: Failed to load Monaco Editor. Please check your internet connection.';
        this.executionState = 'error';
      });

    // Listen to changes in the model text to update editor (when edited elsewhere)
    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._syncModelToEditor();
        })
      );
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this._editorInstance) {
      this._editorInstance.dispose();
      this._editorInstance = null;
    }
  }

  private _initMonaco(monaco: any) {
    if (!this.monacoTarget) return;

    // Get initial content
    const initialCode = this.model?.props.text.toString() ?? '';

    // Map general languages to Monaco syntax highlights
    let monacoLang = this.lang;
    if (monacoLang === 'bash' || monacoLang === 'sh') monacoLang = 'shell';

    this._editorInstance = monaco.editor.create(this.monacoTarget, {
      value: initialCode,
      language: monacoLang,
      theme: 'vs-dark',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      tabSize: 2,
    });

    // Listen to changes inside Monaco and sync back to Y.js Model
    this._editorInstance.onDidChangeModelContent(() => {
      if (this._isSyncing) return;
      this._isSyncing = true;

      const newCode = this._editorInstance.getValue();
      if (this.model) {
        // Safe Y.js Text manipulation
        const yText = this.model.props.text.yText;
        yText.delete(0, yText.length);
        yText.insert(0, newCode);
      }

      this._isSyncing = false;
    });
  }

  private _syncModelToEditor() {
    if (!this._editorInstance || this._isSyncing) return;
    this._isSyncing = true;

    const currentModelCode = this.model?.props.text.toString() ?? '';
    const currentEditorCode = this._editorInstance.getValue();

    if (currentModelCode !== currentEditorCode) {
      const position = this._editorInstance.getPosition();
      this._editorInstance.setValue(currentModelCode);
      if (position) {
        this._editorInstance.setPosition(position);
      }
    }

    this._isSyncing = false;
  }

  private _toggleSettings() {
    this.showSettings = !this.showSettings;
  }

  private _saveSettings(e: Event) {
    const target = e.target as HTMLInputElement;
    const value = target.value;
    const name = target.name;

    if (name === 'apiEndpoint') {
      this.apiEndpoint = value;
      localStorage.setItem('affine_playground_endpoint', value);
    } else if (name === 'apiToken') {
      this.apiToken = value;
      localStorage.setItem('affine_playground_token', value);
    }
  }

  private _clearConsole() {
    this.stdout = '';
    this.stderr = '';
    this.compileOutput = '';
    this.execTime = '';
    this.execMemory = '';
    this.consoleWelcomeMsg = 'Console cleared.';
    this.executionState = 'idle';
  }

  private async _runCode() {
    if (this.executionState === 'running') return;

    this.executionState = 'running';
    this.consoleWelcomeMsg = 'Submitting code to Judge0 sandbox...';
    this.stdout = '';
    this.stderr = '';
    this.compileOutput = '';
    this.execTime = '';
    this.execMemory = '';

    const code = this._editorInstance
      ? this._editorInstance.getValue()
      : (this.model?.props.text.toString() ?? '');
    const judgeLangId = JUDGE0_LANG_IDS[this.lang] || 71; // Fallback to Python if undefined

    try {
      // 1. Submit code to Judge0 sandbox
      const submitUrl = `${this.apiEndpoint}/submissions?base64_encoded=true&wait=false`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiToken) {
        headers['X-Auth-Token'] = this.apiToken;
      }

      const payload = {
        source_code: btoa(unescape(encodeURIComponent(code))),
        language_id: judgeLangId,
      };

      const response = await fetch(submitUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error(
          `HTTP error ${response.status}: ${response.statusText}`
        );
      }

      const submitResult = await response.json();
      const token = submitResult.token;

      if (!token) {
        throw new Error('No submission token received from Judge0.');
      }

      // 2. Poll submission status
      this.consoleWelcomeMsg = 'Code submitted. Running sandbox environment...';
      await this._pollStatus(token);
    } catch (err: any) {
      console.error('Submission failed:', err);
      this.consoleWelcomeMsg = '';
      this.stderr = `Execution Failed: ${err.message}\n\nPlease check if your Judge0 docker-compose service is active on ${this.apiEndpoint} or configure it in playground settings.`;
      this.executionState = 'error';
    }
  }

  private async _pollStatus(token: string) {
    const pollUrl = `${this.apiEndpoint}/submissions/${token}?base64_encoded=true`;
    const headers: Record<string, string> = {};
    if (this.apiToken) {
      headers['X-Auth-Token'] = this.apiToken;
    }

    try {
      const response = await fetch(pollUrl, { headers });
      if (!response.ok) {
        throw new Error(
          `HTTP error ${response.status}: ${response.statusText}`
        );
      }

      const result = await response.json();
      const statusId = result.status?.id;

      if (statusId === 1 || statusId === 2) {
        // Status: 1 (In Queue), 2 (Processing) -> Poll again after 800ms
        setTimeout(() => {
          this._pollStatus(token).catch(err => {
            console.error('Failed to poll status:', err);
          });
        }, 800);
      } else {
        // Finished executing! Decode and display results
        this.consoleWelcomeMsg = '';

        // Helper to decode Base64
        const decode = (b64: string | null) => {
          if (!b64) return '';
          try {
            return decodeURIComponent(escape(atob(b64)));
          } catch {
            return atob(b64);
          }
        };

        this.stdout = decode(result.stdout);
        this.stderr = decode(result.stderr);
        this.compileOutput = decode(result.compile_output);

        if (result.time) {
          this.execTime = `${Math.round(parseFloat(result.time) * 1000)} ms`;
        }
        if (result.memory) {
          this.execMemory = `${result.memory} KB`;
        }

        const statusDescription = result.status?.description;

        if (statusId === 3) {
          // Accepted (Success)
          this.executionState = 'success';
          if (!this.stdout && !this.stderr) {
            this.stdout = 'Program finished executing (no output).';
          }
        } else {
          this.executionState = 'error';
          if (this.compileOutput) {
            this.stderr = `Compile Error:\n${this.compileOutput}`;
          } else if (!this.stderr) {
            this.stderr = `Execution Error: ${statusDescription || 'Unknown execution issue'}`;
          }
        }
      }
    } catch (err: any) {
      console.error('Polling failed:', err);
      this.consoleWelcomeMsg = '';
      this.stderr = `Polling Failed: ${err.message}`;
      this.executionState = 'error';
    }
  }

  override render() {
    const playIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M8 5v14l11-7z" />
      </svg>
    `;

    const stopIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path d="M6 19h12V5H6v14z" />
      </svg>
    `;

    const trashIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path
          d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
        />
      </svg>
    `;

    const settingsIcon = () => html`
      <svg viewBox="0 0 24 24">
        <path
          d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
        />
      </svg>
    `;

    return html`
      <div class="playground-container">
        <!-- Header -->
        <div class="playground-header">
          <div class="playground-header-left">
            <span class="lang-badge">${this.lang}</span>
            <div class="status-indicator">
              <span class="status-dot ${this.executionState}"></span>
              <span>
                ${this.executionState === 'idle' ? 'Ready' : ''}
                ${this.executionState === 'running' ? 'Running...' : ''}
                ${this.executionState === 'success' ? 'Execution Complete' : ''}
                ${this.executionState === 'error' ? 'Failed' : ''}
              </span>
            </div>
          </div>
          <div class="playground-header-right">
            <button
              class="action-button run ${this.executionState === 'running'
                ? 'disabled'
                : ''}"
              @click=${this._runCode}
              title="Run Code"
            >
              ${this.executionState === 'running' ? stopIcon() : playIcon()}
              <span>Run</span>
            </button>
            <button
              class="action-button"
              @click=${this._clearConsole}
              title="Clear Console Output"
            >
              ${trashIcon()}
              <span>Clear</span>
            </button>
            <button
              class="action-button"
              @click=${this._toggleSettings}
              title="Settings"
            >
              ${settingsIcon()}
            </button>
          </div>
        </div>

        <!-- Settings overlay -->
        ${this.showSettings
          ? html`
              <div class="settings-panel">
                <h4>Playground Settings</h4>
                <div class="settings-field">
                  <label for="apiEndpoint">Judge0 API Endpoint</label>
                  <input
                    type="text"
                    id="apiEndpoint"
                    name="apiEndpoint"
                    .value=${this.apiEndpoint}
                    @input=${this._saveSettings}
                    placeholder="http://localhost:2358"
                  />
                </div>
                <div class="settings-field">
                  <label for="apiToken">API Token (Optional)</label>
                  <input
                    type="password"
                    id="apiToken"
                    name="apiToken"
                    .value=${this.apiToken}
                    @input=${this._saveSettings}
                    placeholder="X-Auth-Token"
                  />
                </div>
              </div>
            `
          : nothing}

        <!-- Workspace (Editor + Terminal Console) -->
        <div class="playground-body">
          <div class="editor-pane">
            <div class="monaco-target"></div>
          </div>

          <div class="console-pane">
            ${this.consoleWelcomeMsg
              ? html`<div class="console-welcome">
                  ${this.consoleWelcomeMsg}
                </div>`
              : nothing}
            ${this.stdout
              ? html`<div class="console-stdout">${this.stdout}</div>`
              : nothing}
            ${this.stderr
              ? html`<div class="console-stderr">${this.stderr}</div>`
              : nothing}

            <!-- System Metrics -->
            ${this.execTime || this.execMemory
              ? html`
                  <div class="console-system">
                    ${this.execTime
                      ? html`
                          <div class="system-metric time">
                            <span>⏱️ Time:</span>
                            <strong>${this.execTime}</strong>
                          </div>
                        `
                      : nothing}
                    ${this.execMemory
                      ? html`
                          <div class="system-metric memory">
                            <span>💾 Memory:</span>
                            <strong>${this.execMemory}</strong>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : nothing}
          </div>
        </div>
      </div>
    `;
  }
}

// Register all CodeBlock Playground Previews for specific languages
export const CodeBlockPlaygroundPreviews = [
  CodeBlockPreviewExtension(
    'python',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="python"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'javascript',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="javascript"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'typescript',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="typescript"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'c',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="c"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'cpp',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="cpp"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'csharp',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="csharp"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'java',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="java"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'rust',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="rust"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'go',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="go"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'bash',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="bash"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'shell',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="bash"
      ></code-playground-preview>`
  ),
  CodeBlockPreviewExtension(
    'sh',
    model =>
      html`<code-playground-preview
        .model=${model}
        lang="bash"
      ></code-playground-preview>`
  ),
];

export function effects() {
  customElements.define('code-playground-preview', PlaygroundPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    'code-playground-preview': PlaygroundPreview;
  }
}

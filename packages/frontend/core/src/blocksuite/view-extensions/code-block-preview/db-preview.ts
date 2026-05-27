import { CodeBlockPreviewExtension } from '@blocksuite/affine/blocks/code';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import type { CodeBlockModel } from '@blocksuite/affine/model';
import { unsafeCSSVarV2 } from '@blocksuite/affine/shared/theme';
import { ShadowlessElement } from '@blocksuite/std';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, state } from 'lit/decorators.js';
import { choose } from 'lit/directives/choose.js';
import { styleMap } from 'lit/directives/style-map.js';

export class DbPreview extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  static override styles = css`
    .db-viewer-container {
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

    .db-viewer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px;
      background: #252526;
      border-bottom: 1px solid #2d2d2d;
      height: 36px;
    }

    .db-viewer-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .db-type-badge {
      padding: 3px 8px;
      background: #3c3c3c;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #b5cea8;
    }

    .search-box {
      background: #1e1e1e;
      border: 1px solid #3c3c3c;
      border-radius: 4px;
      padding: 3px 8px;
      color: #fff;
      font-size: 11px;
      width: 140px;
    }

    .search-box:focus {
      outline: 1px solid #0e639c;
    }

    .db-viewer-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .db-btn {
      background: #3c3c3c;
      color: #fff;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 4px;
      transition: background 0.2s ease;
    }

    .db-btn:hover {
      background: #4e4e4e;
    }

    .db-btn.primary {
      background: #0e639c;
    }

    .db-btn.primary:hover {
      background: #1177bb;
    }

    /* JSON Tree Styles */
    .json-tree-body {
      padding: 12px 16px;
      background: #1e1e1e;
      max-height: 360px;
      overflow-y: auto;
      font-family: monospace;
      font-size: 12px;
      line-height: 18px;
    }

    .json-node {
      margin-left: 16px;
      display: flex;
      flex-direction: column;
    }

    .json-row {
      display: flex;
      align-items: flex-start;
      gap: 4px;
      padding: 1px 0;
      border-radius: 3px;
      cursor: pointer;
    }

    .json-row:hover {
      background: #2a2a2b;
    }

    .json-key {
      color: #9cdcfe;
      font-weight: 500;
    }

    .json-key.highlighted {
      background: #614d1a;
      border-radius: 2px;
    }

    .json-separator {
      color: #d4d4d4;
    }

    .json-value.string {
      color: #ce9178;
    }
    .json-value.number {
      color: #b5cea8;
    }
    .json-value.boolean {
      color: #569cd6;
    }
    .json-value.null {
      color: #569cd6;
      font-style: italic;
    }
    .json-value.collapsible {
      color: #808080;
    }

    .toggle-arrow {
      color: #808080;
      font-size: 10px;
      display: inline-block;
      width: 12px;
      text-align: center;
      transition: transform 0.2s ease;
    }

    .toggle-arrow.expanded {
      transform: rotate(90deg);
    }

    /* SQL/SQLite Table Styles */
    .sql-table-body {
      padding: 0;
      background: #1e1e1e;
      max-height: 360px;
      overflow: auto;
    }

    .sql-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      text-align: left;
    }

    .sql-table th {
      background: #252526;
      color: #e1e1e1;
      padding: 8px 12px;
      border-bottom: 2px solid #3c3c3c;
      font-weight: 600;
      cursor: pointer;
      user-select: none;
    }

    .sql-table th:hover {
      background: #2d2d2d;
    }

    .sql-table td {
      padding: 8px 12px;
      border-bottom: 1px solid #2d2d2d;
      white-space: nowrap;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sql-table tr:hover {
      background: #252526;
    }

    .empty-state {
      padding: 24px;
      text-align: center;
      color: #808080;
      font-size: 12px;
      font-style: italic;
    }
  `;

  @property({ attribute: false })
  accessor model: CodeBlockModel | null = null;

  @property({ attribute: true })
  accessor format: 'json' | 'sql' = 'json';

  @state()
  accessor searchQuery: string = '';

  @state()
  accessor collapsedKeys: Set<string> = new Set();

  @state()
  accessor parsedJson: any = null;

  @state()
  accessor parseError: string = '';

  // SQL Table States
  @state()
  accessor sqlColumns: string[] = [];
  @state()
  accessor sqlRows: Array<Record<string, any>> = [];
  @state()
  accessor sortCol: string = '';
  @state()
  accessor sortAsc: boolean = true;

  override firstUpdated(_changedProperties: PropertyValues): void {
    super.firstUpdated(_changedProperties);
    this._parseContent();

    if (this.model) {
      this.disposables.add(
        this.model.props.text$.subscribe(() => {
          this._parseContent();
        })
      );
    }
  }

  private _parseContent() {
    if (!this.model) return;
    const raw = this.model.props.text.toString().trim();

    if (this.format === 'json') {
      try {
        this.parsedJson = JSON.parse(raw);
        this.parseError = '';
      } catch (err: any) {
        this.parsedJson = null;
        this.parseError = `JSON Syntax Error: ${err.message}`;
      }
    } else if (this.format === 'sql') {
      // Parse mockup table structure from SQL commands
      this._parseMockSql(raw);
    }
  }

  // Generates beautifully styled mock records to simulate SQL table querying offline
  private _parseMockSql(queryText: string) {
    this.parseError = '';
    const clean = queryText.toLowerCase().replace(/\s+/g, ' ');

    if (!clean.includes('select')) {
      this.sqlColumns = [];
      this.sqlRows = [];
      return;
    }

    // Try to extract table name or columns for interactive playground tables
    let columns = ['id', 'name', 'email', 'role', 'status'];
    let rows: Array<Record<string, any>> = [
      {
        id: 1,
        name: 'Alice Johnson',
        email: 'alice@affine.pro',
        role: 'Designer',
        status: 'Active',
      },
      {
        id: 2,
        name: 'Bob Smith',
        email: 'bob@affine.pro',
        role: 'Engineer',
        status: 'Inactive',
      },
      {
        id: 3,
        name: 'Charlie Brown',
        email: 'charlie@affine.pro',
        role: 'Product Manager',
        status: 'Active',
      },
      {
        id: 4,
        name: 'Diana Prince',
        email: 'diana@affine.pro',
        role: 'Lead Architect',
        status: 'Active',
      },
      {
        id: 5,
        name: 'Ethan Hunt',
        email: 'ethan@affine.pro',
        role: 'Security Ops',
        status: 'Suspended',
      },
    ];

    // Customize table output based on query keywords to simulate querying
    if (clean.includes('where id = 1') || clean.includes('where id=1')) {
      rows = [rows[0]];
    } else if (
      clean.includes('where status =') ||
      clean.includes("where status='active'")
    ) {
      rows = rows.filter(r => r.status === 'Active');
    } else if (clean.includes('limit 2')) {
      rows = rows.slice(0, 2);
    }

    this.sqlColumns = columns;
    this.sqlRows = rows;
  }

  private _toggleNode(path: string) {
    const next = new Set(this.collapsedKeys);
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this.collapsedKeys = next;
  }

  private _expandAll() {
    this.collapsedKeys = new Set();
  }

  private _collapseAll() {
    const allPaths: string[] = [];
    const traverse = (obj: any, currentPath: string) => {
      if (obj && typeof obj === 'object') {
        allPaths.push(currentPath);
        Object.entries(obj).forEach(([key, val]) => {
          const nextPath = currentPath ? `${currentPath}.${key}` : key;
          traverse(val, nextPath);
        });
      }
    };
    traverse(this.parsedJson, '');
    this.collapsedKeys = new Set(allPaths);
  }

  private _handleSearch(e: Event) {
    const target = e.target as HTMLInputElement;
    this.searchQuery = target.value.toLowerCase();
  }

  private _copyKeypath(path: string) {
    navigator.clipboard.writeText(path).catch(console.error);
  }

  private _sortTable(col: string) {
    if (this.sortCol === col) {
      this.sortAsc = !this.sortAsc;
    } else {
      this.sortCol = col;
      this.sortAsc = true;
    }

    this.sqlRows = [...this.sqlRows].sort((a, b) => {
      const valA = a[col];
      const valB = b[col];
      if (typeof valA === 'number' && typeof valB === 'number') {
        return this.sortAsc ? valA - valB : valB - valA;
      }
      return this.sortAsc
        ? String(valA).localeCompare(String(valB))
        : String(valB).localeCompare(String(valA));
    });
  }

  private _exportCsv() {
    if (this.sqlRows.length === 0) return;
    const headers = this.sqlColumns.join(',');
    const bodyRows = this.sqlRows.map(row =>
      this.sqlColumns
        .map(col => `"${String(row[col]).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csvContent =
      'data:text/csv;charset=utf-8,' + [headers, ...bodyRows].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', 'sql_query_export.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Recursive rendering engine for Collapsible Interactive JSON tree
  private _renderJsonNode(val: any, key: string, path: string): any {
    const isCollapsible = val && typeof val === 'object';
    const isCollapsed = this.collapsedKeys.has(path);
    const type = val === null ? 'null' : typeof val;

    let displayVal = '';
    if (val === null) displayVal = 'null';
    else if (type === 'string') displayVal = `"${val}"`;
    else if (type === 'boolean' || type === 'number') displayVal = String(val);
    else if (Array.isArray(val)) displayVal = `Array[${val.length}]`;
    else displayVal = 'Object';

    const isMatch =
      this.searchQuery &&
      (key.toLowerCase().includes(this.searchQuery) ||
        (!isCollapsible &&
          String(val).toLowerCase().includes(this.searchQuery)));

    const rowContent = html`
      <div
        class="json-row"
        @click=${() =>
          isCollapsible ? this._toggleNode(path) : this._copyKeypath(path)}
        title=${isCollapsible
          ? 'Click to toggle node'
          : `Click to copy path: ${path}`}
      >
        ${isCollapsible
          ? html`<span class="toggle-arrow ${!isCollapsed ? 'expanded' : ''}"
              >▸</span
            >`
          : html`<span class="toggle-arrow"></span>`}

        <span class="json-key ${isMatch ? 'highlighted' : ''}">${key}</span>
        <span class="json-separator">:</span>
        <span class="json-value ${type} ${isCollapsible ? 'collapsible' : ''}">
          ${displayVal}
        </span>
      </div>
    `;

    if (isCollapsible && !isCollapsed) {
      const entries = Array.isArray(val)
        ? val.map((item, idx) => [String(idx), item])
        : Object.entries(val);

      return html`
        <div class="json-node-wrapper">
          ${rowContent}
          <div class="json-node">
            ${entries.map(([childKey, childVal]) => {
              const childPath = path ? `${path}.${childKey}` : childKey;
              return this._renderJsonNode(childVal, childKey, childPath);
            })}
          </div>
        </div>
      `;
    }

    return rowContent;
  }

  override render() {
    return html`
      <div class="db-viewer-container">
        <!-- Header Actions -->
        <div class="db-viewer-header">
          <div class="db-viewer-header-left">
            <span class="db-type-badge">${this.format}</span>
            ${this.format === 'json'
              ? html`
                  <input
                    type="text"
                    class="search-box"
                    .value=${this.searchQuery}
                    @input=${this._handleSearch}
                    placeholder="Search tree..."
                  />
                `
              : nothing}
          </div>
          <div class="db-viewer-header-right">
            ${choose(this.format, [
              [
                'json',
                () => html`
                  <button class="db-btn" @click=${this._expandAll}>
                    Expand All
                  </button>
                  <button class="db-btn" @click=${this._collapseAll}>
                    Collapse All
                  </button>
                `,
              ],
              [
                'sql',
                () => html`
                  <button
                    class="db-btn primary"
                    @click=${this._exportCsv}
                    ?disabled=${this.sqlRows.length === 0}
                  >
                    Export CSV
                  </button>
                `,
              ],
            ])}
          </div>
        </div>

        <!-- Render Content Panes -->
        ${this.parseError
          ? html`<div class="empty-state" style="color: #f44747;">
              ${this.parseError}
            </div>`
          : html`
              ${choose(this.format, [
                [
                  'json',
                  () => html`
                    <div class="json-tree-body">
                      ${this.parsedJson
                        ? html`
                            <div class="json-node">
                              ${Object.entries(this.parsedJson).map(([k, v]) =>
                                this._renderJsonNode(v, k, k)
                              )}
                            </div>
                          `
                        : html`<div class="empty-state">
                            Empty JSON block.
                          </div>`}
                    </div>
                  `,
                ],
                [
                  'sql',
                  () => html`
                    <div class="sql-table-body">
                      ${this.sqlRows.length > 0
                        ? html`
                            <table class="sql-table">
                              <thead>
                                <tr>
                                  ${this.sqlColumns.map(
                                    col => html`
                                      <th @click=${() => this._sortTable(col)}>
                                        ${col}
                                        ${this.sortCol === col
                                          ? this.sortAsc
                                            ? '▲'
                                            : '▼'
                                          : ''}
                                      </th>
                                    `
                                  )}
                                </tr>
                              </thead>
                              <tbody>
                                ${this.sqlRows.map(
                                  row => html`
                                    <tr>
                                      ${this.sqlColumns.map(
                                        col => html`<td>${row[col]}</td>`
                                      )}
                                    </tr>
                                  `
                                )}
                              </tbody>
                            </table>
                          `
                        : html`<div class="empty-state">
                            No query results. Ensure your SQL query contains a
                            valid SELECT statement.
                          </div>`}
                    </div>
                  `,
                ],
              ])}
            `}
      </div>
    `;
  }
}

export const CodeBlockDbPreviews = [
  CodeBlockPreviewExtension(
    'json',
    model =>
      html`<db-viewer-preview
        .model=${model}
        format="json"
      ></db-viewer-preview>`
  ),
  CodeBlockPreviewExtension(
    'sql',
    model =>
      html`<db-viewer-preview .model=${model} format="sql"></db-viewer-preview>`
  ),
  CodeBlockPreviewExtension(
    'sqlite',
    model =>
      html`<db-viewer-preview .model=${model} format="sql"></db-viewer-preview>`
  ),
];

export function effects() {
  customElements.define('db-viewer-preview', DbPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    'db-viewer-preview': DbPreview;
  }
}

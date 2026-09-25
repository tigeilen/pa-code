import * as vscode from 'vscode';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export class ProcessPropertiesPanel {
    public static currentPanel: ProcessPropertiesPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _document: vscode.TextDocument;
    private _instanceName: string | undefined;
    private _reloadTimer: ReturnType<typeof setTimeout> | undefined;

    private constructor(panel: vscode.WebviewPanel, document: vscode.TextDocument) {
        this._panel = panel;
        this._document = document;
        this._instanceName = this._resolveInstance();
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(this._handleMessage.bind(this), null, this._disposables);
        // Live-sync: when the underlying .ti file changes (e.g. variables edited in
        // the JSON Properties block), reload so the tabs reflect it. Debounced.
        vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== this._document.uri.toString()) return;
            if (this._reloadTimer) clearTimeout(this._reloadTimer);
            this._reloadTimer = setTimeout(() => this._loadProperties(), 300);
        }, null, this._disposables);
        this._loadProperties();
    }

    public static render(document: vscode.TextDocument) {
        if (ProcessPropertiesPanel.currentPanel) {
            ProcessPropertiesPanel.currentPanel._document = document;
            ProcessPropertiesPanel.currentPanel._instanceName = ProcessPropertiesPanel.currentPanel._resolveInstance();
            ProcessPropertiesPanel.currentPanel._panel.reveal(vscode.ViewColumn.Beside);
            ProcessPropertiesPanel.currentPanel._loadProperties();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'processProperties',
            `Properties: ${document.fileName.split(/[/\\]/).pop()?.replace('.ti', '') || 'Process'}`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        panel.webview.html = ProcessPropertiesPanel._getHtml();
        ProcessPropertiesPanel.currentPanel = new ProcessPropertiesPanel(panel, document);
    }

    private _resolveInstance(): string | undefined {
        const filePath = this._document.fileName;
        const parentDir = path.dirname(filePath);
        const serverFolder = path.dirname(parentDir);
        const serverRealName = path.basename(serverFolder);
        const envFolderDir = path.dirname(serverFolder);
        const envFolder = path.basename(envFolderDir);

        const config = ConfigManager.getConfig();
        const envConfig = config.environments?.find((e: any) => e.folder === envFolder);
        if (!envConfig) return undefined;
        return `${envConfig.name}_${serverRealName}`;
    }

    private _loadProperties() {
        const text = this._document.getText();
        const jsonMatch = text.match(/#JSON_PROPERTIES\s*([\s\S]*?)$/i);
        let properties: any = { Parameters: [], DataSource: { Type: 'None' }, Variables: [] };
        let parseError: string | undefined;
        if (jsonMatch && jsonMatch[1] && jsonMatch[1].trim()) {
            try { properties = JSON.parse(jsonMatch[1].trim()); }
            catch (e: any) { parseError = e?.message || 'Invalid JSON'; }
        }
        // Guarantee the collections exist so the tabs render consistently.
        if (!Array.isArray(properties.Parameters)) properties.Parameters = [];
        if (!Array.isArray(properties.Variables)) properties.Variables = [];
        if (!properties.DataSource || typeof properties.DataSource !== 'object') properties.DataSource = { Type: 'None' };
        this._panel.webview.postMessage({
            command: 'loadProperties',
            properties,
            parseError,
            connected: !!(this._instanceName && TM1Service.getInstance().isConnected(this._instanceName))
        });
    }

    private async _handleMessage(message: any) {
        switch (message.command) {
            case 'saveProperties':
                await this._saveProperties(message.properties);
                return;
            case 'ready':
                this._loadProperties();
                return;
            case 'fetchCubes':
                await this._fetchCubes();
                return;
            case 'fetchDimensions':
                await this._fetchDimensions();
                return;
            case 'fetchViews':
                await this._fetchViews(message.cubeName);
                return;
            case 'fetchSubsets':
                await this._fetchSubsets(message.dimensionName);
                return;
            case 'previewDataSource':
                await this._previewDataSource(message.dataSource);
                return;
            case 'formatSql':
                this._panel.webview.postMessage({ command: 'sqlFormatted', sql: this._formatSql(message.sql || '') });
                return;
        }
    }

    /**
     * Conservative SQL pretty-printer: puts major clauses on their own lines and
     * indents AND/OR/ON. It intentionally does not touch casing, split commas, or
     * reformat inside parentheses, to avoid ever corrupting a valid query.
     */
    private _formatSql(sql: string): string {
        if (!sql || !sql.trim()) return sql;
        let s = sql.replace(/\s+/g, ' ').trim();
        const majors = [
            'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING',
            'UNION ALL', 'UNION', 'INNER JOIN', 'LEFT OUTER JOIN', 'LEFT JOIN',
            'RIGHT OUTER JOIN', 'RIGHT JOIN', 'FULL OUTER JOIN', 'FULL JOIN',
            'CROSS JOIN', 'JOIN', 'ON', 'AND', 'OR'
        ];
        for (const kw of majors) {
            const re = new RegExp('\\s+(' + kw.replace(/ /g, '\\s+') + ')\\b', 'gi');
            s = s.replace(re, '\n$1');
        }
        return s.split('\n')
            .map(l => l.trim())
            .filter(l => l.length)
            .map(l => /^(AND|OR|ON)\b/i.test(l) ? '  ' + l : l)
            .join('\n');
    }

    private async _previewDataSource(dataSource: any) {
        if (!this._instanceName) {
            this._panel.webview.postMessage({ command: 'previewResult', error: 'Not connected to a TM1 instance.' });
            return;
        }
        try {
            const type = dataSource?.Type;
            let result: { headers: string[]; rows: string[][] };

            if (type === 'TM1CubeView') {
                const cube = dataSource.dataSourceNameForServer || '';
                const view = dataSource.view || '';
                if (!cube || !view) throw new Error('Cube and View must be specified.');
                result = await TM1Service.getInstance().previewCubeView(this._instanceName, cube, view, 10);
            } else if (type === 'TM1DimensionSubset') {
                const dimHier = dataSource.dataSourceNameForServer || '';
                const subset = dataSource.subset || '';
                if (!dimHier || !subset) throw new Error('Dimension and Subset must be specified.');
                const parts = dimHier.split(':');
                const dim = parts[0];
                const hier = parts[1] || parts[0];
                result = await TM1Service.getInstance().previewDimensionSubset(this._instanceName, dim, hier, subset, 10);
            } else {
                this._panel.webview.postMessage({ command: 'previewResult', error: 'Preview is only available for Cube View and Dimension Subset data sources.' });
                return;
            }

            this._panel.webview.postMessage({ command: 'previewResult', data: result });
        } catch (error: any) {
            this._panel.webview.postMessage({ command: 'previewResult', error: error.message || 'Preview failed.' });
        }
    }

    private async _fetchCubes() {
        if (!this._instanceName) return;
        try {
            const cubes = await TM1Service.getInstance().getCubes(this._instanceName, 'all');
            this._panel.webview.postMessage({ command: 'cubesList', items: cubes.map((c: any) => c.Name) });
        } catch {
            this._panel.webview.postMessage({ command: 'cubesList', items: [] });
        }
    }

    private async _fetchDimensions() {
        if (!this._instanceName) return;
        try {
            const dims = await TM1Service.getInstance().getDimensions(this._instanceName);
            this._panel.webview.postMessage({ command: 'dimensionsList', items: dims.map((d: any) => d.Name) });
        } catch {
            this._panel.webview.postMessage({ command: 'dimensionsList', items: [] });
        }
    }

    private async _fetchViews(cubeName: string) {
        if (!this._instanceName || !cubeName) return;
        try {
            const views = await TM1Service.getInstance().getViews(this._instanceName, cubeName);
            this._panel.webview.postMessage({ command: 'viewsList', items: views.map((v: any) => v.Name) });
        } catch {
            this._panel.webview.postMessage({ command: 'viewsList', items: [] });
        }
    }

    private async _fetchSubsets(dimensionName: string) {
        if (!this._instanceName || !dimensionName) return;
        try {
            const subsets = await TM1Service.getInstance().getSubsets(this._instanceName, dimensionName);
            this._panel.webview.postMessage({ command: 'subsetsList', items: subsets.map((s: any) => s.Name) });
        } catch {
            this._panel.webview.postMessage({ command: 'subsetsList', items: [] });
        }
    }

    private async _saveProperties(properties: any) {
        const text = this._document.getText();
        const jsonMarker = '#JSON_PROPERTIES';
        const markerIndex = text.indexOf(jsonMarker);

        let newText: string;
        const propertiesJson = JSON.stringify(properties, null, 2);

        if (markerIndex !== -1) {
            newText = text.substring(0, markerIndex) + jsonMarker + '\n' + propertiesJson;
        } else {
            newText = text + '\n\n' + jsonMarker + '\n' + propertiesJson;
        }

        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            this._document.positionAt(0),
            this._document.positionAt(text.length)
        );
        edit.replace(this._document.uri, fullRange, newText);
        await vscode.workspace.applyEdit(edit);

        vscode.window.showInformationMessage('Process properties updated.');
        this._loadProperties();
    }

    public dispose() {
        ProcessPropertiesPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private static _getHtml(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Process Properties</title>
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 12px; margin: 0; font-size: 13px; }
    .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 12px; }
    .tab { padding: 8px 16px; cursor: pointer; border-bottom: 2px solid transparent; opacity: 0.7; }
    .tab:hover { opacity: 1; }
    .tab.active { border-bottom-color: var(--vscode-focusBorder); opacity: 1; font-weight: bold; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    label { display: block; margin: 8px 0 4px; font-weight: 600; }
    select, input[type="text"], input[type="number"] {
        width: 100%; padding: 6px 8px; box-sizing: border-box;
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border); border-radius: 3px;
    }
    select { appearance: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    th { font-weight: 600; opacity: 0.8; font-size: 12px; }
    td input, td select { width: 100%; border: none; background: transparent; color: inherit; padding: 2px 4px; }
    td input:focus, td select:focus { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-input-background); }
    .btn { padding: 6px 14px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; margin-right: 6px; margin-top: 10px; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    .btn-danger { background: #d32f2f; color: #fff; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .actions { margin-top: 16px; display: flex; align-items: center; }
    .hint { opacity: 0.6; font-size: 11px; margin-top: 2px; }
    .empty-state { opacity: 0.5; padding: 20px; text-align: center; }
    .preview-table { font-size: 12px; margin-top: 6px; }
    .preview-table th { background: var(--vscode-editor-inactiveSelectionBackground); font-size: 11px; }
    .preview-table td { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .preview-error { color: var(--vscode-errorForeground); padding: 8px; font-size: 12px; }
    .preview-loading { opacity: 0.6; padding: 8px; font-style: italic; }

    /* Searchable dropdown */
    .search-select { position: relative; }
    .search-select input { width: 100%; padding: 6px 28px 6px 8px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
    .search-select input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .search-select .ss-arrow { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); pointer-events: none; opacity: 0.5; font-size: 10px; }
    .search-select .ss-dropdown { display: none; position: absolute; top: 100%; left: 0; right: 0; max-height: 200px; overflow-y: auto; background: var(--vscode-dropdown-background, var(--vscode-input-background)); border: 1px solid var(--vscode-input-border); border-top: none; border-radius: 0 0 3px 3px; z-index: 100; box-shadow: 0 4px 8px rgba(0,0,0,0.3); }
    .search-select .ss-dropdown.open { display: block; }
    .search-select .ss-item { padding: 5px 8px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .search-select .ss-item:hover, .search-select .ss-item.highlighted { background: var(--vscode-list-hoverBackground); }
    .search-select .ss-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .search-select .ss-loading { padding: 8px; text-align: center; opacity: 0.6; }
    .search-select .ss-empty { padding: 8px; text-align: center; opacity: 0.5; font-style: italic; }
</style>
</head>
<body>
<div id="jsonError" style="display:none; margin:0 0 10px; padding:8px 10px; border:1px solid var(--vscode-inputValidation-errorBorder,#be1100); background:var(--vscode-inputValidation-errorBackground,#5a1d1d); color:var(--vscode-foreground); border-radius:4px; font-size:12px;"></div>
<div class="tabs">
    <div class="tab active" data-tab="datasource">Data Source</div>
    <div class="tab" data-tab="parameters">Parameters</div>
    <div class="tab" data-tab="variables">Variables</div>
</div>

<div id="tab-datasource" class="tab-content active">
    <label>Data Source Type</label>
    <select id="dsType">
        <option value="None">None</option>
        <option value="TM1CubeView">Cube View</option>
        <option value="TM1DimensionSubset">Dimension Subset</option>
        <option value="ASCII">ASCII File</option>
        <option value="CHARACTERDELIMITED">Character Delimited File</option>
        <option value="ODBC">ODBC</option>
    </select>

    <div id="ds-fields"></div>
    <div id="ds-preview-section" style="display:none; margin-top:12px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
            <span style="font-weight:600;">Data Preview</span>
            <button class="btn btn-secondary" onclick="previewDataSource()">Preview</button>
        </div>
        <div id="ds-preview-result" style="margin-top:8px;"></div>
    </div>
</div>

<div id="tab-parameters" class="tab-content">
    <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600;">Parameters</span>
        <button class="btn btn-secondary" onclick="addParameter()">+ Add Parameter</button>
    </div>
    <table id="paramTable">
        <thead><tr><th>#</th><th>Name</th><th>Prompt</th><th>Type</th><th>Default Value</th><th></th></tr></thead>
        <tbody id="paramBody"></tbody>
    </table>
    <div id="paramEmpty" class="empty-state">No parameters defined.</div>
</div>

<div id="tab-variables" class="tab-content">
    <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600;">Variables</span>
        <button class="btn btn-secondary" onclick="addVariable()">+ Add Variable</button>
    </div>
    <table id="varTable">
        <thead><tr><th>#</th><th>Name</th><th>Type</th><th></th></tr></thead>
        <tbody id="varBody"></tbody>
    </table>
    <div id="varEmpty" class="empty-state">No variables defined.</div>
</div>

<div class="actions">
    <button class="btn btn-primary" onclick="save()">Save Properties</button>
</div>

<script>
const vscode = acquireVsCodeApi();
let properties = { Parameters: [], DataSource: { Type: 'None' }, Variables: [] };
let isConnected = false;

// Cached lists
let cachedCubes = null;
let cachedDimensions = null;
let cachedViews = {};
let cachedSubsets = {};

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    });
});

// ========== Searchable Dropdown Component ==========
class SearchSelect {
    constructor(container, options = {}) {
        this.container = container;
        this.options = options;
        this.items = [];
        this.value = '';
        this.highlightIdx = -1;
        this.isOpen = false;
        this._build();
    }

    _build() {
        this.container.classList.add('search-select');
        this.container.innerHTML = \`
            <input type="text" placeholder="\${this.options.placeholder || 'Search...'}" autocomplete="off">
            <span class="ss-arrow">&#9662;</span>
            <div class="ss-dropdown"></div>\`;
        this.input = this.container.querySelector('input');
        this.dropdown = this.container.querySelector('.ss-dropdown');

        this.input.addEventListener('focus', () => this._open());
        this.input.addEventListener('input', () => this._filter());
        this.input.addEventListener('keydown', (e) => this._keydown(e));
        this.input.addEventListener('blur', () => setTimeout(() => this._close(), 150));
    }

    setItems(items) {
        this.items = items || [];
        if (this.isOpen) this._render();
    }

    setValue(val) {
        this.value = val || '';
        this.input.value = this.value;
    }

    getValue() { return this.input.value; }

    _open() {
        this.isOpen = true;
        this.highlightIdx = -1;
        if (this.items.length === 0 && this.options.onFetch) {
            this.dropdown.innerHTML = '<div class="ss-loading">Loading...</div>';
            this.dropdown.classList.add('open');
            this.options.onFetch();
        } else {
            this._render();
        }
    }

    _close() {
        this.isOpen = false;
        this.dropdown.classList.remove('open');
        // If the typed value changed, notify
        if (this.input.value !== this.value) {
            this.value = this.input.value;
            if (this.options.onChange) this.options.onChange(this.value);
        }
    }

    _filter() {
        this._render();
    }

    _render() {
        const query = this.input.value.toLowerCase();
        const filtered = this.items.filter(item => item.toLowerCase().includes(query));
        if (filtered.length === 0) {
            this.dropdown.innerHTML = '<div class="ss-empty">No matches</div>';
        } else {
            this.dropdown.innerHTML = filtered.map((item, i) =>
                \`<div class="ss-item\${item === this.value ? ' selected' : ''}\${i === this.highlightIdx ? ' highlighted' : ''}" data-value="\${esc(item)}">\${esc(item)}</div>\`
            ).join('');
            this.dropdown.querySelectorAll('.ss-item').forEach(el => {
                el.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    this._select(el.dataset.value);
                });
            });
        }
        this.dropdown.classList.add('open');
    }

    _select(val) {
        this.value = val;
        this.input.value = val;
        this._close();
        if (this.options.onChange) this.options.onChange(val);
    }

    _keydown(e) {
        if (!this.isOpen) return;
        const items = this.dropdown.querySelectorAll('.ss-item');
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.highlightIdx = Math.min(this.highlightIdx + 1, items.length - 1);
            this._updateHighlight(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.highlightIdx = Math.max(this.highlightIdx - 1, 0);
            this._updateHighlight(items);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.highlightIdx >= 0 && items[this.highlightIdx]) {
                this._select(items[this.highlightIdx].dataset.value);
            }
        } else if (e.key === 'Escape') {
            this._close();
        }
    }

    _updateHighlight(items) {
        items.forEach((el, i) => el.classList.toggle('highlighted', i === this.highlightIdx));
        if (items[this.highlightIdx]) items[this.highlightIdx].scrollIntoView({ block: 'nearest' });
    }
}

// ========== Searchable dropdown instances ==========
let ssCube, ssView, ssDimension, ssSubset;

// Data Source type-specific fields
function renderDsFields() {
    const type = document.getElementById('dsType').value;
    const container = document.getElementById('ds-fields');
    const previewSection = document.getElementById('ds-preview-section');

    // Show preview button only for Cube View and Dimension Subset
    const hasPreview = (type === 'TM1CubeView' || type === 'TM1DimensionSubset');
    previewSection.style.display = hasPreview ? 'block' : 'none';
    document.getElementById('ds-preview-result').innerHTML = '';

    ssCube = ssView = ssDimension = ssSubset = null;

    if (type === 'TM1CubeView') {
        container.innerHTML = \`
            <div class="form-row">
                <div><label>Cube</label><div id="ss-cube"></div></div>
                <div><label>View</label><div id="ss-view"></div></div>
            </div>
            <p class="hint">Start typing to search. Data is loaded from the connected TM1 instance.</p>\`;

        ssCube = new SearchSelect(document.getElementById('ss-cube'), {
            placeholder: 'Search cube...',
            onFetch: () => { vscode.postMessage({ command: 'fetchCubes' }); },
            onChange: (val) => {
                // When cube changes, reset view and fetch views for that cube
                if (ssView) { ssView.setItems([]); ssView.setValue(''); }
                cachedViews = {};
                if (val) vscode.postMessage({ command: 'fetchViews', cubeName: val });
            }
        });
        if (cachedCubes) ssCube.setItems(cachedCubes);

        ssView = new SearchSelect(document.getElementById('ss-view'), {
            placeholder: 'Search view...',
            onFetch: () => {
                const cube = ssCube ? ssCube.getValue() : '';
                if (cube) vscode.postMessage({ command: 'fetchViews', cubeName: cube });
            }
        });

    } else if (type === 'TM1DimensionSubset') {
        container.innerHTML = \`
            <div class="form-row">
                <div><label>Dimension</label><div id="ss-dimension"></div></div>
                <div><label>Subset</label><div id="ss-subset"></div></div>
            </div>
            <p class="hint">Start typing to search. Data is loaded from the connected TM1 instance.</p>\`;

        ssDimension = new SearchSelect(document.getElementById('ss-dimension'), {
            placeholder: 'Search dimension...',
            onFetch: () => { vscode.postMessage({ command: 'fetchDimensions' }); },
            onChange: (val) => {
                if (ssSubset) { ssSubset.setItems([]); ssSubset.setValue(''); }
                cachedSubsets = {};
                if (val) vscode.postMessage({ command: 'fetchSubsets', dimensionName: val });
            }
        });
        if (cachedDimensions) ssDimension.setItems(cachedDimensions);

        ssSubset = new SearchSelect(document.getElementById('ss-subset'), {
            placeholder: 'Search subset...',
            onFetch: () => {
                const dim = ssDimension ? ssDimension.getValue() : '';
                if (dim) vscode.postMessage({ command: 'fetchSubsets', dimensionName: dim });
            }
        });

    } else if (type === 'ASCII' || type === 'CHARACTERDELIMITED') {
        container.innerHTML = \`
            <label>File Path</label><input type="text" id="ds-filename" placeholder="Path to file">
            <div class="form-row">
                <div><label>Header Records</label><input type="number" id="ds-header" value="0" min="0"></div>
                <div><label>Delimiter</label>
                    <select id="ds-delimiter">
                        <option value=",">Comma</option>
                        <option value="&#9;">Tab</option>
                        <option value=";">Semicolon</option>
                        <option value="|">Pipe</option>
                    </select>
                </div>
            </div>
            <div class="form-row">
                <div><label>Quote Character</label><input type="text" id="ds-quote" value="\\"" maxlength="1"></div>
                <div><label>Decimal Separator</label><input type="text" id="ds-decimal" value="." maxlength="1"></div>
            </div>\`;
    } else if (type === 'ODBC') {
        container.innerHTML = \`
            <label>Data Source Name</label><input type="text" id="ds-dsn" placeholder="ODBC DSN">
            <label>User Name</label><input type="text" id="ds-user" placeholder="User">
            <label>Password</label><input type="text" id="ds-pass" placeholder="Password">
            <label>Query <button type="button" onclick="formatSql()" style="font-size:11px;padding:2px 8px;margin-left:6px;">Format SQL</button></label>
            <textarea id="ds-query" placeholder="SELECT ..." rows="8" spellcheck="false" style="width:100%;box-sizing:border-box;font-family:var(--vscode-editor-font-family,monospace);white-space:pre;resize:vertical;"></textarea>\`;
    } else {
        container.innerHTML = '';
    }

    populateDsFields();
}

function populateDsFields() {
    const ds = properties.DataSource || {};
    const type = ds.Type || 'None';

    if (type === 'TM1CubeView') {
        const cube = ds.dataSourceNameForServer || ds.DatasourceNameForServer || '';
        const view = ds.view || '';
        if (ssCube) ssCube.setValue(cube);
        if (ssView) ssView.setValue(view);
    } else if (type === 'TM1DimensionSubset') {
        const dimHier = ds.dataSourceNameForServer || ds.DatasourceNameForServer || '';
        const subset = ds.subset || '';
        // dimHier format is "Dimension:Hierarchy"
        const dimName = dimHier.includes(':') ? dimHier.split(':')[0] : dimHier;
        if (ssDimension) ssDimension.setValue(dimName);
        if (ssSubset) ssSubset.setValue(subset);
    } else if (type === 'ASCII' || type === 'CHARACTERDELIMITED') {
        setVal('ds-filename', ds.dataSourceNameForServer || ds.DatasourceNameForServer || '');
        setVal('ds-header', ds.asciiHeaderRecords ?? ds.dataSourceHeaderLines ?? '0');
        setVal('ds-delimiter', ds.asciiDelimiterChar || ds.dataSourceColumnDelimiter || ',');
        setVal('ds-quote', ds.asciiQuoteCharacter || ds.dataSourceQuoteCharacter || '"');
        setVal('ds-decimal', ds.asciiDecimalSeparator || ds.dataSourceDecimalSeparator || '.');
    } else if (type === 'ODBC') {
        setVal('ds-dsn', ds.dataSourceNameForServer || ds.DatasourceNameForServer || '');
        setVal('ds-user', ds.dataSourceUserName || ds.DatasourceUserName || '');
        setVal('ds-pass', ds.dataSourcePassword || ds.DatasourcePassword || '');
        setVal('ds-query', ds.dataSourceQuery || ds.DatasourceQuery || '');
    }
}

function setVal(id, val) {
    const el = document.getElementById(id);
    if (el) el.value = val;
}
function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

document.getElementById('dsType').addEventListener('change', renderDsFields);

// Parameters
function renderParameters() {
    const body = document.getElementById('paramBody');
    const empty = document.getElementById('paramEmpty');
    const params = properties.Parameters || [];
    if (params.length === 0) { body.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    body.innerHTML = params.map((p, i) => \`<tr>
        <td>\${i + 1}</td>
        <td><input value="\${esc(p.Name || '')}" data-idx="\${i}" data-field="Name"></td>
        <td><input value="\${esc(p.Prompt || '')}" data-idx="\${i}" data-field="Prompt"></td>
        <td><select data-idx="\${i}" data-field="Type"><option value="2" \${p.Type===2?'selected':''}>String</option><option value="1" \${p.Type===1?'selected':''}>Numeric</option></select></td>
        <td><input value="\${esc(String(p.Value ?? ''))}" data-idx="\${i}" data-field="Value"></td>
        <td><button class="btn btn-danger" onclick="removeParam(\${i})" title="Remove">\u00d7</button></td>
    </tr>\`).join('');
}

function addParameter() {
    if (!properties.Parameters) properties.Parameters = [];
    properties.Parameters = collectParameters();
    properties.Parameters.push({ Name: 'pNew', Prompt: '', Value: '', Type: 2 });
    renderParameters();
}

function removeParam(idx) {
    properties.Parameters = collectParameters();
    properties.Parameters.splice(idx, 1);
    renderParameters();
}

// Variables
// TM1 returns variable Type as "String"/"Numeric"; tolerate numeric codes and
// short forms so hand-edited JSON still displays and selects the right option.
function varTypeLabel(t) {
    const s = String(t == null ? '' : t).toLowerCase();
    if (s === 'numeric' || s === 'n' || s === '1' || s === '2') return 'Numeric';
    return 'String';
}
function renderVariables() {
    const body = document.getElementById('varBody');
    const empty = document.getElementById('varEmpty');
    const vars = properties.Variables || [];
    if (vars.length === 0) { body.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';
    body.innerHTML = vars.map((v, i) => { const vt = varTypeLabel(v.Type); return \`<tr>
        <td>\${i + 1}</td>
        <td><input value="\${esc(v.Name || '')}" data-vidx="\${i}" data-field="Name"></td>
        <td><select data-vidx="\${i}" data-field="Type"><option value="String" \${vt==='String'?'selected':''}>String</option><option value="Numeric" \${vt==='Numeric'?'selected':''}>Numeric</option></select></td>
        <td><button class="btn btn-danger" onclick="removeVar(\${i})" title="Remove">\u00d7</button></td>
    </tr>\`; }).join('');
}

function addVariable() {
    if (!properties.Variables) properties.Variables = [];
    properties.Variables = collectVariables();
    properties.Variables.push({ Name: 'vNew', StartByte: 0, EndByte: 0, Type: 'String' });
    renderVariables();
}

function removeVar(idx) {
    properties.Variables = collectVariables();
    properties.Variables.splice(idx, 1);
    renderVariables();
}

function collectDsProperties() {
    const type = document.getElementById('dsType').value;
    // Preserve properties the form doesn't edit (e.g. asciiThousandSeparator,
    // asciiDelimiterType) so saving never drops or corrupts the datasource.
    const orig = (properties.DataSource && properties.DataSource.Type === type) ? properties.DataSource : {};
    const ds = Object.assign({}, orig, { Type: type });

    if (type === 'TM1CubeView') {
        const cubeName = ssCube ? ssCube.getValue() : '';
        ds.dataSourceNameForServer = cubeName;
        ds.dataSourceNameForClient = cubeName;
        ds.view = ssView ? ssView.getValue() : '';
    } else if (type === 'TM1DimensionSubset') {
        const dimName = ssDimension ? ssDimension.getValue() : '';
        const dimHier = dimName + ':' + dimName;
        ds.dataSourceNameForServer = dimHier;
        ds.dataSourceNameForClient = dimHier;
        ds.subset = ssSubset ? ssSubset.getValue() : '';
    } else if (type === 'ASCII' || type === 'CHARACTERDELIMITED') {
        // TM1 ASCII datasources use ascii*-prefixed property names.
        ds.dataSourceNameForServer = getVal('ds-filename');
        if (!ds.dataSourceNameForClient) ds.dataSourceNameForClient = ds.dataSourceNameForServer;
        ds.asciiHeaderRecords = parseInt(getVal('ds-header')) || 0;
        ds.asciiDelimiterType = 'Character';
        ds.asciiDelimiterChar = getVal('ds-delimiter');
        ds.asciiQuoteCharacter = getVal('ds-quote');
        ds.asciiDecimalSeparator = getVal('ds-decimal');
        // Decimal and thousands separators must differ.
        if (ds.asciiThousandSeparator === undefined || ds.asciiThousandSeparator === ds.asciiDecimalSeparator) {
            ds.asciiThousandSeparator = ds.asciiDecimalSeparator === '.' ? ',' : '.';
        }
        // Drop any stale generic keys written by earlier buggy saves.
        delete ds.dataSourceHeaderLines; delete ds.dataSourceColumnDelimiter;
        delete ds.dataSourceQuoteCharacter; delete ds.dataSourceDecimalSeparator;
    } else if (type === 'ODBC') {
        ds.dataSourceNameForServer = getVal('ds-dsn');
        if (ds.dataSourceNameForClient === undefined) ds.dataSourceNameForClient = '';
        ds.dataSourceUserName = getVal('ds-user');
        ds.dataSourcePassword = getVal('ds-pass');
        ds.dataSourceQuery = getVal('ds-query');
    }

    return ds;
}

function collectParameters() {
    const rows = document.querySelectorAll('#paramBody tr');
    return Array.from(rows).map((row, i) => {
        const inputs = row.querySelectorAll('input, select');
        const p = properties.Parameters[i] || {};
        inputs.forEach(inp => {
            const field = inp.dataset.field;
            if (field === 'Type') p.Type = parseInt(inp.value);
            else if (field === 'Value') p.Value = p.Type === 1 ? (parseFloat(inp.value) || 0) : inp.value;
            else if (field) p[field] = inp.value;
        });
        return p;
    });
}

function collectVariables() {
    const rows = document.querySelectorAll('#varBody tr');
    return Array.from(rows).map((row, i) => {
        const inputs = row.querySelectorAll('input, select');
        const v = properties.Variables[i] || {};
        inputs.forEach(inp => {
            const field = inp.dataset.field;
            if (field) v[field] = inp.value;
        });
        return v;
    });
}

function save() {
    const result = {
        Parameters: collectParameters(),
        DataSource: collectDsProperties(),
        Variables: collectVariables(),
        HasSecurityAccess: properties.HasSecurityAccess || false
    };
    vscode.postMessage({ command: 'saveProperties', properties: result });
}

function previewDataSource() {
    const ds = collectDsProperties();
    const previewDiv = document.getElementById('ds-preview-result');
    previewDiv.innerHTML = '<div class="preview-loading">Loading preview...</div>';
    vscode.postMessage({ command: 'previewDataSource', dataSource: ds });
}

function renderPreviewResult(data) {
    const previewDiv = document.getElementById('ds-preview-result');
    if (!data || !data.headers || data.rows.length === 0) {
        previewDiv.innerHTML = '<div class="preview-error">No data returned.</div>';
        return;
    }
    let html = '<table class="preview-table"><thead><tr>';
    html += data.headers.map(h => '<th>' + esc(h) + '</th>').join('');
    html += '</tr></thead><tbody>';
    for (const row of data.rows) {
        html += '<tr>' + row.map(cell => '<td>' + esc(String(cell)) + '</td>').join('') + '</tr>';
    }
    html += '</tbody></table>';
    previewDiv.innerHTML = html;
}

function esc(str) { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Receive data from extension
window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.command === 'loadProperties') {
        properties = msg.properties;
        isConnected = msg.connected;
        const errBox = document.getElementById('jsonError');
        if (msg.parseError) {
            errBox.style.display = 'block';
            errBox.textContent = '⚠ The #JSON_PROPERTIES block is not valid JSON, so Parameters/Variables can\u2019t be read: ' + msg.parseError;
        } else {
            errBox.style.display = 'none';
        }
        document.getElementById('dsType').value = properties.DataSource?.Type || 'None';
        renderDsFields();
        renderParameters();
        renderVariables();
    } else if (msg.command === 'cubesList') {
        cachedCubes = msg.items;
        if (ssCube) ssCube.setItems(msg.items);
    } else if (msg.command === 'dimensionsList') {
        cachedDimensions = msg.items;
        if (ssDimension) ssDimension.setItems(msg.items);
    } else if (msg.command === 'viewsList') {
        if (ssView) ssView.setItems(msg.items);
    } else if (msg.command === 'subsetsList') {
        if (ssSubset) ssSubset.setItems(msg.items);
    } else if (msg.command === 'previewResult') {
        if (msg.error) {
            document.getElementById('ds-preview-result').innerHTML = '<div class="preview-error">' + esc(msg.error) + '</div>';
        } else {
            renderPreviewResult(msg.data);
        }
    } else if (msg.command === 'sqlFormatted') {
        const el = document.getElementById('ds-query');
        if (el) el.value = msg.sql;
    }
});

function formatSql() {
    const el = document.getElementById('ds-query');
    if (el) vscode.postMessage({ command: 'formatSql', sql: el.value });
}

vscode.postMessage({ command: 'ready' });
</script>
</body>
</html>`;
    }
}

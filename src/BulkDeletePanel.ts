import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class BulkDeletePanel {
    private static panels: Map<string, BulkDeletePanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;

    private constructor(panel: vscode.WebviewPanel, instanceName: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'init':
                    await this._sendInit();
                    return;
                case 'loadItems':
                    await this._loadItems(message.objectType, message.context);
                    return;
                case 'loadContexts':
                    await this._loadContexts(message.objectType);
                    return;
                case 'deleteItems':
                    await this._deleteItems(message.objectType, message.context, message.items);
                    return;
                case 'patternSearch':
                    await this._patternSearch(message.pattern);
                    return;
                case 'patternDelete':
                    await this._patternDelete(message.items);
                    return;
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string) {
        const existing = BulkDeletePanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1BulkDelete', `Bulk Delete - ${instanceName}`, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        BulkDeletePanel.panels.set(instanceName, new BulkDeletePanel(panel, instanceName));
    }

    private dispose() {
        BulkDeletePanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    /** Closes the Bulk Delete tab bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string) {
        const p = BulkDeletePanel.panels.get(instanceName);
        if (p) { p._panel.dispose(); }
    }

    private async _sendInit() {
        this._panel.webview.postMessage({ command: 'init', instanceName: this._instanceName });
    }

    private async _loadContexts(objectType: string) {
        const tm1 = TM1Service.getInstance();
        try {
            let contexts: string[] = [];
            if (objectType === 'views') {
                const cubes = await tm1.getCubes(this._instanceName, 'all');
                contexts = cubes.map((c: any) => c.Name).sort();
            } else if (objectType === 'subsets') {
                const dims = await tm1.getDimensionNames(this._instanceName);
                contexts = dims.sort();
            }
            this._panel.webview.postMessage({ command: 'contexts', contexts });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Failed to load contexts: ${err.message}` });
        }
    }

    private async _loadItems(objectType: string, context?: string) {
        const tm1 = TM1Service.getInstance();
        try {
            let items: string[] = [];
            if (objectType === 'processes') {
                const procs = await tm1.getProcesses(this._instanceName, 'all');
                items = procs.map((p: any) => p.Name).sort();
            } else if (objectType === 'chores') {
                const chores = await tm1.getChores(this._instanceName);
                items = chores.map((c: any) => c.Name).sort();
            } else if (objectType === 'cubes') {
                const cubes = await tm1.getCubes(this._instanceName, 'all');
                items = cubes.map((c: any) => c.Name).sort();
            } else if (objectType === 'dimensions') {
                const dims = await tm1.getDimensionNames(this._instanceName);
                items = dims.slice().sort();
            } else if (objectType === 'views' && context) {
                const views = await tm1.getViews(this._instanceName, context);
                items = views.map((v: any) => v.Name).sort();
            } else if (objectType === 'subsets' && context) {
                const subsets = await tm1.getSubsets(this._instanceName, context);
                items = subsets.map((s: any) => s.Name).sort();
            }
            this._panel.webview.postMessage({ command: 'items', items });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Failed to load items: ${err.message}` });
        }
    }

    private async _deleteItems(objectType: string, context: string | undefined, items: string[]) {
        const tm1 = TM1Service.getInstance();
        const results: { name: string; success: boolean; error?: string }[] = [];

        if (objectType === 'cubes' || objectType === 'dimensions') {
            const ans = await vscode.window.showWarningMessage(
                `Delete ${items.length} ${objectType}? This is irreversible and will fail for objects still referenced by other objects.`,
                { modal: true }, 'Delete');
            if (ans !== 'Delete') { this._panel.webview.postMessage({ command: 'deleteResults', results: [] }); return; }
        }

        for (const item of items) {
            try {
                if (objectType === 'processes') {
                    await tm1.deleteProcess(this._instanceName, item);
                } else if (objectType === 'chores') {
                    await tm1.deleteChore(this._instanceName, item);
                } else if (objectType === 'cubes') {
                    await tm1.deleteCube(this._instanceName, item);
                } else if (objectType === 'dimensions') {
                    await tm1.deleteDimension(this._instanceName, item);
                } else if (objectType === 'views' && context) {
                    await tm1.deleteView(this._instanceName, context, item);
                } else if (objectType === 'subsets' && context) {
                    await tm1.deleteSubset(this._instanceName, context, item);
                }
                results.push({ name: item, success: true });
            } catch (err: any) {
                results.push({ name: item, success: false, error: err.message });
            }
        }

        this._panel.webview.postMessage({ command: 'deleteResults', results });
    }

    private async _patternSearch(pattern: string) {
        const tm1 = TM1Service.getInstance();
        const results: { type: string; context: string; name: string }[] = [];
        try {
            // Fetch cubes and dimensions in parallel
            const [cubes, dims] = await Promise.all([
                tm1.getCubes(this._instanceName, 'all'),
                tm1.getDimensionNames(this._instanceName)
            ]);

            // Search views across all cubes — batch 10 at a time
            for (let i = 0; i < cubes.length; i += 10) {
                const batch = cubes.slice(i, i + 10);
                const batchResults = await Promise.all(batch.map(async (cube) => {
                    try {
                        const views = await tm1.getViews(this._instanceName, cube.Name);
                        return views.filter(v => this._matchesPattern(v.Name, pattern)).map(v => ({ type: 'view', context: cube.Name, name: v.Name }));
                    } catch { return []; }
                }));
                for (const r of batchResults) results.push(...r);
            }

            // Search subsets across all dimensions — batch 10 at a time
            for (let i = 0; i < dims.length; i += 10) {
                const batch = dims.slice(i, i + 10);
                const batchResults = await Promise.all(batch.map(async (dim) => {
                    try {
                        const subsets = await tm1.getSubsets(this._instanceName, dim);
                        return subsets.filter(s => this._matchesPattern(s.Name, pattern)).map(s => ({ type: 'subset', context: dim, name: s.Name }));
                    } catch { return []; }
                }));
                for (const r of batchResults) results.push(...r);
            }

            this._panel.webview.postMessage({ command: 'patternResults', results });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Pattern search failed: ${err.message}` });
        }
    }

    private _matchesPattern(name: string, pattern: string): boolean {
        // Convert wildcard pattern (with *) to regex
        const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
        return new RegExp(`^${escaped}$`, 'i').test(name);
    }

    private async _patternDelete(items: { type: string; context: string; name: string }[]) {
        const tm1 = TM1Service.getInstance();
        const results: { type: string; context: string; name: string; success: boolean; error?: string }[] = [];

        // Delete views first, then subsets (views may reference subsets)
        const views = items.filter(i => i.type === 'view');
        const subsets = items.filter(i => i.type === 'subset');

        for (const item of [...views, ...subsets]) {
            try {
                if (item.type === 'view') {
                    await tm1.deleteView(this._instanceName, item.context, item.name);
                } else {
                    await tm1.deleteSubset(this._instanceName, item.context, item.name);
                }
                results.push({ ...item, success: true });
            } catch (err: any) {
                results.push({ ...item, success: false, error: err.message });
            }
        }

        this._panel.webview.postMessage({ command: 'patternDeleteResults', results });
    }

    private _getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; margin: 0; }
    h2 { margin-top: 0; font-weight: 400; }
    .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
    select, input[type="text"] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #444); padding: 6px 10px; border-radius: 3px; font-size: 13px;
    }
    select { min-width: 160px; }
    input[type="text"] { min-width: 200px; }
    .btn {
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: 13px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-danger { background: #c42b1c; color: #fff; }
    .btn-danger:hover { background: #e03e2d; }
    .btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, #333); font-size: 13px; }
    th { position: sticky; top: 0; background: var(--vscode-editor-background); font-weight: 600; cursor: pointer; user-select: none; }
    th:hover { color: var(--vscode-textLink-foreground); }
    tr:hover { background: var(--vscode-list-hoverBackground); }
    .table-container { max-height: 60vh; overflow-y: auto; border: 1px solid var(--vscode-panel-border, #333); border-radius: 3px; }
    .status-bar { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .badge-ok { color: #3fb950; }
    .badge-fail { color: #f85149; }
    .loading { color: var(--vscode-descriptionForeground); font-style: italic; padding: 20px; }
    .checkbox-col { width: 30px; text-align: center; }
    .result-row { padding: 4px 0; font-size: 13px; }
</style>
</head>
<body>
<h2>Bulk Delete — <span id="instanceLabel"></span></h2>

<div style="display:flex;gap:8px;margin-bottom:16px;">
    <button class="btn" id="tabStandard" onclick="switchMode('standard')" style="opacity:1;">Standard</button>
    <button class="btn" id="tabPattern" onclick="switchMode('pattern')" style="opacity:0.6;">Global Pattern Search</button>
</div>

<div id="standardMode">
<div class="toolbar">
    <label>Object Type:</label>
    <select id="objectType" onchange="onObjectTypeChange()">
        <option value="">— Select —</option>
        <option value="processes">Processes</option>
        <option value="chores">Chores</option>
        <option value="cubes">Cubes</option>
        <option value="dimensions">Dimensions</option>
        <option value="views">Views</option>
        <option value="subsets">Subsets</option>
    </select>

    <span id="contextGroup" style="display:none;">
        <label id="contextLabel">Cube:</label>
        <select id="contextSelect" onchange="onContextChange()">
            <option value="">— Select —</option>
        </select>
    </span>
</div>

<div class="toolbar">
    <input type="text" id="searchBox" placeholder="Search..." oninput="filterItems()" />
    <label style="font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;"><input type="checkbox" id="showControl" onchange="filterItems()"> Show control objects (}-prefixed)</label>
    <span id="itemCount" style="font-size:12px;color:var(--vscode-descriptionForeground);"></span>
</div>

<div class="table-container" id="tableContainer" style="display:none;">
    <table>
        <thead>
            <tr>
                <th class="checkbox-col"><input type="checkbox" id="selectAll" onchange="toggleSelectAll()" /></th>
                <th onclick="sortItems()">Name <span id="sortIndicator">▲</span></th>
            </tr>
        </thead>
        <tbody id="itemsBody"></tbody>
    </table>
</div>

<div class="status-bar" id="statusBar" style="display:none;">
    <span><span id="selectedCount">0</span> selected</span>
    <button class="btn btn-danger" id="btnDelete" disabled onclick="doDelete()">Delete Selected</button>
</div>
</div>

<div id="patternMode" style="display:none;">
<div class="toolbar">
    <label>Name Pattern:</label>
    <input type="text" id="patternInput" placeholder="e.g. MyProcess_*  or  *_2024*" style="min-width:300px;" />
    <button class="btn" id="btnPatternSearch" onclick="doPatternSearch()">Search All Cubes & Dimensions</button>
</div>
<p style="font-size:12px;color:var(--vscode-descriptionForeground);margin:4px 0 12px 0;">
    Searches views across all cubes and subsets across all dimensions. Use * as wildcard. Deletes views first, then subsets.
</p>

<div class="table-container" id="patternTableContainer" style="display:none;">
    <table>
        <thead>
            <tr>
                <th class="checkbox-col"><input type="checkbox" id="patternSelectAll" onchange="togglePatternSelectAll()" /></th>
                <th onclick="sortPatternItems('type')">Type <span id="psort_type"></span></th>
                <th onclick="sortPatternItems('context')">Context <span id="psort_context"></span></th>
                <th onclick="sortPatternItems('name')">Name <span id="psort_name"></span></th>
            </tr>
        </thead>
        <tbody id="patternBody"></tbody>
    </table>
</div>

<div class="status-bar" id="patternStatusBar" style="display:none;">
    <span><span id="patternSelectedCount">0</span> selected (<span id="patternViewCount">0</span> views, <span id="patternSubsetCount">0</span> subsets)</span>
    <button class="btn btn-danger" id="btnPatternDelete" disabled onclick="doPatternDelete()">Delete Selected</button>
</div>
</div>

<div id="loadingMsg" class="loading" style="display:none;">Loading...</div>
<div id="resultsDiv" style="display:none; margin-top: 16px;"></div>

<script>
    const vscode = acquireVsCodeApi();
    let allItems = [];
    let filteredItems = [];
    let selectedSet = new Set();
    let sortAsc = true;
    let currentObjectType = '';
    let currentContext = '';

    vscode.postMessage({ command: 'init' });

    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'init':
                document.getElementById('instanceLabel').textContent = msg.instanceName;
                break;
            case 'contexts':
                populateContexts(msg.contexts);
                break;
            case 'items':
                allItems = msg.items;
                selectedSet.clear();
                sortAsc = true;
                document.getElementById('searchBox').value = '';
                filterItems();
                document.getElementById('tableContainer').style.display = '';
                document.getElementById('statusBar').style.display = '';
                document.getElementById('loadingMsg').style.display = 'none';
                document.getElementById('resultsDiv').style.display = 'none';
                break;
            case 'deleteResults':
                showResults(msg.results);
                break;
            case 'error':
                document.getElementById('loadingMsg').textContent = msg.message;
                break;
        }
    });

    function onObjectTypeChange() {
        currentObjectType = document.getElementById('objectType').value;
        currentContext = '';
        document.getElementById('tableContainer').style.display = 'none';
        document.getElementById('statusBar').style.display = 'none';
        document.getElementById('resultsDiv').style.display = 'none';
        allItems = [];
        selectedSet.clear();

        if (currentObjectType === 'views' || currentObjectType === 'subsets') {
            document.getElementById('contextGroup').style.display = '';
            document.getElementById('contextLabel').textContent = currentObjectType === 'views' ? 'Cube:' : 'Dimension:';
            document.getElementById('contextSelect').innerHTML = '<option value="">— Loading... —</option>';
            vscode.postMessage({ command: 'loadContexts', objectType: currentObjectType });
        } else if (currentObjectType === 'processes' || currentObjectType === 'chores' || currentObjectType === 'cubes' || currentObjectType === 'dimensions') {
            document.getElementById('contextGroup').style.display = 'none';
            document.getElementById('loadingMsg').style.display = '';
            document.getElementById('loadingMsg').textContent = 'Loading...';
            vscode.postMessage({ command: 'loadItems', objectType: currentObjectType });
        } else {
            document.getElementById('contextGroup').style.display = 'none';
        }
    }

    function populateContexts(contexts) {
        const sel = document.getElementById('contextSelect');
        sel.innerHTML = '<option value="">— Select —</option>' + contexts.map(c =>
            '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'
        ).join('');
    }

    function onContextChange() {
        currentContext = document.getElementById('contextSelect').value;
        if (!currentContext) return;
        document.getElementById('loadingMsg').style.display = '';
        document.getElementById('loadingMsg').textContent = 'Loading...';
        document.getElementById('tableContainer').style.display = 'none';
        vscode.postMessage({ command: 'loadItems', objectType: currentObjectType, context: currentContext });
    }

    function filterItems() {
        const q = document.getElementById('searchBox').value.toLowerCase();
        const showControl = document.getElementById('showControl').checked;
        let base = showControl ? allItems : allItems.filter(n => n.charAt(0) !== '}');
        filteredItems = q ? base.filter(n => n.toLowerCase().includes(q)) : [...base];
        if (!sortAsc) filteredItems.reverse();
        renderItems();
    }

    function sortItems() {
        sortAsc = !sortAsc;
        document.getElementById('sortIndicator').textContent = sortAsc ? '▲' : '▼';
        filterItems();
    }

    function renderItems() {
        const tbody = document.getElementById('itemsBody');
        tbody.innerHTML = filteredItems.map(name => {
            const checked = selectedSet.has(name) ? 'checked' : '';
            return '<tr><td class="checkbox-col"><input type="checkbox" ' + checked + ' onchange="toggleItem(\\'' + escapeJs(name) + '\\', this.checked)" /></td><td>' + escapeHtml(name) + '</td></tr>';
        }).join('');
        updateCounts();
    }

    function toggleItem(name, checked) {
        if (checked) selectedSet.add(name); else selectedSet.delete(name);
        updateCounts();
    }

    function toggleSelectAll() {
        const checked = document.getElementById('selectAll').checked;
        if (checked) {
            filteredItems.forEach(n => selectedSet.add(n));
        } else {
            filteredItems.forEach(n => selectedSet.delete(n));
        }
        renderItems();
    }

    function updateCounts() {
        document.getElementById('selectedCount').textContent = selectedSet.size;
        document.getElementById('btnDelete').disabled = selectedSet.size === 0;
        document.getElementById('itemCount').textContent = filteredItems.length + ' of ' + allItems.length + ' items';
        document.getElementById('selectAll').checked = filteredItems.length > 0 && filteredItems.every(n => selectedSet.has(n));
    }

    function doDelete() {
        const items = Array.from(selectedSet);
        if (items.length === 0) return;
        document.getElementById('btnDelete').disabled = true;
        document.getElementById('btnDelete').textContent = 'Deleting...';
        vscode.postMessage({ command: 'deleteItems', objectType: currentObjectType, context: currentContext || undefined, items });
    }

    function showResults(results) {
        const ok = results.filter(r => r.success).length;
        const fail = results.filter(r => !r.success).length;
        let html = '<h3>Results: <span class="badge-ok">' + ok + ' deleted</span>';
        if (fail > 0) html += ', <span class="badge-fail">' + fail + ' failed</span>';
        html += '</h3>';
        if (fail > 0) {
            html += '<div>' + results.filter(r => !r.success).map(r =>
                '<div class="result-row"><span class="badge-fail">✗</span> ' + escapeHtml(r.name) + ': ' + escapeHtml(r.error || 'Unknown error') + '</div>'
            ).join('') + '</div>';
        }
        document.getElementById('resultsDiv').innerHTML = html;
        document.getElementById('resultsDiv').style.display = '';
        document.getElementById('btnDelete').textContent = 'Delete Selected';
        // Remove deleted items from list
        const deleted = new Set(results.filter(r => r.success).map(r => r.name));
        allItems = allItems.filter(n => !deleted.has(n));
        deleted.forEach(n => selectedSet.delete(n));
        filterItems();
    }

    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escapeJs(s) { return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }

    // ── MODE SWITCHING ──
    function switchMode(mode) {
        document.getElementById('standardMode').style.display = mode === 'standard' ? '' : 'none';
        document.getElementById('patternMode').style.display = mode === 'pattern' ? '' : 'none';
        document.getElementById('tabStandard').style.opacity = mode === 'standard' ? '1' : '0.6';
        document.getElementById('tabPattern').style.opacity = mode === 'pattern' ? '1' : '0.6';
        document.getElementById('resultsDiv').style.display = 'none';
    }

    // ── GLOBAL PATTERN SEARCH ──
    let patternResults = [];
    let patternFiltered = [];
    let patternSelected = new Set();
    let patternSortCol = 'type';
    let patternSortAsc = true;

    window.addEventListener('message', function(event) {
        // Handle pattern-specific messages (runs after the main handler)
        const msg = event.data;
        if (msg.command === 'patternResults') {
            patternResults = msg.results;
            patternSelected.clear();
            patternFiltered = [...patternResults];
            renderPatternItems();
            document.getElementById('patternTableContainer').style.display = '';
            document.getElementById('patternStatusBar').style.display = '';
            document.getElementById('loadingMsg').style.display = 'none';
            document.getElementById('btnPatternSearch').textContent = 'Search All Cubes & Dimensions';
            document.getElementById('btnPatternSearch').disabled = false;
        } else if (msg.command === 'patternDeleteResults') {
            const ok = msg.results.filter(r => r.success).length;
            const fail = msg.results.filter(r => !r.success).length;
            let html = '<h3>Results: <span class="badge-ok">' + ok + ' deleted</span>';
            if (fail > 0) html += ', <span class="badge-fail">' + fail + ' failed</span>';
            html += '</h3>';
            if (fail > 0) {
                html += '<div>' + msg.results.filter(r => !r.success).map(r =>
                    '<div class="result-row"><span class="badge-fail">\\u2717</span> ' + escapeHtml(r.type) + ' ' + escapeHtml(r.context) + '/' + escapeHtml(r.name) + ': ' + escapeHtml(r.error || 'Unknown') + '</div>'
                ).join('') + '</div>';
            }
            document.getElementById('resultsDiv').innerHTML = html;
            document.getElementById('resultsDiv').style.display = '';
            document.getElementById('btnPatternDelete').textContent = 'Delete Selected';
            document.getElementById('btnPatternDelete').disabled = false;
            // Remove deleted items
            const deletedKeys = new Set(msg.results.filter(r => r.success).map(r => r.type + '|' + r.context + '|' + r.name));
            patternResults = patternResults.filter(r => !deletedKeys.has(r.type + '|' + r.context + '|' + r.name));
            patternFiltered = [...patternResults];
            patternSelected.clear();
            renderPatternItems();
        }
    });

    function doPatternSearch() {
        const pattern = document.getElementById('patternInput').value.trim();
        if (!pattern) return;
        document.getElementById('loadingMsg').style.display = '';
        document.getElementById('loadingMsg').textContent = 'Searching across all cubes and dimensions...';
        document.getElementById('patternTableContainer').style.display = 'none';
        document.getElementById('patternStatusBar').style.display = 'none';
        document.getElementById('resultsDiv').style.display = 'none';
        document.getElementById('btnPatternSearch').textContent = 'Searching...';
        document.getElementById('btnPatternSearch').disabled = true;
        vscode.postMessage({ command: 'patternSearch', pattern });
    }

    function renderPatternItems() {
        const tbody = document.getElementById('patternBody');
        if (patternFiltered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--vscode-descriptionForeground);padding:20px;">No matches found.</td></tr>';
            updatePatternCounts();
            return;
        }
        tbody.innerHTML = patternFiltered.map((r, i) => {
            const key = r.type + '|' + r.context + '|' + r.name;
            const checked = patternSelected.has(key) ? 'checked' : '';
            const typeLabel = r.type === 'view' ? '<span style="color:#58a6ff;">View</span>' : '<span style="color:#f0883e;">Subset</span>';
            return '<tr><td class="checkbox-col"><input type="checkbox" ' + checked + ' onchange="togglePatternItem(' + i + ', this.checked)" /></td><td>' + typeLabel + '</td><td>' + escapeHtml(r.context) + '</td><td>' + escapeHtml(r.name) + '</td></tr>';
        }).join('');
        updatePatternCounts();
    }

    function togglePatternItem(idx, checked) {
        const r = patternFiltered[idx];
        const key = r.type + '|' + r.context + '|' + r.name;
        if (checked) patternSelected.add(key); else patternSelected.delete(key);
        updatePatternCounts();
    }

    function togglePatternSelectAll() {
        const checked = document.getElementById('patternSelectAll').checked;
        patternFiltered.forEach(r => {
            const key = r.type + '|' + r.context + '|' + r.name;
            if (checked) patternSelected.add(key); else patternSelected.delete(key);
        });
        renderPatternItems();
    }

    function sortPatternItems(col) {
        if (patternSortCol === col) patternSortAsc = !patternSortAsc;
        else { patternSortCol = col; patternSortAsc = true; }
        patternFiltered.sort((a, b) => {
            const va = a[col] || '';
            const vb = b[col] || '';
            return va.localeCompare(vb) * (patternSortAsc ? 1 : -1);
        });
        document.querySelectorAll('[id^="psort_"]').forEach(el => el.textContent = '');
        const arrow = document.getElementById('psort_' + col);
        if (arrow) arrow.textContent = patternSortAsc ? ' \\u25B2' : ' \\u25BC';
        renderPatternItems();
    }

    function updatePatternCounts() {
        const selArr = [...patternSelected];
        document.getElementById('patternSelectedCount').textContent = selArr.length;
        const viewCount = selArr.filter(k => k.startsWith('view|')).length;
        const subsetCount = selArr.filter(k => k.startsWith('subset|')).length;
        document.getElementById('patternViewCount').textContent = viewCount;
        document.getElementById('patternSubsetCount').textContent = subsetCount;
        document.getElementById('btnPatternDelete').disabled = selArr.length === 0;
        document.getElementById('patternSelectAll').checked = patternFiltered.length > 0 && patternFiltered.every(r => patternSelected.has(r.type + '|' + r.context + '|' + r.name));
    }

    function doPatternDelete() {
        const items = patternFiltered.filter(r => patternSelected.has(r.type + '|' + r.context + '|' + r.name));
        if (items.length === 0) return;
        document.getElementById('btnPatternDelete').disabled = true;
        document.getElementById('btnPatternDelete').textContent = 'Deleting...';
        vscode.postMessage({ command: 'patternDelete', items });
    }
</script>
</body>
</html>`;
    }
}

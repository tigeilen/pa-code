import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class ConfigurationPanel {
    private static panels: Map<string, ConfigurationPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private readonly _serverRealName: string;

    private constructor(panel: vscode.WebviewPanel, instanceName: string, serverRealName: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._serverRealName = serverRealName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'loadConfig':
                        await this._sendConfigToWebview();
                        return;
                    case 'updateParam':
                        await this._updateParameter(message.section, message.name, message.value);
                        return;
                }
            },
            null,
            this._disposables
        );

        this._sendConfigToWebview();
    }

    public static async render(instanceName: string, serverRealName: string) {
        const columnToShowIn = vscode.ViewColumn.One;

        const existing = ConfigurationPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(columnToShowIn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tm1Configuration',
            `TM1 Configuration: ${serverRealName}`,
            columnToShowIn,
            { enableScripts: true }
        );

        ConfigurationPanel.panels.set(instanceName, new ConfigurationPanel(panel, instanceName, serverRealName));
    }

    private async _sendConfigToWebview() {
        try {
            const config = await TM1Service.getInstance().getStaticConfiguration(this._instanceName);
            // Remove OData metadata keys
            const cleaned: Record<string, any> = {};
            for (const [key, value] of Object.entries(config)) {
                if (!key.startsWith('@odata') && !key.startsWith('odata')) {
                    cleaned[key] = value;
                }
            }
            this._panel.webview.postMessage({ command: 'loadConfig', config: cleaned, serverName: this._serverRealName });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load configuration: ${err.message}`);
        }
    }

    private async _updateParameter(section: string, name: string, value: any) {
        try {
            await TM1Service.getInstance().updateConfigurationParameterByName(this._instanceName, name, value, section);
            vscode.window.showInformationMessage(`${this._serverRealName}: '${name}' updated successfully.`);
            // Refresh the view
            await this._sendConfigToWebview();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to update '${name}': ${err.message}`);
        }
    }

    public dispose() {
        ConfigurationPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TM1 Configuration</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            margin: 0;
        }
        h2 {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
            margin-top: 0;
        }
        .toolbar {
            display: flex;
            gap: 10px;
            margin-bottom: 16px;
            align-items: center;
        }
        .toolbar input[type="text"] {
            flex: 1;
            padding: 6px 10px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-size: 13px;
        }
        .toolbar button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 13px;
            border-radius: 2px;
        }
        .toolbar button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .badge {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 8px;
            margin-left: 6px;
        }
        .badge-bool { background: #2d6b3f; color: #fff; }
        .badge-num { background: #5b5fc7; color: #fff; }
        .badge-str { background: #7a5c1e; color: #fff; }
        table {
            width: 100%;
            border-collapse: collapse;
        }
        th, td {
            text-align: left;
            padding: 8px 12px;
            border-bottom: 1px solid var(--vscode-panel-border);
            font-size: 13px;
        }
        th {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            position: sticky;
            top: 0;
            z-index: 1;
        }
        tr:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .param-name {
            font-family: var(--vscode-editor-font-family), monospace;
            font-weight: 600;
        }
        .value-cell {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .value-display {
            flex: 1;
            word-break: break-all;
        }
        .edit-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none;
            padding: 3px 8px;
            cursor: pointer;
            font-size: 12px;
            border-radius: 2px;
            white-space: nowrap;
        }
        .edit-btn:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .modal {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.5);
            z-index: 1000;
        }
        .modal-content {
            background-color: var(--vscode-editor-background);
            margin: 15% auto;
            padding: 20px;
            border: 1px solid var(--vscode-panel-border);
            width: 450px;
            border-radius: 4px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .modal-content h3 { margin-top: 0; }
        .modal-content .form-group {
            margin-bottom: 15px;
        }
        .modal-content label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        .modal-content input[type="text"],
        .modal-content input[type="number"],
        .modal-content select {
            width: 100%;
            padding: 8px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            font-size: 13px;
        }
        .modal-content .current-value {
            font-size: 12px;
            opacity: 0.7;
            margin-bottom: 8px;
        }
        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 20px;
        }
        .form-actions button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            border-radius: 2px;
        }
        .form-actions button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .form-actions button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .form-actions button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .count {
            font-size: 12px;
            opacity: 0.7;
            margin-bottom: 8px;
        }
    </style>
</head>
<body>
    <h2 id="title">TM1 Server Configuration</h2>

    <div class="toolbar">
        <input type="text" id="searchInput" placeholder="Filter parameters..." oninput="filterParams()">
        <button onclick="refreshConfig()">&#x21bb; Refresh</button>
    </div>
    <div class="count" id="paramCount"></div>

    <table>
        <thead>
            <tr>
                <th>Parameter</th>
                <th>Value</th>
                <th>Type</th>
                <th></th>
            </tr>
        </thead>
        <tbody id="configBody"></tbody>
    </table>

    <!-- Edit Modal -->
    <div id="editModal" class="modal">
        <div class="modal-content">
            <h3>Edit Parameter</h3>
            <div class="form-group">
                <label id="editParamName"></label>
                <div class="current-value" id="editCurrentValue"></div>
                <div id="editControl"></div>
            </div>
            <div class="form-actions">
                <button class="secondary" onclick="closeModal()">Cancel</button>
                <button onclick="saveParam()">Save</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let allConfig = {};
        let flatParams = []; // { section, name, value }
        let currentEditParam = null;

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'loadConfig') {
                allConfig = msg.config;
                flatParams = [];
                // Flatten nested config: sections contain objects with key-value pairs
                for (const [sectionKey, sectionVal] of Object.entries(allConfig)) {
                    if (sectionVal && typeof sectionVal === 'object' && !Array.isArray(sectionVal)) {
                        for (const [paramKey, paramVal] of Object.entries(sectionVal)) {
                            if (paramKey.startsWith('@odata') || paramKey.startsWith('odata')) continue;
                            if (paramVal && typeof paramVal === 'object' && !Array.isArray(paramVal)) {
                                // Sub-section (e.g., Administration.AuditLog)
                                for (const [subKey, subVal] of Object.entries(paramVal)) {
                                    if (subKey.startsWith('@odata') || subKey.startsWith('odata')) continue;
                                    flatParams.push({ section: sectionKey, name: paramKey + '.' + subKey, value: subVal });
                                }
                            } else {
                                flatParams.push({ section: sectionKey, name: paramKey, value: paramVal });
                            }
                        }
                    }
                }
                document.getElementById('title').textContent = 'TM1 Configuration: ' + (msg.serverName || '');
                renderParams();
            }
        });

        function renderParams() {
            const tbody = document.getElementById('configBody');
            const filter = (document.getElementById('searchInput').value || '').toLowerCase();

            const filtered = flatParams
                .filter(p => !filter || p.name.toLowerCase().includes(filter) || p.section.toLowerCase().includes(filter))
                .sort((a, b) => a.name.localeCompare(b.name));

            document.getElementById('paramCount').textContent = filtered.length + ' of ' + flatParams.length + ' parameters';

            tbody.innerHTML = filtered.map((p, idx) => {
                const typeStr = getTypeBadge(p.value);
                const displayValue = formatValue(p.value);
                return '<tr>' +
                    '<td class="param-name">' + escapeHtml(p.name) + '</td>' +
                    '<td><div class="value-display">' + escapeHtml(displayValue) + '</div></td>' +
                    '<td>' + typeStr + '</td>' +
                    '<td><button class="edit-btn" onclick="editParam(' + idx + ')">Edit</button></td>' +
                    '</tr>';
            }).join('');

            // Store filtered list for edit reference
            window._filteredParams = filtered;
        }

        function getTypeBadge(value) {
            if (typeof value === 'boolean') return '<span class="badge badge-bool">bool</span>';
            if (typeof value === 'number') return '<span class="badge badge-num">number</span>';
            return '<span class="badge badge-str">string</span>';
        }

        function formatValue(value) {
            if (typeof value === 'boolean') return value ? 'true' : 'false';
            if (value === null || value === undefined) return '';
            return String(value);
        }

        function filterParams() {
            renderParams();
        }

        function refreshConfig() {
            vscode.postMessage({ command: 'loadConfig' });
        }

        function editParam(filteredIdx) {
            const p = window._filteredParams[filteredIdx];
            if (!p) return;
            currentEditParam = p;
            document.getElementById('editParamName').textContent = p.name;
            document.getElementById('editCurrentValue').textContent = 'Section: ' + p.section + '  |  Current value: ' + formatValue(p.value);

            const controlDiv = document.getElementById('editControl');
            const value = p.value;

            if (typeof value === 'boolean') {
                controlDiv.innerHTML = '<select id="editValue">' +
                    '<option value="true"' + (value ? ' selected' : '') + '>true</option>' +
                    '<option value="false"' + (!value ? ' selected' : '') + '>false</option>' +
                    '</select>';
            } else if (typeof value === 'number') {
                controlDiv.innerHTML = '<input type="number" id="editValue" value="' + value + '">';
            } else {
                controlDiv.innerHTML = '<input type="text" id="editValue" value="' + escapeAttr(String(value || '')) + '">';
            }

            document.getElementById('editModal').style.display = 'block';
        }

        function closeModal() {
            document.getElementById('editModal').style.display = 'none';
            currentEditParam = null;
        }

        function saveParam() {
            if (!currentEditParam) return;
            const inputEl = document.getElementById('editValue');
            const origValue = currentEditParam.value;
            let newValue;

            if (typeof origValue === 'boolean') {
                newValue = inputEl.value === 'true';
            } else if (typeof origValue === 'number') {
                newValue = Number(inputEl.value);
            } else {
                newValue = inputEl.value;
            }

            vscode.postMessage({ command: 'updateParam', section: currentEditParam.section, name: currentEditParam.name, value: newValue });
            closeModal();
        }

        function escapeHtml(str) {
            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        function escapeAttr(str) {
            return String(str).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'&quot;');
        }

        // Initial load
        vscode.postMessage({ command: 'loadConfig' });
    </script>
</body>
</html>`;
    }
}

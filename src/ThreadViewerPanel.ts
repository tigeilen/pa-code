import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class ThreadViewerPanel {
    private static panels: Map<string, ThreadViewerPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private readonly _serverRealName: string;
    private _refreshInterval: ReturnType<typeof setInterval> | undefined;

    private constructor(panel: vscode.WebviewPanel, instanceName: string, serverRealName: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._serverRealName = serverRealName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'loadThreads':
                        await this._sendThreadsToWebview();
                        return;
                    case 'cancelThread':
                        await this._cancelThread(message.threadId);
                        return;
                }
            },
            null,
            this._disposables
        );

        this._sendThreadsToWebview();

        // Auto-refresh every 3 seconds
        this._refreshInterval = setInterval(() => {
            if (this._panel.visible) {
                this._sendThreadsToWebview();
            }
        }, 3000);
    }

    public static async render(instanceName: string, serverRealName: string) {
        const columnToShowIn = vscode.ViewColumn.One;

        const existing = ThreadViewerPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(columnToShowIn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tm1ThreadViewer',
            `TM1 Threads: ${serverRealName}`,
            columnToShowIn,
            { enableScripts: true }
        );

        ThreadViewerPanel.panels.set(instanceName, new ThreadViewerPanel(panel, instanceName, serverRealName));
    }

    private async _sendThreadsToWebview() {
        try {
            const threads = await TM1Service.getInstance().getThreads(this._instanceName);
            this._panel.webview.postMessage({ command: 'loadThreads', threads, serverName: this._serverRealName });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _cancelThread(threadId: string | number) {
        try {
            await TM1Service.getInstance().cancelThread(this._instanceName, threadId);
            vscode.window.showInformationMessage(`Thread ${threadId} cancelled successfully.`);
            await this._sendThreadsToWebview();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to cancel thread ${threadId}: ${err.message}`);
        }
    }

    public dispose() {
        ThreadViewerPanel.panels.delete(this._instanceName);
        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
        }
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
    <title>TM1 Thread Viewer</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 16px;
            margin: 0;
        }
        .header {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 16px;
            flex-wrap: wrap;
        }
        .header h2 {
            margin: 0;
            flex-shrink: 0;
        }
        .search-box {
            display: flex;
            align-items: center;
            gap: 8px;
            flex: 1;
        }
        .search-box input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
            padding: 5px 10px;
            border-radius: 3px;
            font-size: var(--vscode-font-size);
            width: 250px;
        }
        .search-box input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .kill-section {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .kill-section input {
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent));
            padding: 5px 10px;
            border-radius: 3px;
            font-size: var(--vscode-font-size);
            width: 100px;
        }
        .kill-section input:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .btn-kill {
            background: var(--vscode-errorForeground, #f44747);
            color: #fff;
            border: none;
            padding: 5px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: var(--vscode-font-size);
            font-weight: bold;
        }
        .btn-kill:hover {
            opacity: 0.85;
        }
        .btn-kill:disabled {
            opacity: 0.4;
            cursor: not-allowed;
        }
        .status-bar {
            display: flex;
            align-items: center;
            gap: 16px;
            margin-bottom: 8px;
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        thead {
            position: sticky;
            top: 0;
            z-index: 1;
        }
        th {
            background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
            color: var(--vscode-foreground);
            text-align: left;
            padding: 8px 10px;
            border-bottom: 1px solid var(--vscode-widget-border, #444);
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
        }
        th:hover {
            background: var(--vscode-list-hoverBackground);
        }
        th .sort-arrow {
            margin-left: 4px;
            font-size: 10px;
        }
        td {
            padding: 6px 10px;
            border-bottom: 1px solid var(--vscode-widget-border, #333);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 250px;
        }
        tr:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .state-run {
            color: var(--vscode-charts-green, #89d185);
            font-weight: bold;
        }
        .state-idle {
            color: var(--vscode-descriptionForeground);
        }
        .state-wait {
            color: var(--vscode-charts-yellow, #cca700);
            font-weight: bold;
        }
        .type-system {
            color: var(--vscode-charts-blue, #4fc1ff);
        }
        .btn-row-kill {
            background: transparent;
            color: var(--vscode-errorForeground, #f44747);
            border: 1px solid var(--vscode-errorForeground, #f44747);
            padding: 2px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            font-weight: bold;
        }
        .btn-row-kill:hover {
            background: var(--vscode-errorForeground, #f44747);
            color: #fff;
        }
        .refresh-indicator {
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--vscode-charts-green, #89d185);
            margin-right: 6px;
            animation: pulse 3s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
        }
        .empty-state {
            text-align: center;
            padding: 40px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <div class="header">
        <h2 id="title">TM1 Threads</h2>
        <div class="search-box">
            <span>&#128269;</span>
            <input type="text" id="searchInput" placeholder="Search threads..." oninput="renderThreads()" />
        </div>
        <div class="kill-section">
            <input type="text" id="killThreadId" placeholder="Thread ID" />
            <button class="btn-kill" onclick="killThreadById()">&#10005; Kill Thread</button>
        </div>
    </div>
    <div class="status-bar">
        <span><span class="refresh-indicator"></span>Auto-refresh: 3s</span>
        <span id="threadCount"></span>
    </div>
    <table>
        <thead>
            <tr>
                <th onclick="sortBy('ID')">ID <span class="sort-arrow" id="sort-ID"></span></th>
                <th onclick="sortBy('Name')">Name <span class="sort-arrow" id="sort-Name"></span></th>
                <th onclick="sortBy('State')">State <span class="sort-arrow" id="sort-State"></span></th>
                <th onclick="sortBy('Type')">Type <span class="sort-arrow" id="sort-Type"></span></th>
                <th onclick="sortBy('Function')">Function <span class="sort-arrow" id="sort-Function"></span></th>
                <th onclick="sortBy('WaitTime')">Wait (sec.)</th>
                <th onclick="sortBy('ElapsedTime')">Elapsed (sec.) <span class="sort-arrow" id="sort-ElapsedTime"></span></th>
                <th>W/R/Ix locks</th>
                <th onclick="sortBy('Context')">Context <span class="sort-arrow" id="sort-Context"></span></th>
                <th onclick="sortBy('Info')">Info <span class="sort-arrow" id="sort-Info"></span></th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody id="threadBody"></tbody>
    </table>
    <div id="emptyState" class="empty-state" style="display:none;">No threads found.</div>

    <script>
        const vscode = acquireVsCodeApi();
        let allThreads = [];
        let sortColumn = 'ID';
        let sortDirection = 'asc';

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.command === 'loadThreads') {
                allThreads = msg.threads || [];
                document.getElementById('title').textContent = 'TM1 Threads: ' + (msg.serverName || '');
                renderThreads();
            } else if (msg.command === 'error') {
                document.getElementById('threadBody').innerHTML = '<tr><td colspan="11" style="color:var(--vscode-errorForeground);">' + escapeHtml(msg.message) + '</td></tr>';
            }
        });

        function sortBy(col) {
            if (sortColumn === col) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                sortColumn = col;
                sortDirection = 'asc';
            }
            // Update sort arrows
            document.querySelectorAll('.sort-arrow').forEach(el => el.textContent = '');
            const arrow = document.getElementById('sort-' + col);
            if (arrow) arrow.textContent = sortDirection === 'asc' ? '\\u25B2' : '\\u25BC';
            renderThreads();
        }

        function renderThreads() {
            const filter = (document.getElementById('searchInput').value || '').toLowerCase();
            let filtered = allThreads.filter(t => {
                if (!filter) return true;
                return (String(t.ID || '')).includes(filter) ||
                    (t.Name || '').toLowerCase().includes(filter) ||
                    (t.State || '').toLowerCase().includes(filter) ||
                    (t.Type || '').toLowerCase().includes(filter) ||
                    (t.Function || '').toLowerCase().includes(filter) ||
                    (t.Context || '').toLowerCase().includes(filter) ||
                    (t.Info || '').toLowerCase().includes(filter);
            });

            // Sort
            filtered.sort((a, b) => {
                let av = a[sortColumn] ?? '';
                let bv = b[sortColumn] ?? '';
                if (typeof av === 'number' && typeof bv === 'number') {
                    return sortDirection === 'asc' ? av - bv : bv - av;
                }
                av = String(av).toLowerCase();
                bv = String(bv).toLowerCase();
                if (av < bv) return sortDirection === 'asc' ? -1 : 1;
                if (av > bv) return sortDirection === 'asc' ? 1 : -1;
                return 0;
            });

            document.getElementById('threadCount').textContent = filtered.length + ' of ' + allThreads.length + ' threads';

            const tbody = document.getElementById('threadBody');
            const emptyState = document.getElementById('emptyState');

            if (filtered.length === 0) {
                tbody.innerHTML = '';
                emptyState.style.display = 'block';
                return;
            }
            emptyState.style.display = 'none';

            tbody.innerHTML = filtered.map(t => {
                const stateClass = (t.State || '').toLowerCase() === 'run' ? 'state-run' :
                                   (t.State || '').toLowerCase() === 'wait' ? 'state-wait' : 'state-idle';
                const typeClass = (t.Type || '').toLowerCase() === 'system' ? 'type-system' : '';
                const locks = (t.WriteLocks || 0) + '/' + (t.ReadLocks || 0) + '/' + (t.IntentExclusiveLocks || 0);
                return '<tr>' +
                    '<td>' + escapeHtml(String(t.ID || '')) + '</td>' +
                    '<td title="' + escapeHtml(t.Name || '') + '">' + escapeHtml(t.Name || '') + '</td>' +
                    '<td class="' + stateClass + '">' + escapeHtml(t.State || '') + '</td>' +
                    '<td class="' + typeClass + '">' + escapeHtml(t.Type || '') + '</td>' +
                    '<td title="' + escapeHtml(t.Function || '') + '">' + escapeHtml(t.Function || '') + '</td>' +
                    '<td>' + parseDuration(t.WaitTime) + '</td>' +
                    '<td>' + parseDuration(t.ElapsedTime) + '</td>' +
                    '<td>' + locks + '</td>' +
                    '<td title="' + escapeHtml(t.Context || '') + '">' + escapeHtml(t.Context || '') + '</td>' +
                    '<td title="' + escapeHtml(t.Info || '') + '">' + escapeHtml(t.Info || '') + '</td>' +
                    '<td><button class="btn-row-kill" onclick="killThread(\\''+t.ID+'\\')">\\u2716 Kill</button></td>' +
                    '</tr>';
            }).join('');
        }

        function killThread(threadId) {
            vscode.postMessage({ command: 'cancelThread', threadId: threadId });
        }

        function killThreadById() {
            const input = document.getElementById('killThreadId');
            const threadId = (input.value || '').trim();
            if (!threadId) return;
            vscode.postMessage({ command: 'cancelThread', threadId: threadId });
            input.value = '';
        }

        // Handle Enter key in kill input
        document.getElementById('killThreadId').addEventListener('keydown', function(e) {
            if (e.key === 'Enter') killThreadById();
        });

        function parseDuration(val) {
            if (val === null || val === undefined) return 0;
            if (typeof val === 'number') return val;
            const str = String(val);
            const match = str.match(/P(?:(\\d+)D)?T(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?/i);
            if (!match) return 0;
            const days = parseInt(match[1] || '0', 10);
            const hours = parseInt(match[2] || '0', 10);
            const mins = parseInt(match[3] || '0', 10);
            const secs = parseInt(match[4] || '0', 10);
            return days * 86400 + hours * 3600 + mins * 60 + secs;
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // Initial load
        vscode.postMessage({ command: 'loadThreads' });
    </script>
</body>
</html>`;
    }
}

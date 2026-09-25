import * as vscode from 'vscode';
import * as path from 'path';
import { TM1Service } from './TM1Service';

export class FileManagerPanel {
    private static panels: Map<string, FileManagerPanel> = new Map();
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
                    case 'loadFolder':
                        await this._loadFolder(message.path || '');
                        return;
                    case 'openFile':
                        await this._openFile(message.path, message.name);
                        return;
                    case 'downloadFile':
                        await this._downloadFile(message.path, message.name);
                        return;
                }
            },
            null,
            this._disposables
        );

        // Load root on startup
        this._loadFolder('');
    }

    public static render(instanceName: string, serverRealName: string) {
        const columnToShowIn = vscode.ViewColumn.One;

        const existing = FileManagerPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(columnToShowIn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tm1FileManager',
            `Files: ${serverRealName}`,
            columnToShowIn,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        FileManagerPanel.panels.set(instanceName, new FileManagerPanel(panel, instanceName, serverRealName));
    }

    private _isFolder(item: any): boolean {
        const odataType = (item['@odata.type'] || '').toLowerCase();
        if (odataType.includes('folder')) return true;
        // Items without Content/Size and with no file extension are likely folders
        if (!odataType.includes('document') && item.Size == null && item.ContentLength == null) {
            const name = item.Name || item.ID || '';
            if (!name.includes('.')) return true;
        }
        return false;
    }

    private async _loadFolder(folderPath: string) {
        try {
            const items = await TM1Service.getInstance().getFileContents(this._instanceName, folderPath);
            this._panel.webview.postMessage({
                command: 'folderLoaded',
                path: folderPath,
                items: items.map((item: any) => ({
                    name: item.Name || item.ID || '',
                    type: this._isFolder(item) ? 'folder' : 'file',
                    size: item.Size ?? item.ContentLength ?? null,
                    lastModified: item.LastUpdated || item.LastModified || null,
                    virtualPath: item._virtualPath || null
                }))
            });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _openFile(filePath: string, fileName: string) {
        try {
            const content = await TM1Service.getInstance().getFileContent(this._instanceName, filePath);
            const ext = path.extname(fileName).toLowerCase();

            // Determine if text or binary
            const textExtensions = ['.txt', '.log', '.csv', '.json', '.xml', '.cfg', '.ini', '.pro', '.ti', '.rux', '.md', '.html', '.htm', '.js', '.ts', '.py', '.blb', '.cma', '.dim', '.feeders', '.rules'];
            if (textExtensions.includes(ext) || this._isLikelyText(content)) {
                const doc = await vscode.workspace.openTextDocument({
                    content: content.toString('utf-8'),
                    language: this._guessLanguage(ext)
                });
                await vscode.window.showTextDocument(doc, { preview: true });
            } else {
                // Binary file — offer download
                const saveUri = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(fileName),
                    filters: { 'All Files': ['*'] }
                });
                if (saveUri) {
                    await vscode.workspace.fs.writeFile(saveUri, content);
                    vscode.window.showInformationMessage(`Saved: ${saveUri.fsPath}`);
                }
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
        }
    }

    private async _downloadFile(filePath: string, fileName: string) {
        try {
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(fileName),
                filters: { 'All Files': ['*'] }
            });
            if (!saveUri) return;

            const content = await TM1Service.getInstance().getFileContent(this._instanceName, filePath);
            await vscode.workspace.fs.writeFile(saveUri, content);
            vscode.window.showInformationMessage(`Downloaded: ${saveUri.fsPath}`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Download failed: ${err.message}`);
        }
    }

    private _isLikelyText(buffer: Buffer): boolean {
        const sample = buffer.subarray(0, Math.min(8192, buffer.length));
        for (let i = 0; i < sample.length; i++) {
            const byte = sample[i];
            if (byte === 0) return false; // NUL byte = binary
        }
        return true;
    }

    private _guessLanguage(ext: string): string {
        const map: Record<string, string> = {
            '.json': 'json', '.xml': 'xml', '.html': 'html', '.htm': 'html',
            '.csv': 'csv', '.log': 'log', '.cfg': 'ini', '.ini': 'ini',
            '.js': 'javascript', '.ts': 'typescript', '.py': 'python',
            '.md': 'markdown', '.txt': 'plaintext'
        };
        return map[ext] || 'plaintext';
    }

    public dispose() {
        FileManagerPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getWebviewContent(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>File Manager</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        padding: 20px 30px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
    }
    .header {
        display: flex; align-items: center; gap: 12px;
        margin-bottom: 20px; padding-bottom: 14px;
        border-bottom: 1px solid var(--vscode-widget-border);
    }
    .header h1 { font-size: 18px; font-weight: 600; }
    .header .server {
        color: var(--vscode-descriptionForeground);
        font-size: 13px; margin-left: auto;
    }
    .toolbar {
        display: flex; align-items: center; gap: 10px;
        margin-bottom: 16px; flex-wrap: wrap;
    }
    .breadcrumb {
        display: flex; align-items: center; gap: 4px;
        font-size: 13px; flex: 1; min-width: 200px;
        flex-wrap: wrap;
    }
    .breadcrumb span {
        cursor: pointer; color: var(--vscode-textLink-foreground);
        padding: 2px 4px; border-radius: 3px;
    }
    .breadcrumb span:hover { text-decoration: underline; }
    .breadcrumb span.current {
        color: var(--vscode-foreground);
        cursor: default; font-weight: 600;
    }
    .breadcrumb .sep { color: var(--vscode-descriptionForeground); cursor: default; }
    .search-box {
        padding: 5px 10px; border-radius: 4px; border: 1px solid var(--vscode-input-border);
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        font-size: 13px; width: 240px; outline: none;
    }
    .search-box:focus { border-color: var(--vscode-focusBorder); }
    .search-box::placeholder { color: var(--vscode-input-placeholderForeground); }
    table {
        width: 100%; border-collapse: collapse;
        font-size: 13px;
    }
    thead th {
        text-align: left; padding: 8px 12px;
        border-bottom: 2px solid var(--vscode-widget-border);
        font-weight: 600; font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        cursor: pointer; user-select: none;
        white-space: nowrap;
    }
    thead th:hover { color: var(--vscode-foreground); }
    thead th .sort-arrow { font-size: 10px; margin-left: 4px; }
    tbody tr {
        border-bottom: 1px solid var(--vscode-widget-border);
        cursor: pointer;
        transition: background 0.1s;
    }
    tbody tr:hover { background: var(--vscode-list-hoverBackground); }
    tbody td { padding: 7px 12px; vertical-align: middle; }
    .icon-cell { width: 32px; text-align: center; }
    .icon-cell svg { vertical-align: middle; }
    .name-cell { font-weight: 500; }
    .name-cell .folder-name { color: var(--vscode-textLink-foreground); }
    .size-cell, .date-cell { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .type-cell { color: var(--vscode-descriptionForeground); text-transform: uppercase; font-size: 11px; }
    .actions-cell { text-align: right; white-space: nowrap; }
    .btn {
        padding: 3px 10px; border-radius: 4px; border: 1px solid var(--vscode-button-border, var(--vscode-widget-border));
        background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
        font-size: 12px; cursor: pointer; margin-left: 6px;
    }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.primary {
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
    }
    .btn.primary:hover { background: var(--vscode-button-hoverBackground); }
    .empty-state {
        text-align: center; padding: 60px 20px;
        color: var(--vscode-descriptionForeground); font-size: 14px;
    }
    .loading {
        text-align: center; padding: 40px;
        color: var(--vscode-descriptionForeground);
    }
    .error-msg {
        padding: 12px 16px; margin-bottom: 16px;
        background: rgba(255,80,80,0.1); border: 1px solid var(--vscode-errorForeground);
        border-radius: 6px; color: var(--vscode-errorForeground); font-size: 13px;
    }
    .item-count {
        font-size: 12px; color: var(--vscode-descriptionForeground);
        margin-top: 12px; text-align: right;
    }
</style>
</head>
<body>
    <div class="header">
        <svg xmlns="http://www.w3.org/2000/svg" height="24" viewBox="0 -960 960 960" width="24" fill="currentColor"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z"/></svg>
        <h1>File Manager</h1>
        <span class="server">${this._serverRealName}</span>
    </div>

    <div id="error" class="error-msg" style="display:none"></div>

    <div class="toolbar">
        <div class="breadcrumb" id="breadcrumb"></div>
        <input type="text" class="search-box" id="searchBox" placeholder="Filter files..." oninput="filterFiles()">
    </div>

    <div id="loading" class="loading">Loading...</div>
    <div id="content" style="display:none">
        <table>
            <thead>
                <tr>
                    <th class="icon-cell"></th>
                    <th onclick="sortBy('name')">Name <span class="sort-arrow" id="sort-name"></span></th>
                    <th onclick="sortBy('type')">Type <span class="sort-arrow" id="sort-type"></span></th>
                    <th onclick="sortBy('size')">Size <span class="sort-arrow" id="sort-size"></span></th>
                    <th onclick="sortBy('date')">Modified <span class="sort-arrow" id="sort-date"></span></th>
                    <th class="actions-cell">Actions</th>
                </tr>
            </thead>
            <tbody id="fileList"></tbody>
        </table>
        <div id="emptyState" class="empty-state" style="display:none">No files found</div>
        <div class="item-count" id="itemCount"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentPath = '';
        let allItems = [];
        let sortField = 'name';
        let sortAsc = true;

        const folderSvg = '<svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18" fill="#dcb67a"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Z"/></svg>';
        const fileSvg = '<svg xmlns="http://www.w3.org/2000/svg" height="18" viewBox="0 -960 960 960" width="18" fill="var(--vscode-descriptionForeground)"><path d="M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z"/></svg>';

        function navigateTo(folderPath) {
            currentPath = folderPath;
            document.getElementById('searchBox').value = '';
            document.getElementById('loading').style.display = 'block';
            document.getElementById('content').style.display = 'none';
            document.getElementById('error').style.display = 'none';
            vscode.postMessage({ command: 'loadFolder', path: folderPath });
        }

        function renderBreadcrumb() {
            const bc = document.getElementById('breadcrumb');
            const parts = currentPath.split('/').filter(p => p);
            let html = '<span onclick="navigateTo(\\'\\')" title="Root">Files</span>';
            let accumulated = '';
            for (let i = 0; i < parts.length; i++) {
                accumulated += (accumulated ? '/' : '') + parts[i];
                html += '<span class="sep">/</span>';
                if (i === parts.length - 1) {
                    html += '<span class="current">' + escHtml(parts[i]) + '</span>';
                } else {
                    const p = accumulated;
                    html += '<span onclick="navigateTo(\\'' + escAttr(p) + '\\')">' + escHtml(parts[i]) + '</span>';
                }
            }
            bc.innerHTML = html;
        }

        function renderFiles() {
            const filter = document.getElementById('searchBox').value.toLowerCase();
            let items = allItems;
            if (filter) {
                items = items.filter(f => f.name.toLowerCase().includes(filter));
            }

            // Sort: folders first, then by selected field
            items.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                let va, vb;
                switch (sortField) {
                    case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
                    case 'type': va = getExt(a); vb = getExt(b); break;
                    case 'size': va = a.size ?? -1; vb = b.size ?? -1; break;
                    case 'date': va = a.lastModified || ''; vb = b.lastModified || ''; break;
                    default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
                }
                if (va < vb) return sortAsc ? -1 : 1;
                if (va > vb) return sortAsc ? 1 : -1;
                return 0;
            });

            const tbody = document.getElementById('fileList');
            const empty = document.getElementById('emptyState');
            const count = document.getElementById('itemCount');

            if (items.length === 0) {
                tbody.innerHTML = '';
                empty.style.display = 'block';
                count.textContent = '';
                return;
            }
            empty.style.display = 'none';

            const folders = items.filter(i => i.type === 'folder').length;
            const files = items.length - folders;
            const parts = [];
            if (folders) parts.push(folders + ' folder' + (folders !== 1 ? 's' : ''));
            if (files) parts.push(files + ' file' + (files !== 1 ? 's' : ''));
            count.textContent = parts.join(', ');

            tbody.innerHTML = items.map(item => {
                const navPath = item.virtualPath || (currentPath ? currentPath + '/' + item.name : item.name);
                const fullPath = currentPath ? currentPath + '/' + item.name : item.name;
                const isFolder = item.type === 'folder';
                const ext = isFolder ? '' : getExt(item);
                const sizeStr = isFolder ? '' : formatSize(item.size);
                const dateStr = item.lastModified ? formatDate(item.lastModified) : '';

                return '<tr ondblclick="' + (isFolder ? "navigateTo('" + escAttr(navPath) + "')" : "openFile('" + escAttr(fullPath) + "','" + escAttr(item.name) + "')") + '">'
                    + '<td class="icon-cell">' + (isFolder ? folderSvg : fileSvg) + '</td>'
                    + '<td class="name-cell">' + (isFolder ? '<span class="folder-name">' + escHtml(item.name) + '</span>' : escHtml(item.name)) + '</td>'
                    + '<td class="type-cell">' + escHtml(ext || (isFolder ? 'Folder' : '')) + '</td>'
                    + '<td class="size-cell">' + sizeStr + '</td>'
                    + '<td class="date-cell">' + dateStr + '</td>'
                    + '<td class="actions-cell">'
                        + (isFolder ? '' : '<button class="btn primary" onclick="event.stopPropagation();openFile(\\'' + escAttr(fullPath) + '\\',\\'' + escAttr(item.name) + '\\')">Open</button>'
                        + '<button class="btn" onclick="event.stopPropagation();downloadFile(\\'' + escAttr(fullPath) + '\\',\\'' + escAttr(item.name) + '\\')">Download</button>')
                    + '</td></tr>';
            }).join('');
        }

        function openFile(path, name) {
            vscode.postMessage({ command: 'openFile', path, name });
        }
        function downloadFile(path, name) {
            vscode.postMessage({ command: 'downloadFile', path, name });
        }

        function filterFiles() { renderFiles(); }

        function sortBy(field) {
            if (sortField === field) { sortAsc = !sortAsc; }
            else { sortField = field; sortAsc = true; }
            // Update sort arrows
            document.querySelectorAll('.sort-arrow').forEach(el => el.textContent = '');
            const arrow = document.getElementById('sort-' + field);
            if (arrow) arrow.textContent = sortAsc ? '▲' : '▼';
            renderFiles();
        }

        function getExt(item) {
            if (item.type === 'folder') return '';
            const dot = item.name.lastIndexOf('.');
            return dot >= 0 ? item.name.substring(dot + 1) : '';
        }

        function formatSize(bytes) {
            if (bytes == null || bytes < 0) return '';
            if (bytes === 0) return '0 B';
            const units = ['B', 'KB', 'MB', 'GB'];
            const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            const val = bytes / Math.pow(1024, i);
            return (i === 0 ? val : val.toFixed(1)) + ' ' + units[i];
        }

        function formatDate(iso) {
            try {
                const d = new Date(iso);
                const pad = n => n.toString().padStart(2, '0');
                return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            } catch { return iso; }
        }

        function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
        function escAttr(s) { return s.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'"); }

        window.addEventListener('message', event => {
            const msg = event.data;
            switch (msg.command) {
                case 'folderLoaded':
                    allItems = msg.items;
                    currentPath = msg.path;
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('content').style.display = 'block';
                    renderBreadcrumb();
                    renderFiles();
                    break;
                case 'error':
                    document.getElementById('loading').style.display = 'none';
                    document.getElementById('content').style.display = 'block';
                    const errEl = document.getElementById('error');
                    errEl.textContent = msg.message;
                    errEl.style.display = 'block';
                    break;
            }
        });

        // Init sort arrow
        document.getElementById('sort-name').textContent = '▲';
    </script>
</body>
</html>`;
    }
}

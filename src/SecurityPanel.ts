import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class SecurityPanel {
    private static panels: Map<string, SecurityPanel> = new Map();
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
                    await this._loadData();
                    return;
                case 'assignUser':
                    await this._assignUser(message.userName, message.groupName);
                    return;
                case 'removeUser':
                    await this._removeUser(message.userName, message.groupName);
                    return;
                case 'createUser':
                    await this._createUser(message.userName, message.friendlyName);
                    return;
                case 'deleteUser':
                    await this._deleteUser(message.userName);
                    return;
                case 'createGroup':
                    await this._createGroup(message.groupName);
                    return;
                case 'deleteGroup':
                    await this._deleteGroup(message.groupName);
                    return;
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string) {
        const existing = SecurityPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1Security', `Security — ${instanceName}`, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        SecurityPanel.panels.set(instanceName, new SecurityPanel(panel, instanceName));
    }

    private dispose() {
        SecurityPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private async _loadData() {
        const tm1 = TM1Service.getInstance();
        try {
            const [groups, users] = await Promise.all([
                tm1.getSecurityGroups(this._instanceName),
                tm1.getUsers(this._instanceName)
            ]);

            // Build membership matrix: { userName: Set<groupName> }
            const membership: { [user: string]: string[] } = {};
            for (const u of users) {
                membership[u.Name] = [];
            }
            for (const g of groups) {
                for (const u of g.Users || []) {
                    if (membership[u.Name]) {
                        membership[u.Name].push(g.Name);
                    } else {
                        membership[u.Name] = [g.Name];
                    }
                }
            }

            this._panel.webview.postMessage({
                command: 'data',
                users: users.map(u => ({ name: u.Name, friendlyName: u.FriendlyName || '' })),
                groups: groups.map(g => g.Name),
                membership
            });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _assignUser(userName: string, groupName: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.addUserToGroup(this._instanceName, userName, groupName);
            this._panel.webview.postMessage({ command: 'assigned', userName, groupName });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _removeUser(userName: string, groupName: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.removeUserFromGroup(this._instanceName, userName, groupName);
            this._panel.webview.postMessage({ command: 'removed', userName, groupName });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _createUser(userName: string, friendlyName?: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.createUser(this._instanceName, userName, friendlyName);
            this._panel.webview.postMessage({ command: 'userCreated' });
            await this._loadData();
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _deleteUser(userName: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.deleteUser(this._instanceName, userName);
            this._panel.webview.postMessage({ command: 'userDeleted', userName });
            await this._loadData();
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _createGroup(groupName: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.createGroup(this._instanceName, groupName);
            this._panel.webview.postMessage({ command: 'groupCreated' });
            await this._loadData();
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private async _deleteGroup(groupName: string) {
        const tm1 = TM1Service.getInstance();
        try {
            await tm1.deleteGroup(this._instanceName, groupName);
            this._panel.webview.postMessage({ command: 'groupDeleted', groupName });
            await this._loadData();
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: err.message });
        }
    }

    private _getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; }
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0; margin: 0; font-size: 13px; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }

    .top-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 16px; flex-shrink: 0;
    }
    .top-bar h2 { margin: 0; font-weight: 400; font-size: 16px; }

    .toolbar {
        display: flex; gap: 8px; align-items: center; padding: 0 16px 8px 16px; flex-shrink: 0; flex-wrap: wrap;
    }
    input[type="text"] {
        background: var(--vscode-input-background); color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, #444); padding: 4px 8px; border-radius: 3px; font-size: 13px; width: 180px;
    }

    .icon-bar {
        display: flex; gap: 2px; align-items: center; padding: 4px 16px;
        border-bottom: 1px solid var(--vscode-panel-border, #333); flex-shrink: 0;
    }
    .icon-btn {
        background: transparent; border: none; cursor: pointer; padding: 4px 6px; border-radius: 4px;
        display: inline-flex; align-items: center; gap: 4px; color: var(--vscode-foreground); font-size: 12px; opacity: 0.85;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, #333); opacity: 1; }
    .icon-btn svg { width: 18px; height: 18px; fill: #fff; }
    .icon-sep { width: 1px; height: 18px; background: var(--vscode-panel-border, #444); margin: 0 4px; }

    .btn {
        background: var(--vscode-button-background); color: var(--vscode-button-foreground);
        border: none; padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px; white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-active { background: var(--vscode-inputOption-activeBackground, #094771); outline: 1px solid var(--vscode-inputOption-activeBorder, #007acc); }
    .btn-danger { background: #b91c1c; }
    .btn-danger:hover { background: #dc2626; }
    .status { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: auto; }
    .status.error { color: #f85149; }

    .matrix-container { overflow: auto; flex: 1; }
    table { border-collapse: collapse; width: max-content; }

    thead th {
        position: sticky; top: 0; z-index: 2;
        background: var(--vscode-editor-background);
        border-bottom: 2px solid var(--vscode-panel-border, #444);
        padding: 6px 10px; font-weight: 600; font-size: 12px; white-space: nowrap;
        text-align: center; cursor: pointer; user-select: none;
        max-width: 120px; overflow: hidden; text-overflow: ellipsis;
    }
    thead th:hover { background: var(--vscode-list-hoverBackground); }
    thead th.corner { z-index: 3; left: 0; text-align: left; }

    tbody td.row-header {
        position: sticky; left: 0; z-index: 1;
        background: var(--vscode-editor-background);
        text-align: left; padding: 4px 10px; font-weight: normal; white-space: nowrap;
        border-right: 1px solid var(--vscode-panel-border, #333);
    }
    tbody tr { border-bottom: 1px solid var(--vscode-panel-border, #262626); }
    tbody tr:hover td { background: var(--vscode-list-hoverBackground); }
    tbody tr:hover td.row-header { background: var(--vscode-list-hoverBackground); }
    tbody tr.highlight-row td { background: var(--vscode-list-activeSelectionBackground, #094771) !important; }
    tbody tr.highlight-row td.row-header { background: var(--vscode-list-activeSelectionBackground, #094771) !important; }

    tbody td {
        padding: 4px 10px; text-align: center; cursor: pointer; min-width: 50px;
        border-right: 1px solid var(--vscode-panel-border, #262626);
    }

    .cell-check {
        display: inline-flex; align-items: center; justify-content: center;
        width: 20px; height: 20px; border-radius: 50%;
        background: #2ea043; color: #fff; font-size: 13px; font-weight: 700;
    }
    .cell-dash { color: var(--vscode-disabledForeground, #666); font-size: 15px; }

    .user-name { font-weight: 600; }
    .user-friendly { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 6px; }
    .group-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
    .sort-arrow { font-size: 10px; margin-left: 2px; }

    .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px; padding: 20px; min-width: 320px; }
    .modal h3 { margin: 0 0 12px 0; font-weight: 500; font-size: 14px; }
    .modal input { width: 100%; margin-bottom: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #444); padding: 6px 10px; border-radius: 3px; font-size: 13px; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
</style>
</head>
<body>

<div class="top-bar">
    <h2>Security Manager</h2>
    <span class="status" id="statusMsg"></span>
</div>

<div class="toolbar">
    <input type="text" id="searchUsers" placeholder="Search users..." oninput="applyFilters()" />
    <input type="text" id="searchGroups" placeholder="Search groups..." oninput="applyFilters()" />
    <button class="btn" id="btnAssignedOnly" onclick="toggleAssignedOnly()">Show assigned only</button>
</div>

<div class="icon-bar">
    <button class="icon-btn" onclick="showAddUserModal()" title="Add User">
        <svg viewBox="0 0 24 24"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        <span>Add User</span>
    </button>
    <button class="icon-btn" onclick="showDeleteUserModal()" title="Delete User">
        <svg viewBox="0 0 24 24"><path d="M14 8c0-2.21-1.79-4-4-4S6 5.79 6 8s1.79 4 4 4 4-1.79 4-4zm3 2V7h-2v3h-3v2h3v3h2v-3h3v-2h-3zM2 18v2h16v-2c0-2.66-5.33-4-8-4s-8 1.34-8 4z"/></svg>
        <span>Delete User</span>
    </button>
    <div class="icon-sep"></div>
    <button class="icon-btn" onclick="showAddGroupModal()" title="Add Group">
        <svg viewBox="0 0 24 24"><path d="M8 10H5V7H3v3H0v2h3v3h2v-3h3v-2zm10 1c1.66 0 2.99-1.34 2.99-3S19.66 5 18 5c-.32 0-.63.05-.91.14.57.81.9 1.79.9 2.86s-.34 2.04-.9 2.86c.28.09.59.14.91.14zm-5 0c1.66 0 2.99-1.34 2.99-3S14.66 5 13 5s-3 1.34-3 3 1.34 3 3 3zm6.62 2.16c.83.73 1.38 1.66 1.38 2.84v2h3v-2c0-1.54-2.37-2.49-4.38-2.84zM13 13c-2 0-6 1-6 3v2h12v-2c0-2-4-3-6-3z"/></svg>
        <span>Add Group</span>
    </button>
    <button class="icon-btn" onclick="showDeleteGroupModal()" title="Delete Group">
        <svg viewBox="0 0 24 24"><path d="M8.5 10H1.5v2H8.5v-2zm10 1c1.66 0 2.99-1.34 2.99-3S20.16 5 18.5 5c-.32 0-.63.05-.91.14.57.81.9 1.79.9 2.86s-.34 2.04-.9 2.86c.28.09.59.14.91.14zm-5 0c1.66 0 2.99-1.34 2.99-3S15.16 5 13.5 5s-3 1.34-3 3 1.34 3 3 3zm6.62 2.16c.83.73 1.38 1.66 1.38 2.84v2h3v-2c0-1.54-2.37-2.49-4.38-2.84zM13.5 13c-2 0-6 1-6 3v2h12v-2c0-2-4-3-6-3z"/></svg>
        <span>Delete Group</span>
    </button>
    <div class="icon-sep"></div>
    <button class="icon-btn" onclick="refreshData()" title="Refresh">
        <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
        <span>Refresh</span>
    </button>
</div>

<div class="matrix-container" id="matrixContainer">
    <div class="loading">Loading security data...</div>
</div>

<!-- Add User Modal -->
<div class="modal-overlay" id="addUserModal">
    <div class="modal">
        <h3>Add User</h3>
        <input type="text" id="newUserName" placeholder="User Name (required)" />
        <input type="text" id="newUserFriendly" placeholder="Friendly Name (optional)" />
        <div class="modal-actions">
            <button class="btn" onclick="closeModal('addUserModal')">Cancel</button>
            <button class="btn" onclick="submitAddUser()">Create</button>
        </div>
    </div>
</div>

<!-- Delete User Modal -->
<div class="modal-overlay" id="deleteUserModal">
    <div class="modal">
        <h3>Delete User</h3>
        <select id="deleteUserSelect" style="width:100%;margin-bottom:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#444);padding:6px 10px;border-radius:3px;font-size:13px;"></select>
        <div class="modal-actions">
            <button class="btn" onclick="closeModal('deleteUserModal')">Cancel</button>
            <button class="btn btn-danger" onclick="submitDeleteUser()">Delete</button>
        </div>
    </div>
</div>

<!-- Add Group Modal -->
<div class="modal-overlay" id="addGroupModal">
    <div class="modal">
        <h3>Add Group</h3>
        <input type="text" id="newGroupName" placeholder="Group Name (required)" />
        <div class="modal-actions">
            <button class="btn" onclick="closeModal('addGroupModal')">Cancel</button>
            <button class="btn" onclick="submitAddGroup()">Create</button>
        </div>
    </div>
</div>

<!-- Delete Group Modal -->
<div class="modal-overlay" id="deleteGroupModal">
    <div class="modal">
        <h3>Delete Group</h3>
        <select id="deleteGroupSelect" style="width:100%;margin-bottom:8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,#444);padding:6px 10px;border-radius:3px;font-size:13px;"></select>
        <div class="modal-actions">
            <button class="btn" onclick="closeModal('deleteGroupModal')">Cancel</button>
            <button class="btn btn-danger" onclick="submitDeleteGroup()">Delete</button>
        </div>
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    let allUsers = [];
    let allGroups = [];
    let membership = {};
    let filteredUsers = [];
    let filteredGroups = [];
    let assignedOnly = false;
    let selectedUser = null;
    let sortCol = 'name';
    let sortAsc = true;

    vscode.postMessage({ command: 'init' });

    window.addEventListener('message', event => {
        const msg = event.data;
        switch (msg.command) {
            case 'data':
                allUsers = msg.users;
                allGroups = msg.groups;
                membership = msg.membership;
                applyFilters();
                break;
            case 'assigned':
                if (!membership[msg.userName]) membership[msg.userName] = [];
                if (!membership[msg.userName].includes(msg.groupName)) membership[msg.userName].push(msg.groupName);
                showStatus(msg.userName + ' added to ' + msg.groupName, false);
                renderMatrix();
                break;
            case 'removed':
                if (membership[msg.userName]) {
                    membership[msg.userName] = membership[msg.userName].filter(g => g !== msg.groupName);
                }
                showStatus(msg.userName + ' removed from ' + msg.groupName, false);
                renderMatrix();
                break;
            case 'error':
                showStatus(msg.message, true);
                break;
        }
    });

    function showStatus(text, isError) {
        const el = document.getElementById('statusMsg');
        el.textContent = text;
        el.className = isError ? 'status error' : 'status';
        if (!isError) setTimeout(() => { el.textContent = ''; }, 4000);
    }

    function toggleAssignedOnly() {
        assignedOnly = !assignedOnly;
        document.getElementById('btnAssignedOnly').classList.toggle('btn-active', assignedOnly);
        applyFilters();
    }

    function applyFilters() {
        const uq = document.getElementById('searchUsers').value.toLowerCase();
        const gq = document.getElementById('searchGroups').value.toLowerCase();

        filteredUsers = allUsers.filter(u =>
            u.name.toLowerCase().includes(uq) || (u.friendlyName && u.friendlyName.toLowerCase().includes(uq))
        );
        filteredGroups = allGroups.filter(g => g.toLowerCase().includes(gq));

        if (assignedOnly && selectedUser) {
            const userGroups = membership[selectedUser] || [];
            filteredGroups = filteredGroups.filter(g => userGroups.includes(g));
        }

        filteredUsers.sort((a, b) => {
            if (sortCol === 'name') return sortAsc ? a.name.localeCompare(b.name) : b.name.localeCompare(a.name);
            if (sortCol === 'count') {
                const ca = (membership[a.name] || []).length;
                const cb = (membership[b.name] || []).length;
                return sortAsc ? ca - cb : cb - ca;
            }
            if (sortCol.startsWith('g:')) {
                const gName = sortCol.substring(2);
                const aHas = (membership[a.name] || []).includes(gName) ? 1 : 0;
                const bHas = (membership[b.name] || []).includes(gName) ? 1 : 0;
                return sortAsc ? bHas - aHas : aHas - bHas;
            }
            return 0;
        });

        renderMatrix();
    }

    function sortBy(col) {
        if (sortCol === col) { sortAsc = !sortAsc; } else { sortCol = col; sortAsc = true; }
        applyFilters();
    }

    function refreshData() {
        const container = document.getElementById('matrixContainer');
        container.innerHTML = '<div class="loading">Loading security data...</div>';
        allUsers = []; allGroups = []; membership = {};
        vscode.postMessage({ command: 'init' });
    }

    function renderMatrix() {
        const container = document.getElementById('matrixContainer');
        if (filteredUsers.length === 0 || filteredGroups.length === 0) {
            container.innerHTML = '<div class="loading">No data matching filters</div>';
            return;
        }

        let html = '<table><thead><tr>';
        const userArrow = sortCol === 'name' ? '<span class="sort-arrow">' + (sortAsc ? '▲' : '▼') + '</span>' : '<span class="sort-arrow">▸</span>';
        html += '<th class="corner" onclick="sortBy(\\'name\\')">' + userArrow + '</th>';

        const countArrow = sortCol === 'count' ? '<span class="sort-arrow">' + (sortAsc ? '▲' : '▼') + '</span>' : '';
        html += '<th onclick="sortBy(\\'count\\')" title="Number of groups" style="min-width:30px;">#' + countArrow + '</th>';

        for (const g of filteredGroups) {
            const isActive = sortCol === 'g:' + g;
            const arrow = isActive ? '<span class="sort-arrow">' + (sortAsc ? '▲' : '▼') + '</span>' : '';
            html += '<th onclick="sortBy(\\'g:' + escapeJs(g) + '\\')" title="' + escapeHtml(g) + '">' + escapeHtml(g) + arrow + '</th>';
        }
        html += '</tr></thead><tbody>';

        for (const u of filteredUsers) {
            const userGroups = membership[u.name] || [];
            const count = userGroups.length;
            const isSelected = selectedUser === u.name;
            html += '<tr class="' + (isSelected ? 'highlight-row' : '') + '" onclick="selectUser(\\'' + escapeJs(u.name) + '\\')">';

            html += '<td class="row-header"><span class="user-name">' + escapeHtml(u.name) + '</span>';
            if (u.friendlyName && u.friendlyName !== u.name) html += '<span class="user-friendly">' + escapeHtml(u.friendlyName) + '</span>';
            html += '</td>';
            html += '<td class="group-count" style="cursor:default;text-align:center;">' + count + '</td>';

            for (const g of filteredGroups) {
                const isMember = userGroups.includes(g);
                const content = isMember ? '<span class="cell-check">✓</span>' : '<span class="cell-dash">—</span>';
                html += '<td onclick="event.stopPropagation(); toggleMembership(\\'' + escapeJs(u.name) + '\\', \\'' + escapeJs(g) + '\\', ' + isMember + ')" title="' + escapeHtml(u.name) + ' / ' + escapeHtml(g) + '">' + content + '</td>';
            }
            html += '</tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
    }

    function selectUser(userName) {
        selectedUser = selectedUser === userName ? null : userName;
        if (assignedOnly) applyFilters(); else renderMatrix();
    }

    function toggleMembership(userName, groupName, currentlyAssigned) {
        if (currentlyAssigned) {
            vscode.postMessage({ command: 'removeUser', userName, groupName });
        } else {
            vscode.postMessage({ command: 'assignUser', userName, groupName });
        }
    }

    function showAddUserModal() { document.getElementById('addUserModal').classList.add('active'); document.getElementById('newUserName').value = ''; document.getElementById('newUserFriendly').value = ''; document.getElementById('newUserName').focus(); }
    function showDeleteUserModal() {
        const sel = document.getElementById('deleteUserSelect');
        sel.innerHTML = allUsers.map(u => '<option value="' + escapeHtml(u.name) + '">' + escapeHtml(u.name) + (u.friendlyName && u.friendlyName !== u.name ? ' (' + escapeHtml(u.friendlyName) + ')' : '') + '</option>').join('');
        document.getElementById('deleteUserModal').classList.add('active');
    }
    function showAddGroupModal() { document.getElementById('addGroupModal').classList.add('active'); document.getElementById('newGroupName').value = ''; document.getElementById('newGroupName').focus(); }
    function showDeleteGroupModal() {
        const sel = document.getElementById('deleteGroupSelect');
        sel.innerHTML = allGroups.map(g => '<option value="' + escapeHtml(g) + '">' + escapeHtml(g) + '</option>').join('');
        document.getElementById('deleteGroupModal').classList.add('active');
    }
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }

    function submitAddUser() {
        const name = document.getElementById('newUserName').value.trim();
        if (!name) return;
        const friendly = document.getElementById('newUserFriendly').value.trim();
        vscode.postMessage({ command: 'createUser', userName: name, friendlyName: friendly || undefined });
        closeModal('addUserModal');
        showStatus('Creating user ' + name + '...', false);
    }
    function submitDeleteUser() {
        const name = document.getElementById('deleteUserSelect').value;
        if (!name) return;
        vscode.postMessage({ command: 'deleteUser', userName: name });
        closeModal('deleteUserModal');
        showStatus('Deleting user ' + name + '...', false);
    }
    function submitAddGroup() {
        const name = document.getElementById('newGroupName').value.trim();
        if (!name) return;
        vscode.postMessage({ command: 'createGroup', groupName: name });
        closeModal('addGroupModal');
        showStatus('Creating group ' + name + '...', false);
    }
    function submitDeleteGroup() {
        const name = document.getElementById('deleteGroupSelect').value;
        if (!name) return;
        vscode.postMessage({ command: 'deleteGroup', groupName: name });
        closeModal('deleteGroupModal');
        showStatus('Deleting group ' + name + '...', false);
    }

    function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function escapeJs(s) { return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
</script>
</body>
</html>`;
    }
}

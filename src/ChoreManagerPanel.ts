import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class ChoreManagerPanel {
    private static panels: Map<string, ChoreManagerPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;

    private constructor(panel: vscode.WebviewPanel, instanceName: string) {
        this._panel = panel;
        this._instanceName = instanceName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                const tm1 = TM1Service.getInstance();
                console.log('[ChoreManager] Received message:', message.command);
                switch (message.command) {
                    case 'getChores': {
                        try {
                            console.log('[ChoreManager] Fetching chores for', this._instanceName);
                            const chores = await tm1.getChores(this._instanceName);
                            console.log('[ChoreManager] Got', chores.length, 'chores');
                            this._post('choresLoaded', { chores });
                        } catch (error: any) {
                            console.error('[ChoreManager] getChores error:', error.message);
                            this._post('choresLoaded', { chores: [] });
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'toggleActive': {
                        try {
                            await tm1.updateChoreActive(this._instanceName, message.choreName, message.active);
                            this._post('toggleDone', { choreName: message.choreName, active: message.active });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'executeChore': {
                        try {
                            await tm1.executeChore(this._instanceName, message.choreName);
                            this._post('executeDone', { choreName: message.choreName });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'getProcesses': {
                        try {
                            const procs = await tm1.getProcesses(this._instanceName, 'all');
                            this._post('processesLoaded', { processes: procs.map(p => p.Name) });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'getProcessParameters': {
                        try {
                            const params = await tm1.getProcessParameters(this._instanceName, message.processName);
                            this._post('processParamsLoaded', { processName: message.processName, parameters: params });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'getChoreHistory': {
                        try {
                            const logs = await tm1.getChoreMessageLog(this._instanceName, message.since);
                            this._post('historyLoaded', { logs });
                        } catch (error: any) {
                            this._post('historyLoaded', { logs: [] });
                        }
                        break;
                    }
                    case 'getChoreDetail': {
                        try {
                            const chore = await tm1.getChore(this._instanceName, message.choreName);
                            this._post('choreDetailLoaded', { chore });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'createChore': {
                        try {
                            await tm1.createChore(this._instanceName, message.body);
                            this._post('saveDone', {});
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'updateChore': {
                        try {
                            await tm1.updateChore(this._instanceName, message.choreName, message.body);
                            this._post('saveDone', {});
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                    case 'deleteChore': {
                        try {
                            await tm1.deleteChore(this._instanceName, message.choreName);
                            this._post('deleteDone', { choreName: message.choreName });
                        } catch (error: any) {
                            this._post('error', { message: error.message });
                        }
                        break;
                    }
                }
            },
            null,
            this._disposables
        );
    }

    public static render(instanceName: string) {
        const columnToShowIn = vscode.ViewColumn.One;
        const existing = ChoreManagerPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(columnToShowIn);
            return;
        }
        const serverName = instanceName.split('_').slice(1).join('_') || instanceName;
        const panel = vscode.window.createWebviewPanel(
            'tm1ChoreManager',
            `Chore Manager – ${serverName}`,
            columnToShowIn,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        ChoreManagerPanel.panels.set(instanceName, new ChoreManagerPanel(panel, instanceName));
    }

    public dispose() {
        ChoreManagerPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _post(command: string, data: any) {
        this._panel.webview.postMessage({ command, ...data });
    }

    private _getWebviewContent(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Chore Manager</title>
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 16px 24px;
    }

    /* ── HEADER ── */
    .toolbar {
        display: flex; align-items: center; gap: 12px;
        margin-bottom: 16px; flex-wrap: wrap;
    }
    .toolbar h2 { font-size: 18px; font-weight: 600; margin-right: auto; }
    .toolbar select, .toolbar input[type="text"] {
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        border-radius: 4px; padding: 5px 8px; font-size: 13px;
    }
    .toolbar input[type="text"] { width: 220px; }

    /* ── BUTTONS ── */
    .btn {
        padding: 6px 14px; border: none; border-radius: 4px;
        font-size: 13px; cursor: pointer; white-space: nowrap;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .btn-secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-danger {
        background: var(--vscode-errorForeground);
        color: #fff;
    }
    .btn-icon {
        background: none; border: none; cursor: pointer;
        color: var(--vscode-foreground); padding: 4px; border-radius: 4px;
        display: inline-flex; align-items: center; justify-content: center;
    }
    .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .btn-icon svg { width: 16px; height: 16px; fill: currentColor; }

    /* ── TABLE ── */
    .table-wrap { overflow-x: auto; }
    table {
        width: 100%; border-collapse: collapse;
        font-size: 13px;
    }
    th, td {
        padding: 8px 12px; text-align: left;
        border-bottom: 1px solid var(--vscode-widget-border);
    }
    th {
        position: sticky; top: 0; z-index: 2;
        background: var(--vscode-editorGroupHeader-tabsBackground);
        font-weight: 600; font-size: 12px; text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--vscode-descriptionForeground);
        cursor: pointer; user-select: none; white-space: nowrap;
    }
    th:hover { color: var(--vscode-foreground); }
    th .sort-arrow { font-size: 10px; margin-left: 4px; }
    tr:hover { background: var(--vscode-list-hoverBackground); }

    /* ── TOGGLE ── */
    .toggle { position: relative; display: inline-block; width: 36px; height: 20px; }
    .toggle input { opacity: 0; width: 0; height: 0; }
    .toggle .slider {
        position: absolute; inset: 0; border-radius: 10px;
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-widget-border);
        transition: background 0.2s;
        cursor: pointer;
    }
    .toggle .slider::before {
        content: ''; position: absolute;
        width: 14px; height: 14px; border-radius: 50%;
        left: 2px; top: 2px;
        background: var(--vscode-descriptionForeground);
        transition: transform 0.2s, background 0.2s;
    }
    .toggle input:checked + .slider {
        background: var(--vscode-button-background);
        border-color: var(--vscode-button-background);
    }
    .toggle input:checked + .slider::before {
        transform: translateX(16px);
        background: var(--vscode-button-foreground);
    }

    /* ── BADGES ── */
    .badge {
        display: inline-block; padding: 2px 8px; border-radius: 10px;
        font-size: 11px; font-weight: 600;
    }
    .badge-success { background: #2ea04333; color: #4ec94e; }
    .badge-warning { background: #d4a72c33; color: #d4a72c; }
    .badge-error   { background: #f4484833; color: #f44848; }
    .badge-info    {
        background: var(--vscode-badge-background);
        color: var(--vscode-badge-foreground);
        font-weight: normal;
    }

    /* ── MODAL OVERLAY ── */
    .modal-overlay {
        display: none; position: fixed; inset: 0;
        background: rgba(0,0,0,0.5); z-index: 100;
        align-items: center; justify-content: center;
    }
    .modal-overlay.open { display: flex; }
    .modal {
        background: var(--vscode-editor-background);
        border: 1px solid var(--vscode-widget-border);
        border-radius: 8px; width: 720px; max-height: 85vh;
        display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .modal-header {
        display: flex; align-items: center; padding: 14px 20px;
        border-bottom: 1px solid var(--vscode-widget-border);
    }
    .modal-header h3 { flex: 1; font-size: 16px; }
    .modal-body { padding: 20px; overflow-y: auto; flex: 1; }
    .modal-footer {
        display: flex; justify-content: flex-end; gap: 8px;
        padding: 12px 20px;
        border-top: 1px solid var(--vscode-widget-border);
    }

    /* ── TABS ── */
    .tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border); margin-bottom: 16px; }
    .tab-btn {
        padding: 8px 18px; background: none; border: none;
        color: var(--vscode-descriptionForeground);
        font-size: 13px; cursor: pointer;
        border-bottom: 2px solid transparent;
    }
    .tab-btn.active {
        color: var(--vscode-foreground);
        border-bottom-color: var(--vscode-button-background);
        font-weight: 600;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }

    /* ── FORM ── */
    .form-row { margin-bottom: 14px; }
    .form-row label {
        display: block; font-size: 12px; font-weight: 600;
        margin-bottom: 4px; color: var(--vscode-descriptionForeground);
    }
    .form-row input, .form-row select {
        width: 100%; padding: 6px 10px; font-size: 13px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        border-radius: 4px;
    }
    .form-row input:disabled {
        opacity: 0.6; cursor: not-allowed;
    }
    .freq-row { display: flex; gap: 10px; }
    .freq-row .freq-field { flex: 1; }
    .freq-row .freq-field label { font-size: 11px; }
    .freq-row .freq-field input { width: 100%; }

    /* ── TASK LIST ── */
    .task-list { border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; }
    .task-item {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--vscode-widget-border);
        background: var(--vscode-editor-background);
    }
    .task-item:last-child { border-bottom: none; }
    .task-item .task-num {
        font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground);
        width: 24px; text-align: center; flex-shrink: 0;
    }
    .task-item .task-name { flex: 1; font-size: 13px; }
    .task-item .task-actions { display: flex; gap: 2px; }
    .task-params {
        padding: 8px 12px 8px 44px;
        border-bottom: 1px solid var(--vscode-widget-border);
        background: var(--vscode-sideBar-background);
    }
    .task-params:last-child { border-bottom: none; }
    .param-row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .param-row:last-child { margin-bottom: 0; }
    .param-row .param-name {
        font-size: 12px; width: 160px; flex-shrink: 0;
        color: var(--vscode-descriptionForeground);
    }
    .param-row input { flex: 1; padding: 4px 8px; font-size: 12px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        border-radius: 3px;
    }
    .add-task-row {
        display: flex; gap: 8px; margin-top: 10px;
    }
    .add-task-row select { flex: 1; padding: 6px 10px; font-size: 13px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
        border-radius: 4px;
    }

    .empty-msg {
        text-align: center; padding: 40px;
        color: var(--vscode-descriptionForeground);
    }
    .spinner {
        display: inline-block; width: 16px; height: 16px;
        border: 2px solid var(--vscode-descriptionForeground);
        border-top-color: transparent; border-radius: 50%;
        animation: spin 0.6s linear infinite; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .chore-name-cell { font-weight: 600; }
    .actions-cell { white-space: nowrap; }
    .status-loading { opacity: 0.5; }
</style>
</head>
<body>

<!-- ╔═══════════════════════════════════════╗ -->
<!-- ║           MAIN TABLE VIEW             ║ -->
<!-- ╚═══════════════════════════════════════╝ -->
<div id="mainView">
    <div class="toolbar">
        <h2>Chore Manager</h2>
        <input type="text" id="searchInput" placeholder="Search chores..." oninput="applyFilters()">
        <select id="logRange" onchange="loadHistory()">
            <option value="24">Last 24 Hours</option>
            <option value="168" selected>Last 7 Days</option>
            <option value="720">Last 30 Days</option>
        </select>
        <button class="btn" onclick="refreshAll()">↻ Refresh</button>
        <button class="btn" onclick="openCreateModal()">+ New Chore</button>
    </div>
    <div class="table-wrap">
        <table>
            <thead>
                <tr>
                    <th onclick="sortBy('Active')">Status <span class="sort-arrow" id="sort_Active"></span></th>
                    <th onclick="sortBy('Name')">Chore Name <span class="sort-arrow" id="sort_Name"></span></th>
                    <th onclick="sortBy('Frequency')">Frequency & Start <span class="sort-arrow" id="sort_Frequency"></span></th>
                    <th onclick="sortBy('NextRun')">Next Execution <span class="sort-arrow" id="sort_NextRun"></span></th>
                    <th onclick="sortBy('LastRun')">Last Run <span class="sort-arrow" id="sort_LastRun"></span></th>
                    <th>Duration</th>
                    <th onclick="sortBy('LastStatus')">Last Status <span class="sort-arrow" id="sort_LastStatus"></span></th>
                    <th>Mode</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="choreTableBody">
                <tr><td colspan="9" class="empty-msg"><span class="spinner"></span> Loading chores...</td></tr>
            </tbody>
        </table>
    </div>
</div>

<!-- ╔═══════════════════════════════════════╗ -->
<!-- ║         CREATE / EDIT MODAL           ║ -->
<!-- ╚═══════════════════════════════════════╝ -->
<div class="modal-overlay" id="choreModal">
    <div class="modal">
        <div class="modal-header">
            <h3 id="modalTitle">New Chore</h3>
            <button class="btn-icon" onclick="closeModal()" title="Close">
                <svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>
            </button>
        </div>
        <div class="modal-body">
            <div class="tabs">
                <button class="tab-btn active" onclick="switchTab('settings')">Settings & Schedule</button>
                <button class="tab-btn" onclick="switchTab('tasks')">Processes & Parameters</button>
            </div>

            <!-- TAB 1: Settings -->
            <div class="tab-content active" id="tab_settings">
                <div class="form-row">
                    <label>Chore Name</label>
                    <input type="text" id="choreName" placeholder="e.g. DailyDataLoad">
                </div>
                <div class="form-row">
                    <label>Execution Mode</label>
                    <select id="choreExecMode">
                        <option value="SingleCommit">Single Commit</option>
                        <option value="MultipleCommit">Multiple Commit</option>
                    </select>
                </div>
                <div class="form-row">
                    <label>Start Time</label>
                    <input type="datetime-local" id="choreStartTime" step="1">
                </div>
                <div class="form-row">
                    <label>Frequency</label>
                    <div class="freq-row">
                        <div class="freq-field">
                            <label>Days</label>
                            <input type="number" id="freqDays" value="0" min="0">
                        </div>
                        <div class="freq-field">
                            <label>Hours</label>
                            <input type="number" id="freqHours" value="0" min="0" max="23">
                        </div>
                        <div class="freq-field">
                            <label>Minutes</label>
                            <input type="number" id="freqMinutes" value="0" min="0" max="59">
                        </div>
                        <div class="freq-field">
                            <label>Seconds</label>
                            <input type="number" id="freqSeconds" value="0" min="0" max="59">
                        </div>
                    </div>
                </div>
                <div class="form-row">
                    <label>Active</label>
                    <label class="toggle">
                        <input type="checkbox" id="choreActive" checked>
                        <span class="slider"></span>
                    </label>
                </div>
            </div>

            <!-- TAB 2: Tasks -->
            <div class="tab-content" id="tab_tasks">
                <div class="task-list" id="taskList">
                    <div class="empty-msg" style="padding:20px;">No processes added yet.</div>
                </div>
                <div class="add-task-row">
                    <select id="processDropdown">
                        <option value="">-- Select Process --</option>
                    </select>
                    <button class="btn btn-sm" onclick="addTask()">+ Add</button>
                </div>
            </div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-danger" id="btnDeleteChore" style="margin-right:auto;display:none;" onclick="confirmDeleteChore()">Delete Chore</button>
            <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
            <button class="btn" id="btnSave" onclick="saveChore()">Create Chore</button>
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();

// ── STATE ──
let chores = [];
let historyMap = {};       // choreName -> { lastRun, duration, status }
let allProcesses = [];
let editingChoreName = null;  // null = create mode
let tasks = [];            // { processName, parameters: [{Name,Value,Type}] }
let sortCol = 'Name';
let sortDir = 1;

// ── SVGs ──
const svgPlay = '<svg viewBox="0 0 16 16"><path d="M3 2l10 6-10 6V2z"/></svg>';
const svgEdit = '<svg viewBox="0 0 16 16"><path d="M13.23 1h-1.46L3.52 9.25l-.16.22L1 13.59 2.41 15l4.12-2.36.22-.16L15 4.23V2.77L13.23 1zM2.41 13.59l1.51-3 1.45 1.45-2.96 1.55zm3.83-2.06L4.47 9.76 11.69 2.5 13.5 4.31 6.24 11.53z"/></svg>';
const svgUp = '<svg viewBox="0 0 16 16"><path d="M8 3l5 5H3z"/></svg>';
const svgDown = '<svg viewBox="0 0 16 16"><path d="M8 13l5-5H3z"/></svg>';
const svgRemove = '<svg viewBox="0 0 16 16"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.708.708L7.293 8l-3.647 3.646.708.708L8 8.707z"/></svg>';

// ── INIT ──
window.addEventListener('message', e => {
    const msg = e.data;
    console.log('[ChoreManager UI] Received:', msg.command, msg);
    switch (msg.command) {
        case 'choresLoaded':
            chores = msg.chores || [];
            renderTable();
            // Load history AFTER chores are rendered (TM1 sessions are single-threaded)
            loadHistory();
            break;
        case 'historyLoaded':
            parseHistory(msg.logs || []);
            renderTable();
            break;
        case 'toggleDone':
            updateLocalChore(msg.choreName, { Active: msg.active });
            renderTable();
            break;
        case 'executeDone':
            showToast('Chore "' + msg.choreName + '" triggered successfully.');
            loadHistory();
            break;
        case 'processesLoaded':
            allProcesses = msg.processes || [];
            populateProcessDropdown();
            break;
        case 'processParamsLoaded':
            onParamsLoaded(msg.processName, msg.parameters || []);
            break;
        case 'choreDetailLoaded':
            onChoreDetailLoaded(msg.chore);
            break;
        case 'saveDone':
            closeModal();
            refreshAll();
            showToast(editingChoreName ? 'Chore updated.' : 'Chore created.');
            break;
        case 'deleteDone':
            closeModal();
            chores = chores.filter(c => c.Name !== msg.choreName);
            renderTable();
            showToast('Chore "' + msg.choreName + '" deleted.');
            break;
        case 'error':
            showToast('Error: ' + msg.message, true);
            // Clear loading state if chores haven't loaded yet
            if (chores.length === 0) {
                document.getElementById('choreTableBody').innerHTML =
                    '<tr><td colspan="9" class="empty-msg">Failed to load chores. Click Refresh to retry.</td></tr>';
            }
            break;
    }
});

// Boot
console.log('[ChoreManager UI] Boot - sending getChores');
refreshAll();

function refreshAll() {
    console.log('[ChoreManager UI] refreshAll called');
    vscode.postMessage({ command: 'getChores' });
    // History is loaded after choresLoaded arrives (sequential to avoid TM1 session blocking)
}

// ── HISTORY ──
function loadHistory() {
    const hours = parseInt(document.getElementById('logRange').value, 10);
    const since = new Date(Date.now() - hours * 3600000).toISOString();
    historyMap = {};
    vscode.postMessage({ command: 'getChoreHistory', since });
}

function parseHistory(logs) {
    // Build map: choreName -> { lastRun (Date string), duration (ms), status }
    // TM1 log messages come in various formats:
    //   Chore "name" finished successfully / Chore "name" has started / etc.
    console.log('[ChoreManager] parseHistory: received ' + logs.length + ' log entries');
    const starts = {};
    const ends = {};
    for (const log of logs) {
        const msg = log.Message || '';
        const ts = log.TimeStamp;
        // Try multiple patterns for chore name extraction
        let name = null;
        const patterns = [
            /[Cc]hore\\s+["\\u201C]([^"\\u201D]+)["\\u201D]/,  // Chore "name" or Chore \u201Cname\u201D
            /[Cc]hore\\s+'([^']+)'/,                              // Chore 'name'
            /[Cc]hore\\s+\\\\"([^"]+)\\\\"/,                     // Chore \\"name\\"
            /chore\\s*[:\\-]\\s*"?([^"\\n,]+)"?/i,               // chore: name or chore - name
            /[Cc]hore\\s+(\\S+)/,                                  // Chore name (unquoted, single word)
        ];
        for (const pat of patterns) {
            const m = msg.match(pat);
            if (m) { name = m[1].trim(); break; }
        }
        if (!name) {
            console.log('[ChoreManager] parseHistory: no chore name matched in: ' + msg);
            continue;
        }

        if (!historyMap[name]) historyMap[name] = {};

        // Classify message — check most specific patterns first
        const msgLower = msg.toLowerCase();
        if (/finish|completed|succeeded|success/i.test(msg)) {
            historyMap[name].status = 'success';
            if (!ends[name]) ends[name] = ts;
            if (!historyMap[name].lastRun) historyMap[name].lastRun = ts;
        } else if (/abort|fail|error|quit|cancel/i.test(msg)) {
            if (/minor/i.test(msg)) {
                historyMap[name].status = 'warning';
            } else {
                historyMap[name].status = 'error';
            }
            if (!ends[name]) ends[name] = ts;
            if (!historyMap[name].lastRun) historyMap[name].lastRun = ts;
        } else if (/start|begin|trigger|initiat|launch/i.test(msg)) {
            if (!starts[name]) starts[name] = ts;
            if (!historyMap[name].lastRun) historyMap[name].lastRun = ts;
        } else if (/execut/i.test(msg)) {
            // "executed" can mean finished; treat as end if no other end recorded
            if (!ends[name]) ends[name] = ts;
            if (!historyMap[name].status) historyMap[name].status = 'success';
            if (!historyMap[name].lastRun) historyMap[name].lastRun = ts;
        } else {
            // Unknown message type — still record as activity
            if (!historyMap[name].lastRun) historyMap[name].lastRun = ts;
        }
    }
    // Calculate durations
    for (const name in historyMap) {
        const h = historyMap[name];
        if (starts[name] && ends[name]) {
            h.duration = Math.abs(new Date(ends[name]).getTime() - new Date(starts[name]).getTime());
        }
    }
    console.log('[ChoreManager] parseHistory result:', JSON.stringify(historyMap));
}

function updateLocalChore(name, updates) {
    const c = chores.find(ch => ch.Name === name);
    if (c) Object.assign(c, updates);
}

// ── ISO 8601 DURATION HELPERS ──
function parseDuration(iso) {
    if (!iso) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
    const m = iso.match(/P(?:(\\d+)D)?T?(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)S)?/i);
    if (!m) return { days: 0, hours: 0, minutes: 0, seconds: 0 };
    return {
        days:    parseInt(m[1] || '0', 10),
        hours:   parseInt(m[2] || '0', 10),
        minutes: parseInt(m[3] || '0', 10),
        seconds: parseInt(m[4] || '0', 10)
    };
}

function buildDuration(d, h, m, s) {
    let r = 'P';
    if (d > 0) r += d + 'D';
    if (h > 0 || m > 0 || s > 0) {
        r += 'T';
        if (h > 0) r += h + 'H';
        if (m > 0) r += m + 'M';
        if (s > 0) r += s + 'S';
    }
    return r === 'P' ? 'PT0S' : r;
}

function formatDuration(iso) {
    const d = parseDuration(iso);
    const parts = [];
    if (d.days) parts.push(d.days + 'd');
    if (d.hours) parts.push(d.hours + 'h');
    if (d.minutes) parts.push(d.minutes + 'm');
    if (d.seconds) parts.push(d.seconds + 's');
    return parts.length ? parts.join(' ') : '–';
}

function formatMs(ms) {
    if (!ms || ms < 0) return '–';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    const h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
}

function formatDateTime(iso) {
    if (!iso) return '–';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }) +
            ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
}

function computeNextRun(startTime, deltaTime, active) {
    if (!active || !startTime || !deltaTime) return '–';
    try {
        const start = new Date(startTime).getTime();
        const d = parseDuration(deltaTime);
        const intervalMs = ((d.days * 24 + d.hours) * 3600 + d.minutes * 60 + d.seconds) * 1000;
        if (intervalMs <= 0) return '–';
        const now = Date.now();
        if (start > now) return formatDateTime(new Date(start).toISOString());
        const elapsed = now - start;
        const periods = Math.ceil(elapsed / intervalMs);
        const next = new Date(start + periods * intervalMs);
        return formatDateTime(next.toISOString());
    } catch { return '–'; }
}

// ── SORTING ──
function sortBy(col) {
    if (sortCol === col) sortDir *= -1;
    else { sortCol = col; sortDir = 1; }
    renderTable();
}

function getSortValue(chore, col) {
    switch (col) {
        case 'Active': return chore.Active ? 1 : 0;
        case 'Name': return (chore.Name || '').toLowerCase();
        case 'Frequency': return chore.Frequency || '';
        case 'NextRun': {
            const st = chore.StartTime;
            const startTimeValue = st && typeof st === 'object' ? st.value || st : st;
            return computeNextRun(startTimeValue, chore.Frequency || '', chore.Active);
        }
        case 'LastRun': return (historyMap[chore.Name] && historyMap[chore.Name].lastRun) || '';
        case 'LastStatus': {
            const h = historyMap[chore.Name];
            if (!h) return '';
            return h.status || '';
        }
        default: return '';
    }
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── RENDER TABLE ──
function renderTable() {
    const search = (document.getElementById('searchInput').value || '').toLowerCase();
    let filtered = chores;
    if (search) {
        filtered = chores.filter(c => c.Name.toLowerCase().includes(search));
    }

    // Sort
    filtered.sort((a, b) => {
        let va = getSortValue(a, sortCol);
        let vb = getSortValue(b, sortCol);
        if (typeof va === 'string') {
            return va.localeCompare(vb) * sortDir;
        }
        return ((va > vb ? 1 : va < vb ? -1 : 0)) * sortDir;
    });

    // Update sort arrows
    document.querySelectorAll('.sort-arrow').forEach(el => el.textContent = '');
    const arrowEl = document.getElementById('sort_' + sortCol);
    if (arrowEl) arrowEl.textContent = sortDir > 0 ? '▲' : '▼';

    if (filtered.length === 0) {
        document.getElementById('choreTableBody').innerHTML =
            '<tr><td colspan="9" class="empty-msg">No chores found.</td></tr>';
        return;
    }

    const rows = filtered.map(c => {
        const st = c.StartTime;
        const startTimeValue = st && typeof st === 'object' ? st.value || st : st;
        const dt = c.Frequency || '';
        const hist = historyMap[c.Name] || {};
        const statusBadge = hist.status === 'success'
            ? '<span class="badge badge-success">Success</span>'
            : hist.status === 'warning'
            ? '<span class="badge badge-warning">Minor Errors</span>'
            : hist.status === 'error'
            ? '<span class="badge badge-error">Aborted</span>'
            : '<span style="color:var(--vscode-descriptionForeground)">–</span>';

        const execMode = c.ExecutionMode || '';
        const modeLabel = execMode === 'SingleCommit' ? 'Single' : execMode === 'MultipleCommit' ? 'Multiple' : execMode;

        return '<tr>' +
            '<td><label class="toggle"><input type="checkbox" ' + (c.Active ? 'checked' : '') + ' onchange="toggleChore(\\'' + escapeHtml(c.Name) + '\\', this.checked)"><span class="slider"></span></label></td>' +
            '<td class="chore-name-cell">' + escapeHtml(c.Name) + '</td>' +
            '<td>' + escapeHtml(formatDuration(dt)) + '<br><span style="font-size:11px;color:var(--vscode-descriptionForeground)">' + escapeHtml(formatDateTime(startTimeValue)) + '</span></td>' +
            '<td>' + escapeHtml(computeNextRun(startTimeValue, dt, c.Active)) + '</td>' +
            '<td>' + escapeHtml(hist.lastRun ? formatDateTime(hist.lastRun) : '–') + '</td>' +
            '<td>' + escapeHtml(formatMs(hist.duration)) + '</td>' +
            '<td>' + statusBadge + '</td>' +
            '<td><span class="badge badge-info">' + escapeHtml(modeLabel) + '</span></td>' +
            '<td class="actions-cell">' +
                '<button class="btn-icon" title="Execute now" onclick="triggerChore(\\'' + escapeHtml(c.Name) + '\\')">' + svgPlay + '</button>' +
                '<button class="btn-icon" title="Edit" onclick="openEditModal(\\'' + escapeHtml(c.Name) + '\\')">' + svgEdit + '</button>' +
            '</td>' +
        '</tr>';
    }).join('');

    document.getElementById('choreTableBody').innerHTML = rows;
}

function applyFilters() { renderTable(); }

// ── ACTIONS ──
function toggleChore(name, active) {
    vscode.postMessage({ command: 'toggleActive', choreName: name, active });
}

function triggerChore(name) {
    vscode.postMessage({ command: 'executeChore', choreName: name });
}

// ── MODAL ──
function switchTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab_' + tab).classList.add('active');
    event.target.classList.add('active');
}

function openCreateModal() {
    editingChoreName = null;
    tasks = [];
    document.getElementById('modalTitle').textContent = 'New Chore';
    document.getElementById('btnSave').textContent = 'Create Chore';
    document.getElementById('btnDeleteChore').style.display = 'none';
    document.getElementById('choreName').value = '';
    document.getElementById('choreName').disabled = false;
    document.getElementById('choreExecMode').value = 'SingleCommit';
    document.getElementById('choreStartTime').value = toLocalISO(new Date());
    document.getElementById('freqDays').value = 0;
    document.getElementById('freqHours').value = 1;
    document.getElementById('freqMinutes').value = 0;
    document.getElementById('freqSeconds').value = 0;
    document.getElementById('choreActive').checked = true;
    renderTasks();
    // Switch to first tab
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.tab-btn').classList.add('active');
    document.getElementById('tab_settings').classList.add('active');
    document.getElementById('choreModal').classList.add('open');
    // Load processes list
    vscode.postMessage({ command: 'getProcesses' });
}

function openEditModal(name) {
    editingChoreName = name;
    const chore = chores.find(c => c.Name === name);
    if (!chore) return;

    document.getElementById('modalTitle').textContent = 'Edit Chore: ' + name;
    document.getElementById('btnSave').textContent = 'Save Changes';
    document.getElementById('btnDeleteChore').style.display = 'inline-block';
    document.getElementById('choreName').value = chore.Name;
    document.getElementById('choreName').disabled = true;
    document.getElementById('choreExecMode').value = chore.ExecutionMode || 'SingleCommit';
    document.getElementById('choreActive').checked = !!chore.Active;

    // Start time
    const st = chore.StartTime;
    const startVal = st && typeof st === 'object' ? st.value || st : st;
    if (startVal) {
        document.getElementById('choreStartTime').value = toLocalISO(new Date(startVal));
    }

    // Frequency
    const freq = parseDuration(chore.Frequency || '');
    document.getElementById('freqDays').value = freq.days;
    document.getElementById('freqHours').value = freq.hours;
    document.getElementById('freqMinutes').value = freq.minutes;
    document.getElementById('freqSeconds').value = freq.seconds;

    // Load tasks from expanded data or fetch detail
    if (chore.Tasks && chore.Tasks.length > 0) {
        tasks = chore.Tasks.map(t => ({
            processName: t.Process ? t.Process.Name : '',
            parameters: (t.Parameters || []).map(p => ({
                Name: p.Name,
                Value: p.Value !== undefined ? p.Value : '',
                Type: p.Type
            }))
        }));
    } else {
        tasks = [];
        // Fetch full chore detail including tasks
        vscode.postMessage({ command: 'getChoreDetail', choreName: name });
    }

    renderTasks();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelector('.tab-btn').classList.add('active');
    document.getElementById('tab_settings').classList.add('active');
    document.getElementById('choreModal').classList.add('open');
    vscode.postMessage({ command: 'getProcesses' });
}

function onChoreDetailLoaded(chore) {
    if (!chore || !editingChoreName) return;
    // Update the in-memory chore with full data
    const idx = chores.findIndex(c => c.Name === chore.Name);
    if (idx >= 0) chores[idx] = chore;

    if (chore.Tasks && chore.Tasks.length > 0) {
        tasks = chore.Tasks.map(t => ({
            processName: t.Process ? t.Process.Name : '',
            parameters: (t.Parameters || []).map(p => ({
                Name: p.Name,
                Value: p.Value !== undefined ? p.Value : '',
                Type: p.Type
            }))
        }));
        renderTasks();
    }
}

function closeModal() {
    document.getElementById('choreModal').classList.remove('open');
    editingChoreName = null;
    tasks = [];
}

function toLocalISO(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// ── TASK MANAGEMENT ──
function populateProcessDropdown() {
    const dd = document.getElementById('processDropdown');
    dd.innerHTML = '<option value="">-- Select Process --</option>';
    for (const p of allProcesses) {
        dd.innerHTML += '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>';
    }
}

function addTask() {
    const dd = document.getElementById('processDropdown');
    const procName = dd.value;
    if (!procName) return;
    tasks.push({ processName: procName, parameters: [] });
    renderTasks();
    // Fetch parameters for this process
    vscode.postMessage({ command: 'getProcessParameters', processName: procName });
}

let pendingParamsIdx = -1;
function onParamsLoaded(processName, params) {
    // Find last task with this processName that has no params yet
    for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks[i].processName === processName && tasks[i].parameters.length === 0) {
            tasks[i].parameters = params.map(p => ({
                Name: p.Name,
                Value: p.Value !== undefined ? p.Value : '',
                Type: p.Type
            }));
            break;
        }
    }
    renderTasks();
}

function removeTask(idx) {
    tasks.splice(idx, 1);
    renderTasks();
}

function moveTask(idx, dir) {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= tasks.length) return;
    [tasks[idx], tasks[newIdx]] = [tasks[newIdx], tasks[idx]];
    renderTasks();
}

function updateParam(taskIdx, paramIdx, value) {
    tasks[taskIdx].parameters[paramIdx].Value = value;
}

function renderTasks() {
    const list = document.getElementById('taskList');
    if (tasks.length === 0) {
        list.innerHTML = '<div class="empty-msg" style="padding:20px;">No processes added yet.</div>';
        return;
    }
    let html = '';
    tasks.forEach((t, i) => {
        html += '<div class="task-item">' +
            '<span class="task-num">' + (i + 1) + '</span>' +
            '<span class="task-name">' + escapeHtml(t.processName) + '</span>' +
            '<span class="task-actions">' +
                '<button class="btn-icon" title="Move up" onclick="moveTask(' + i + ',-1)" ' + (i === 0 ? 'disabled style="opacity:0.3"' : '') + '>' + svgUp + '</button>' +
                '<button class="btn-icon" title="Move down" onclick="moveTask(' + i + ',1)" ' + (i === tasks.length - 1 ? 'disabled style="opacity:0.3"' : '') + '>' + svgDown + '</button>' +
                '<button class="btn-icon" title="Remove" onclick="removeTask(' + i + ')">' + svgRemove + '</button>' +
            '</span>' +
        '</div>';
        if (t.parameters && t.parameters.length > 0) {
            html += '<div class="task-params">';
            t.parameters.forEach((p, pi) => {
                const inputType = (p.Type === 1 || p.Type === 'Numeric') ? 'number' : 'text';
                html += '<div class="param-row">' +
                    '<span class="param-name">' + escapeHtml(p.Name) + '</span>' +
                    '<input type="' + inputType + '" value="' + escapeHtml(String(p.Value)) + '" onchange="updateParam(' + i + ',' + pi + ',this.value)">' +
                '</div>';
            });
            html += '</div>';
        }
    });
    list.innerHTML = html;
}

// ── SAVE ──
function saveChore() {
    const name = document.getElementById('choreName').value.trim();
    if (!name) { showToast('Please enter a chore name.', true); return; }

    const startTimeStr = document.getElementById('choreStartTime').value;
    const freqD = parseInt(document.getElementById('freqDays').value, 10) || 0;
    const freqH = parseInt(document.getElementById('freqHours').value, 10) || 0;
    const freqM = parseInt(document.getElementById('freqMinutes').value, 10) || 0;
    const freqS = parseInt(document.getElementById('freqSeconds').value, 10) || 0;

    if (freqD === 0 && freqH === 0 && freqM === 0 && freqS === 0) {
        showToast('Please set a frequency greater than 0.', true); return;
    }

    const body = {
        Name: name,
        Active: document.getElementById('choreActive').checked,
        StartTime: { value: new Date(startTimeStr).toISOString() },
        Frequency: buildDuration(freqD, freqH, freqM, freqS),
        ExecutionMode: document.getElementById('choreExecMode').value,
        Tasks: tasks.map((t, i) => ({
            Step: i,
            Process: { '@odata.bind': "Processes('" + encodeURIComponent(t.processName) + "')" },
            Parameters: t.parameters.map(p => ({
                Name: p.Name,
                Value: (p.Type === 1 || p.Type === 'Numeric') ? (parseFloat(p.Value) || 0) : String(p.Value)
            }))
        }))
    };

    if (editingChoreName) {
        delete body.Name;
        vscode.postMessage({ command: 'updateChore', choreName: editingChoreName, body });
    } else {
        vscode.postMessage({ command: 'createChore', body });
    }
}

function confirmDeleteChore() {
    if (!editingChoreName) return;
    if (confirm('Delete chore "' + editingChoreName + '"? This cannot be undone.')) {
        vscode.postMessage({ command: 'deleteChore', choreName: editingChoreName });
    }
}

// ── TOAST ──
function showToast(msg, isError) {
    let t = document.getElementById('toastEl');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toastEl';
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;padding:10px 18px;border-radius:6px;font-size:13px;z-index:200;transition:opacity 0.3s;';
        document.body.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = isError ? 'var(--vscode-errorForeground)' : 'var(--vscode-button-background)';
    t.style.color = isError ? '#fff' : 'var(--vscode-button-foreground)';
    t.style.opacity = '1';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.style.opacity = '0'; }, 4000);
}
</script>
</body>
</html>`;
    }
}

import * as vscode from 'vscode';

export class InstanceHubPanel {
    private static panels: Map<string, InstanceHubPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private readonly _environmentName: string;
    private readonly _serverRealName: string;

    private constructor(panel: vscode.WebviewPanel, instanceName: string, environmentName: string, serverRealName: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._environmentName = environmentName;
        this._serverRealName = serverRealName;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(
            async message => {
                if (message.command === 'action') {
                    switch (message.action) {
                        case 'searchProcesses':
                            vscode.commands.executeCommand('pa-code.searchProcesses', this._getTreeItemStub());
                            break;
                        case 'createProcess':
                            vscode.commands.executeCommand('pa-code.createProcess', this._getFolderStub());
                            break;
                        case 'pullAll':
                            vscode.commands.executeCommand('pa-code.syncFromTM1', this._getTreeItemStub());
                            break;
                        case 'serverLog':
                            vscode.commands.executeCommand('pa-code.viewLog', this._getTreeItemStub());
                            break;
                        case 'threadViewer':
                            vscode.commands.executeCommand('pa-code.viewThreads', this._getTreeItemStub());
                            break;
                        case 'deployment':
                            vscode.commands.executeCommand('pa-code.deploymentAssistant');
                            break;
                        case 'bulkDelete':
                            vscode.commands.executeCommand('pa-code.bulkDelete', this._getTreeItemStub());
                            break;
                        case 'securityManager':
                            vscode.commands.executeCommand('pa-code.securityPanel', this._getTreeItemStub());
                            break;
                        case 'mdxWizard':
                            vscode.commands.executeCommand('pa-code.mdxWizard', this._getTreeItemStub());
                            break;
                        case 'choreManager':
                            vscode.commands.executeCommand('pa-code.choreManager', this._getTreeItemStub());
                            break;
                        case 'serverConfig':
                            vscode.commands.executeCommand('pa-code.manageConfiguration', this._getTreeItemStub());
                            break;
                        case 'fileManager':
                            vscode.commands.executeCommand('pa-code.fileManager', this._getTreeItemStub());
                            break;
                        case 'disconnect':
                            vscode.commands.executeCommand('pa-code.disconnectTM1', this._getTreeItemStub());
                            this._panel.dispose();
                            break;
                    }
                }
            },
            null,
            this._disposables
        );
    }

    private _getTreeItemStub(): any {
        return {
            type: 'instance',
            environmentName: this._environmentName,
            instanceName: this._instanceName,
            contextValue: 'tm1instance_connected'
        };
    }

    private _getFolderStub(): any {
        return {
            type: 'folder',
            environmentName: this._environmentName,
            instanceName: this._instanceName,
            contextValue: 'folder_processes'
        };
    }

    public static render(instanceName: string, environmentName: string, serverRealName: string) {
        const columnToShowIn = vscode.ViewColumn.One;

        const existing = InstanceHubPanel.panels.get(instanceName);
        if (existing) {
            existing._panel.reveal(columnToShowIn);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'tm1InstanceHub',
            `${serverRealName}`,
            columnToShowIn,
            { enableScripts: true }
        );

        InstanceHubPanel.panels.set(instanceName, new InstanceHubPanel(panel, instanceName, environmentName, serverRealName));
    }

    public dispose() {
        InstanceHubPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) {
            const d = this._disposables.pop();
            if (d) d.dispose();
        }
    }

    private _getWebviewContent(): string {
        const svg = {
            search: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-400q75 0 127.5-52.5T560-580q0-75-52.5-127.5T380-760q-75 0-127.5 52.5T200-580q0 75 52.5 127.5T380-400Z"/></svg>',
            add: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z"/></svg>',
            download: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M260-160q-91 0-155.5-63T40-377q0-78 47-139t123-78q17-72 85-137t145-65q33 0 56.5 23.5T520-716v242l64-62 56 56-160 160-160-160 56-56 64 62v-242q-76 14-118 73.5T280-520h-20q-58 0-99 41t-41 99q0 58 41 99t99 41h480q42 0 71-29t29-71q0-42-29-71t-71-29h-60v-80q0-48-22-89.5T600-680v-93q74 35 117 103.5T760-520q69 8 114.5 59.5T920-340q0 75-52.5 127.5T740-160H260Zm220-358Z"/></svg>',
            log: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M320-240h320v-80H320v80Zm0-160h320v-80H320v80ZM240-80q-33 0-56.5-23.5T160-160v-640q0-33 23.5-56.5T240-880h320l240 240v480q0 33-23.5 56.5T720-80H240Zm280-520v-200H240v640h480v-440H520ZM240-800v200-200 640-640Z"/></svg>',
            threads: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M300-720q-25 0-42.5 17.5T240-660q0 25 17.5 42.5T300-600q25 0 42.5-17.5T360-660q0-25-17.5-42.5T300-720Zm0 400q-25 0-42.5 17.5T240-260q0 25 17.5 42.5T300-200q25 0 42.5-17.5T360-260q0-25-17.5-42.5T300-320ZM160-840h640q17 0 28.5 11.5T840-800v280q0 17-11.5 28.5T800-480H160q-17 0-28.5-11.5T120-520v-280q0-17 11.5-28.5T160-840Zm40 80v200h560v-200H200Zm-40 320h640q17 0 28.5 11.5T840-400v280q0 17-11.5 28.5T800-80H160q-17 0-28.5-11.5T120-120v-280q0-17 11.5-28.5T160-440Zm40 80v200h560v-200H200Zm0-400v200-200Zm0 400v200-200Z"/></svg>',
            config: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z"/></svg>',
            deploy: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="m226-559 78 33q14-28 29-54t33-52l-56-11-84 84Zm142 83 114 113q42-16 90-49t90-75q70-70 109.5-155.5T806-800q-72-5-158 34.5T492-656q-42 42-75 90t-49 90Zm178-65q-23-23-23-56.5t23-56.5q23-23 57-23t57 23q23 23 23 56.5T660-541q-23 23-57 23t-57-23Zm19 321 84-84-11-56q-26 18-52 32.5T532-299l33 79Zm313-653q19 121-23.5 235.5T708-419l20 99q4 20-2 39t-20 33L538-80l-84-197-171-171-197-84 167-168q14-14 33.5-20t39.5-2l99 20q104-104 218-147t235-24ZM157-321q35-35 85.5-35.5T328-322q35 35 34.5 85.5T327-151q-25 25-83.5 43T82-76q14-103 32-161.5t43-83.5Zm57 56q-10 10-20 36.5T180-175q27-4 53.5-13.5T270-208q12-12 13-29t-11-29q-12-12-29-11.5T214-265Z"/></svg>',
            bulkDelete: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M280-120q-33 0-56.5-23.5T200-200v-520h-40v-80h200v-40h240v40h200v80h-40v520q0 33-23.5 56.5T680-120H280Zm400-600H280v520h400v-520ZM360-280h80v-360h-80v360Zm160 0h80v-360h-80v360ZM280-720v520-520Z"/></svg>',
            security: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M480-80q-139-35-229.5-159.5T160-516v-244l320-120 320 120v244q0 152-90.5 276.5T480-80Zm0-84q97-30 162-118.5T718-480H480v-315l-240 90v207q0 7 2 18h238v316Z"/></svg>',
            fileManager: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/></svg>',
            disconnect: '<svg xmlns="http://www.w3.org/2000/svg" height="28" viewBox="0 -960 960 960" width="28" fill="white"><path d="M440-440v-400h80v400h-80Zm40 320q-74 0-139.5-28.5T226-226q-49-49-77.5-114.5T120-480q0-80 33-151t93-123l56 56q-48 40-75 97t-27 121q0 116 82 198t198 82q117 0 198.5-82T760-480q0-64-26.5-121T658-698l56-56q60 52 93 123t33 151q0 74-28.5 139.5t-77 114.5q-48.5 49-114 77.5T480-120Z"/></svg>'
        };

        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this._serverRealName}</title>
<style>
    body {
        padding: 20px 30px;
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
    }
    .header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 28px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--vscode-widget-border);
    }
    .header .dot {
        width: 12px; height: 12px; border-radius: 50%;
        background: #4ec94e; flex-shrink: 0;
    }
    .header h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .header .env {
        color: var(--vscode-descriptionForeground);
        font-size: 13px; margin-left: auto;
    }
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 14px;
    }
    .tile {
        display: flex; align-items: center; gap: 14px;
        padding: 16px 18px; border-radius: 8px;
        background: var(--vscode-sideBar-background);
        border: 1px solid var(--vscode-widget-border);
        cursor: pointer; user-select: none;
        transition: background 0.15s, border-color 0.15s;
    }
    .tile:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
    }
    .tile:active { transform: scale(0.98); }
    .tile .icon {
        flex-shrink: 0; width: 28px; height: 28px;
        display: flex; align-items: center; justify-content: center;
    }
    .tile .info { display: flex; flex-direction: column; }
    .tile .title { font-size: 14px; font-weight: 600; }
    .tile .shortcut {
        font-size: 11px; margin-top: 3px;
        color: var(--vscode-descriptionForeground);
    }
    .section-label {
        font-size: 11px; text-transform: uppercase; letter-spacing: 1px;
        color: var(--vscode-descriptionForeground);
        margin: 24px 0 10px 2px; font-weight: 600;
    }
    .section-label:first-of-type { margin-top: 0; }
    .tile.danger { border-color: var(--vscode-errorForeground); }
    .tile.danger:hover { background: rgba(255,80,80,0.1); }
</style>
</head>
<body>
    <div class="header">
        <span class="dot"></span>
        <h1>${this._serverRealName}</h1>
        <span class="env">${this._environmentName}</span>
    </div>

    <div class="section-label">Develop</div>
    <div class="grid">
        <div class="tile" onclick="send('searchProcesses')">
            <span class="icon">${svg.search}</span>
            <div class="info">
                <span class="title">Search Processes</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+F' : 'Ctrl+Alt+F'}</span>
            </div>
        </div>
        <div class="tile" onclick="send('createProcess')">
            <span class="icon">${svg.add}</span>
            <div class="info">
                <span class="title">New Process</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+N' : 'Ctrl+Alt+N'}</span>
            </div>
        </div>
        <div class="tile" onclick="send('pullAll')">
            <span class="icon">${svg.download}</span>
            <div class="info">
                <span class="title">Pull All from Server</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+P' : 'Ctrl+Alt+P'}</span>
            </div>
        </div>
    </div>

    <div class="section-label">Monitor</div>
    <div class="grid">
        <div class="tile" onclick="send('serverLog')">
            <span class="icon">${svg.log}</span>
            <div class="info">
                <span class="title">Server Log</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+L' : 'Ctrl+Alt+L'}</span>
            </div>
        </div>
        <div class="tile" onclick="send('threadViewer')">
            <span class="icon">${svg.threads}</span>
            <div class="info">
                <span class="title">Thread Viewer</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+T' : 'Ctrl+Alt+T'}</span>
            </div>
        </div>
        <!-- File Manager tile hidden for now
        <div class="tile" onclick="send('fileManager')">
            <span class="icon">\${svg.fileManager}</span>
            <div class="info">
                <span class="title">File Manager</span>
            </div>
        </div>
        -->
        <div class="tile" onclick="send('serverConfig')">
            <span class="icon">${svg.config}</span>
            <div class="info">
                <span class="title">Server Configuration</span>
            </div>
        </div>
    </div>

    <div class="section-label">Deploy</div>
    <div class="grid">
        <div class="tile" onclick="send('deployment')">
            <span class="icon">${svg.deploy}</span>
            <div class="info">
                <span class="title">Deployment Assistant</span>
                <span class="shortcut">${process.platform === 'darwin' ? '⌘+⌥+D' : 'Ctrl+Alt+D'}</span>
            </div>
        </div>
        <div class="tile" onclick="send('bulkDelete')">
            <span class="icon">${svg.bulkDelete}</span>
            <div class="info">
                <span class="title">Bulk Delete</span>
            </div>
        </div>
    </div>

    <div class="section-label">Administration</div>
    <div class="grid">
        <div class="tile" onclick="send('securityManager')">
            <span class="icon">${svg.security}</span>
            <div class="info">
                <span class="title">Security Manager</span>
            </div>
        </div>
        <div class="tile" onclick="send('mdxWizard')">
            <span class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg></span>
            <div class="info">
                <span class="title">MDX Wizard</span>
            </div>
        </div>
        <div class="tile" onclick="send('choreManager')">
            <span class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="white"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg></span>
            <div class="info">
                <span class="title">Chore Manager</span>
            </div>
        </div>
    </div>

    <div class="section-label">Connection</div>
    <div class="grid">
        <div class="tile danger" onclick="send('disconnect')">
            <span class="icon">${svg.disconnect}</span>
            <div class="info">
                <span class="title">Disconnect</span>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function send(action) {
            vscode.postMessage({ command: 'action', action });
        }
    </script>
</body>
</html>`;
    }
}

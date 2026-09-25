import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export class DeploymentPanel {
    public static currentPanel: DeploymentPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(async message => {
            switch (message.command) {
                case 'init':
                    await this._sendInit();
                    return;
                case 'loadObjects':
                    await this._loadObjects(message.instanceName, message.objectType);
                    return;
                case 'loadFromLog':
                    await this._loadFromLog();
                    return;
                case 'checkObjects':
                    await this._checkObjects(message.sourceInstance, message.targetInstance, message.objects);
                    return;
                case 'compare':
                    await this._compareObjects(message.sourceInstance, message.targetInstance, message.objectName, message.objectType);
                    return;
                case 'deploy':
                    await this._deploy(message.sourceInstance, message.targetInstance, message.objects);
                    return;
                case 'getSettings':
                    this._sendSettings();
                    return;
                case 'updateSetting':
                    await this._updateSetting(message.key, message.value);
                    return;
            }
        }, null, this._disposables);
    }

    public static render() {
        if (DeploymentPanel.currentPanel) {
            DeploymentPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1Deployment', 'TM1 Deployment Assistant', vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DeploymentPanel.currentPanel = new DeploymentPanel(panel);
    }

    private async _sendInit() {
        const config = ConfigManager.getConfig();
        const environments = (config.environments || []).map((e: any) => e.name);
        const connectedInstances = TM1Service.getInstance().getConnectedInstanceNames();
        this._panel.webview.postMessage({ command: 'init', environments, connectedInstances });
    }

    private async _loadObjects(instanceName: string, objectType: string) {
        try {
            let names: string[] = [];
            if (objectType === 'process') {
                const procs = await TM1Service.getInstance().getProcesses(instanceName, 'all');
                names = procs.map(p => p.Name);
            } else {
                const cubes = await TM1Service.getInstance().getCubes(instanceName, 'all');
                names = cubes.map(c => c.Name);
            }
            this._panel.webview.postMessage({ command: 'objectList', names, objectType });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Failed to load objects: ${err.message}` });
        }
    }

    /**
     * Lets the user pick an existing transport log (or a saved list) and loads its
     * objects into the deploy list — reusing the artefact pa-code already writes,
     * instead of a separate list format. Ideal for re-deploying the same set or
     * promoting it to the next environment.
     */
    private async _loadFromLog() {
        try {
            const config = vscode.workspace.getConfiguration('pa-code');
            const logDir = config.get<string>('deployment.logDirectory', '');
            let defaultUri: vscode.Uri | undefined;
            if (logDir) {
                const resolved = logDir.startsWith('/') || logDir.includes(':') ? logDir :
                    vscode.workspace.workspaceFolders ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, logDir) : logDir;
                if (fs.existsSync(resolved)) defaultUri = vscode.Uri.file(resolved);
            }
            const picked = await vscode.window.showOpenDialog({
                canSelectMany: false,
                defaultUri,
                filters: { 'Transport log / list (JSON)': ['json'] },
                openLabel: 'Load objects'
            });
            if (!picked || picked.length === 0) return;

            const data = JSON.parse(fs.readFileSync(picked[0].fsPath, 'utf-8'));
            const rawObjects: any[] = Array.isArray(data.transports) ? data.transports
                : Array.isArray(data.objects) ? data.objects : [];
            const seen = new Set<string>();
            const objects = rawObjects
                .map(o => ({ name: o?.name, type: o?.type }))
                .filter(o => o.name && (o.type === 'process' || o.type === 'rule') && !seen.has(o.type + '|' + o.name) && seen.add(o.type + '|' + o.name));

            if (objects.length === 0) {
                vscode.window.showWarningMessage('No deployable objects (process/rule) were found in the selected file.');
                return;
            }
            this._panel.webview.postMessage({ command: 'logObjectsLoaded', objects, source: data.source || '', target: data.target || '' });
            vscode.window.showInformationMessage(`Loaded ${objects.length} object(s) from ${path.basename(picked[0].fsPath)}.`);
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to load objects: ${err.message}`);
        }
    }

    private async _checkObjects(sourceInstance: string, targetInstance: string, objects: { name: string; type: string }[]) {
        try {
            const results: { name: string; type: string; exists: boolean; added?: number; removed?: number; tabDiffs?: { [tab: string]: { added: number; removed: number } } }[] = [];
            const processes = objects.filter(o => o.type === 'process');
            const rules = objects.filter(o => o.type === 'rule');

            if (processes.length > 0) {
                const existing = await TM1Service.getInstance().getProcesses(targetInstance, 'all');
                const existingNames = new Set(existing.map(p => p.Name));
                for (const obj of processes) {
                    const exists = existingNames.has(obj.name);
                    let added: number | undefined;
                    let removed: number | undefined;
                    let tabDiffs: { [tab: string]: { added: number; removed: number } } | undefined;
                    if (exists) {
                        try {
                            const srcCode = await TM1Service.getInstance().getProcessCode(sourceInstance, obj.name);
                            const tgtCode = await TM1Service.getInstance().getProcessCode(targetInstance, obj.name);
                            const tabs = ['Prolog', 'Metadata', 'Data', 'Epilog'];
                            tabDiffs = {};
                            let totalAdded = 0;
                            let totalRemoved = 0;
                            for (const tab of tabs) {
                                const diff = this._computeLineDiff((srcCode as any)[tab] || '', (tgtCode as any)[tab] || '');
                                tabDiffs[tab] = diff;
                                totalAdded += diff.added;
                                totalRemoved += diff.removed;
                            }
                            added = totalAdded;
                            removed = totalRemoved;
                        } catch { /* ignore diff errors */ }
                    }
                    results.push({ name: obj.name, type: 'process', exists, added, removed, tabDiffs });
                }
            }

            if (rules.length > 0) {
                const existing = await TM1Service.getInstance().getCubes(targetInstance, 'all');
                const existingNames = new Set(existing.map(c => c.Name));
                for (const obj of rules) {
                    const exists = existingNames.has(obj.name);
                    let added: number | undefined;
                    let removed: number | undefined;
                    if (exists) {
                        try {
                            const srcText = await TM1Service.getInstance().getRuleContent(sourceInstance, obj.name);
                            const tgtText = await TM1Service.getInstance().getRuleContent(targetInstance, obj.name);
                            const diff = this._computeLineDiff(srcText, tgtText);
                            added = diff.added;
                            removed = diff.removed;
                        } catch { /* ignore diff errors */ }
                    }
                    results.push({ name: obj.name, type: 'rule', exists, added, removed });
                }
            }

            this._panel.webview.postMessage({ command: 'checkResults', results });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Failed to check target: ${err.message}` });
        }
    }

    /**
     * LCS-based line diff: count added and removed lines between source and target.
     */
    private _computeLineDiff(sourceText: string, targetText: string): { added: number; removed: number } {
        const srcLines = sourceText.split('\n');
        const tgtLines = targetText.split('\n');
        const n = srcLines.length;
        const m = tgtLines.length;

        // Compute LCS length using two-row DP (O(m) space)
        let prev = new Array(m + 1).fill(0);
        let curr = new Array(m + 1).fill(0);
        for (let i = 1; i <= n; i++) {
            for (let j = 1; j <= m; j++) {
                if (srcLines[i - 1] === tgtLines[j - 1]) {
                    curr[j] = prev[j - 1] + 1;
                } else {
                    curr[j] = Math.max(prev[j], curr[j - 1]);
                }
            }
            [prev, curr] = [curr, prev];
            curr.fill(0);
        }
        const lcsLen = prev[m];

        return {
            added: n - lcsLen,   // lines in source not in target
            removed: m - lcsLen  // lines in target not in source
        };
    }

    private async _compareObjects(sourceInstance: string, targetInstance: string, objectName: string, objectType: string) {
        try {
            let sourceText: string;
            let targetText: string;

            if (objectType === 'process') {
                const srcCode = await TM1Service.getInstance().getProcessCode(sourceInstance, objectName);
                const tgtCode = await TM1Service.getInstance().getProcessCode(targetInstance, objectName);
                sourceText = `#SECTION Prolog\n${srcCode.Prolog}\n#SECTION Metadata\n${srcCode.Metadata}\n#SECTION Data\n${srcCode.Data}\n#SECTION Epilog\n${srcCode.Epilog}\n#JSON_PROPERTIES\n${srcCode.PropertiesJSON}`;
                targetText = `#SECTION Prolog\n${tgtCode.Prolog}\n#SECTION Metadata\n${tgtCode.Metadata}\n#SECTION Data\n${tgtCode.Data}\n#SECTION Epilog\n${tgtCode.Epilog}\n#JSON_PROPERTIES\n${tgtCode.PropertiesJSON}`;
            } else {
                sourceText = await TM1Service.getInstance().getRuleContent(sourceInstance, objectName);
                targetText = await TM1Service.getInstance().getRuleContent(targetInstance, objectName);
            }

            const srcDoc = await vscode.workspace.openTextDocument({ content: sourceText, language: 'tm1' });
            const tgtDoc = await vscode.workspace.openTextDocument({ content: targetText, language: 'tm1' });

            const srcEnv = sourceInstance.split('_')[0];
            const tgtEnv = targetInstance.split('_')[0];
            await vscode.commands.executeCommand('vscode.diff', tgtDoc.uri, srcDoc.uri,
                `${objectName} — ${tgtEnv} (Target) ↔ ${srcEnv} (Source)`
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`Compare failed: ${err.message}`);
        }
    }

    private async _deploy(sourceInstance: string, targetInstance: string, objects: { name: string; type: string; exists: boolean }[]) {
        const results: any[] = [];

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Deploying objects...',
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < objects.length; i++) {
                const obj = objects[i];
                progress.report({ message: `(${i + 1}/${objects.length}) ${obj.name}`, increment: (100 / objects.length) });

                try {
                    if (obj.type === 'process') {
                        const srcCode = await TM1Service.getInstance().getProcessCode(sourceInstance, obj.name);
                        let previousCode: any = null;

                        if (obj.exists) {
                            previousCode = await TM1Service.getInstance().getProcessCode(targetInstance, obj.name);
                            await TM1Service.getInstance().updateProcessCode(targetInstance, obj.name, srcCode);
                        } else {
                            await TM1Service.getInstance().createProcess(targetInstance, obj.name);
                            await TM1Service.getInstance().updateProcessCode(targetInstance, obj.name, srcCode);
                        }
                        results.push({ name: obj.name, type: 'process', action: obj.exists ? 'updated' : 'created', success: true, previousCode, newCode: srcCode });
                    } else {
                        const srcRule = await TM1Service.getInstance().getRuleContent(sourceInstance, obj.name);
                        let previousRule: string | null = null;

                        if (obj.exists) {
                            previousRule = await TM1Service.getInstance().getRuleContent(targetInstance, obj.name);
                        }
                        await TM1Service.getInstance().updateRule(targetInstance, obj.name, srcRule);
                        results.push({ name: obj.name, type: 'rule', action: obj.exists ? 'updated' : 'created', success: true, previousCode: previousRule, newCode: srcRule });
                    }
                } catch (err: any) {
                    results.push({ name: obj.name, type: obj.type, action: 'failed', success: false, error: err.message });
                }
            }
        });

        this._saveTransportLog(sourceInstance, targetInstance, results);
        this._panel.webview.postMessage({ command: 'deployResults', results });

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        // Auto-pull: update local files on target instance for deployed objects
        if (succeeded > 0) {
            await this._autoPullDeployed(targetInstance, results.filter(r => r.success));
        }

        if (failed === 0) {
            vscode.window.showInformationMessage(`Deployment complete: ${succeeded} object(s) deployed successfully. Local files updated.`);
        } else {
            vscode.window.showWarningMessage(`Deployment complete: ${succeeded} succeeded, ${failed} failed.`);
        }
    }

    private _sendSettings() {
        const config = vscode.workspace.getConfiguration('pa-code');
        this._panel.webview.postMessage({
            command: 'settings',
            logEnabled: config.get<boolean>('deployment.logEnabled', false),
            logDirectory: config.get<string>('deployment.logDirectory', '')
        });
    }

    private async _updateSetting(key: string, value: any) {
        const config = vscode.workspace.getConfiguration('pa-code');
        const allowedKeys = ['deployment.logEnabled', 'deployment.logDirectory'];
        if (!allowedKeys.includes(key)) { return; }
        await config.update(key, value, vscode.ConfigurationTarget.Global);
        this._sendSettings();
    }

    private async _autoPullDeployed(targetInstance: string, deployedResults: any[]) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const rootPath = workspaceFolders[0].uri.fsPath;
        const config = ConfigManager.getConfig();

        // Parse instanceName: "environmentName_serverRealName"
        const envConfig = config.environments?.find((e: any) => targetInstance.startsWith(e.name + '_'));
        if (!envConfig) return;
        const serverRealName = targetInstance.substring(envConfig.name.length + 1);
        const baseDir = path.join(rootPath, envConfig.folder, serverRealName);

        for (const result of deployedResults) {
            try {
                if (result.type === 'process') {
                    const code = result.newCode;
                    const isControl = result.name.startsWith('}');
                    const targetDir = path.join(baseDir, isControl ? 'Control Processes' : 'Processes');
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                    const fileContent = `#SECTION Prolog\n${code.Prolog}\n\n#SECTION Metadata\n${code.Metadata}\n\n#SECTION Data\n${code.Data}\n\n#SECTION Epilog\n${code.Epilog}\n\n#JSON_PROPERTIES\n${code.PropertiesJSON}`;
                    fs.writeFileSync(path.join(targetDir, `${result.name}.ti`), fileContent, 'utf8');
                } else if (result.type === 'rule') {
                    const isControl = result.name.startsWith('}');
                    const targetDir = path.join(baseDir, isControl ? 'Control Rules' : 'Rules');
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                    fs.writeFileSync(path.join(targetDir, `${result.name}.rux`), result.newCode, 'utf8');
                }
            } catch {
                // Silent - don't break deployment flow for file write errors
            }
        }
    }

    private _saveTransportLog(sourceInstance: string, targetInstance: string, results: any[]) {
        const config = vscode.workspace.getConfiguration('pa-code');
        const logEnabled = config.get<boolean>('deployment.logEnabled', false);
        const logDir = config.get<string>('deployment.logDirectory', '');

        if (!logEnabled || !logDir) { return; }

        const resolvedDir = logDir.startsWith('/') || logDir.includes(':') ? logDir :
            vscode.workspace.workspaceFolders ? path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, logDir) : logDir;

        try {
            if (!fs.existsSync(resolvedDir)) {
                fs.mkdirSync(resolvedDir, { recursive: true });
            }

            const timestamp = new Date().toISOString();
            const safeTimestamp = timestamp.replace(/[:.]/g, '-');
            const logEntry = {
                timestamp,
                source: sourceInstance,
                target: targetInstance,
                transports: results.map(r => ({
                    name: r.name,
                    type: r.type,
                    action: r.action,
                    success: r.success,
                    error: r.error || null,
                    previousCode: r.previousCode || null,
                    newCode: r.newCode || null
                }))
            };

            const filePath = path.join(resolvedDir, `transport_${safeTimestamp}.json`);
            fs.writeFileSync(filePath, JSON.stringify(logEntry, null, 2), 'utf-8');
        } catch (err: any) {
            vscode.window.showWarningMessage(`Could not save transport log: ${err.message}`);
        }
    }

    public dispose() {
        DeploymentPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) { x.dispose(); }
        }
    }

    private _getWebviewContent(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>TM1 Deployment Assistant</title>
<style>
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 20px; margin: 0; }
    h2 { margin: 0 0 16px 0; display: flex; align-items: center; gap: 8px; }
    .step { background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-widget-border, #444); border-radius: 6px; padding: 20px; margin-bottom: 16px; }
    .step-header { font-size: 14px; font-weight: 600; margin-bottom: 12px; color: var(--vscode-textLink-foreground); }
    .step-disabled { opacity: 0.4; pointer-events: none; }
    .row { display: flex; gap: 24px; flex-wrap: wrap; }
    .col { flex: 1; min-width: 280px; }
    .col h3 { margin: 0 0 8px 0; font-size: 13px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.5px; }
    label { display: block; font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; margin-top: 8px; }
    select, input[type="text"] { width: 100%; padding: 6px 10px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #555)); border-radius: 4px; font-size: var(--vscode-font-size); box-sizing: border-box; }
    select:focus, input:focus { outline: 1px solid var(--vscode-focusBorder); }
    .status { font-size: 12px; margin-top: 6px; }
    .status-connected { color: var(--vscode-charts-green, #89d185); }
    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 600; }
    .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary { background: transparent; color: var(--vscode-textLink-foreground); border: 1px solid var(--vscode-textLink-foreground); padding: 4px 10px; font-size: 12px; }
    .btn-secondary:hover { background: var(--vscode-textLink-foreground); color: var(--vscode-editor-background); }
    .btn-deploy { background: var(--vscode-charts-green, #89d185); color: #000; font-size: 14px; padding: 10px 24px; }
    .btn-deploy:hover { opacity: 0.85; }
    .btn-deploy:disabled { opacity: 0.4; cursor: not-allowed; }
    .search-container { position: relative; }
    .suggestions { position: absolute; top: 100%; left: 0; right: 0; background: var(--vscode-editorSuggestWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-widget-border, #555); border-top: none; border-radius: 0 0 4px 4px; max-height: 200px; overflow-y: auto; z-index: 10; display: none; }
    .suggestion-item { padding: 6px 10px; cursor: pointer; font-size: 13px; display: flex; align-items: center; gap: 6px; }
    .suggestion-item:hover { background: var(--vscode-list-hoverBackground); }
    .suggestion-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; min-height: 28px; }
    .tag { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 3px; font-size: 12px; }
    .tag-process { background: #264f78; color: #4fc1ff; border: 1px solid #4fc1ff55; }
    .tag-rule { background: #5c3d1a; color: #e2a24e; border: 1px solid #e2a24e55; }
    .tag-remove { cursor: pointer; font-weight: bold; opacity: 0.7; margin-left: 2px; }
    .tag-remove:hover { opacity: 1; }
    .type-indicator { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
    .type-indicator-process { background: #264f78; color: #4fc1ff; }
    .type-indicator-rule { background: #5c3d1a; color: #e2a24e; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-widget-border, #444); font-weight: 600; }
    td { padding: 6px 10px; border-bottom: 1px solid var(--vscode-widget-border, #333); }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .badge-create { background: var(--vscode-charts-green, #89d185); color: #000; }
    .badge-update { background: var(--vscode-charts-blue, #4fc1ff); color: #000; }
    .badge-success { background: var(--vscode-charts-green, #89d185); color: #000; }
    .badge-failed { background: var(--vscode-errorForeground, #f44747); color: #fff; }
    .arrow { font-size: 24px; color: var(--vscode-descriptionForeground); align-self: center; }
    .info-bar { background: var(--vscode-editorInfo-background, #264f78); padding: 10px 14px; border-radius: 4px; margin-bottom: 12px; font-size: 13px; border-left: 3px solid var(--vscode-textLink-foreground); }
    .legend { display: flex; gap: 16px; margin-top: 6px; font-size: 12px; color: var(--vscode-descriptionForeground); }
    .legend-item { display: flex; align-items: center; gap: 4px; }
    .legend-dot { width: 10px; height: 10px; border-radius: 2px; }
    .legend-dot-process { background: #4fc1ff; }
    .legend-dot-rule { background: #e2a24e; }
    .settings-section { border-top: 1px solid var(--vscode-widget-border, #444); padding-top: 16px; margin-top: 8px; }
    .settings-header { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; font-weight: 600; color: var(--vscode-descriptionForeground); user-select: none; padding: 4px 6px; border-radius: 4px; }
    .settings-header:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.15)); }
    .accordion-chevron { display: inline-block; font-size: 10px; transition: transform 0.12s ease; }
    .accordion-chevron.open { transform: rotate(90deg); }
    .settings-body { padding-top: 12px; }
    .settings-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .settings-row > label { margin: 0; flex-shrink: 0; min-width: 120px; }
    .settings-row input[type="text"] { flex: 1; max-width: 400px; }
    .toggle { position: relative; display: inline-block; width: 40px; height: 22px; flex-shrink: 0; min-width: 40px !important; margin: 0 !important; vertical-align: middle; }
    .toggle input { opacity: 0; width: 0; height: 0; position: absolute; }
    .toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; width: 40px; height: 22px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #555); border-radius: 11px; transition: 0.2s; box-sizing: border-box; }
    .toggle-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; top: 2px; background: var(--vscode-descriptionForeground); border-radius: 50%; transition: 0.2s; }
    .toggle input:checked + .toggle-slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    .toggle input:checked + .toggle-slider:before { transform: translateX(18px); background: var(--vscode-button-foreground); }
</style>
</head>
<body>
<h2>&#128640; Deployment Assistant</h2>

<div class="info-bar">
    Select source and target instances, choose objects, review changes, and deploy. Both instances must be connected via the PA Code Explorer.
</div>

<!-- STEP 1: Source & Target -->
<div class="step" id="step1">
    <div class="step-header" style="display:flex; align-items:center; gap:12px;">
        <span>Step 1 &mdash; Select Source &amp; Target</span>
        <button class="btn" type="button" style="font-size:12px; margin-left:auto;" onclick="refreshConnections()" title="Re-check which instances are currently connected without closing this window">&#128260; Refresh Connections</button>
    </div>
    <div class="row">
        <div class="col">
            <h3>&#128230; Source</h3>
            <label>Connected Instance</label>
            <select id="sourceInstance" onchange="onInstanceChange()"><option value="">-- Select --</option></select>
            <div class="status" id="sourceStatus"></div>
        </div>
        <div class="arrow">&#10132;</div>
        <div class="col">
            <h3>&#127919; Target</h3>
            <label>Connected Instance</label>
            <select id="targetInstance" onchange="onInstanceChange()"><option value="">-- Select --</option></select>
            <div class="status" id="targetStatus"></div>
        </div>
    </div>
</div>

<!-- STEP 2: Object Selection -->
<div class="step step-disabled" id="step2">
    <div class="step-header">Step 2 &mdash; Select Objects</div>
    <div class="row" style="align-items: flex-end; gap: 12px;">
        <div style="flex: 0 0 180px;">
            <label>Object Type</label>
            <select id="objectType" onchange="onTypeChange()">
                <option value="process">TI Process</option>
                <option value="rule">Rule</option>
            </select>
        </div>
        <div style="flex: 1;" class="search-container">
            <label>Search &amp; Add Objects <span style="font-size:11px;color:var(--vscode-descriptionForeground)">(switch type above to add both)</span></label>
            <input type="text" id="objectSearch" placeholder="Type to search..." oninput="onSearchInput()" onkeydown="onSearchKeydown(event)" />
            <div class="suggestions" id="suggestions"></div>
        </div>
    </div>
    <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn" type="button" style="font-size:12px;" onclick="toggleBrowse()" id="btnBrowse">&#9776; Browse / Select Multiple</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="togglePasteBox()" id="btnPaste">&#128203; Paste List</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="loadFromLog()">&#128193; Load from Log</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="clearSelected()">Clear List</button>
    </div>
    <div id="browseBox" style="display:none; margin-top:8px; border:1px solid var(--vscode-panel-border); border-radius:6px; padding:8px;">
        <input type="text" id="browseFilter" placeholder="Filter objects..." oninput="renderBrowseList()" style="width:100%; box-sizing:border-box; padding:6px 8px; border-radius:6px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground);" />
        <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
            <button class="btn" type="button" style="font-size:12px;" onclick="browseSelectAll(true)">Select All</button>
            <button class="btn" type="button" style="font-size:12px;" onclick="browseSelectAll(false)">None</button>
            <span id="browseCount" style="margin-left:auto; font-size:11px; color:var(--vscode-descriptionForeground);"></span>
        </div>
        <div id="browseList" style="max-height:240px; overflow-y:auto; border:1px solid var(--vscode-panel-border); border-radius:6px; padding:4px;"></div>
        <div style="margin-top:8px;">
            <button class="btn btn-primary" type="button" onclick="addBrowseSelected()">Add Selected</button>
        </div>
    </div>
    <div id="pasteBox" style="display:none; margin-top:8px; border:1px solid var(--vscode-panel-border); border-radius:6px; padding:8px;">
        <label style="font-size:12px;">Paste a list of process / rule names &mdash; one per line. Names are matched against the <strong>source</strong> instance and the type (TI Process / Rule) is detected automatically.</label>
        <textarea id="pasteInput" rows="8" placeholder="Process1&#10;Process2&#10;Process3&#10;..." style="width:100%; box-sizing:border-box; margin-top:6px; padding:6px 8px; border-radius:6px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:var(--vscode-editor-font-family, monospace); font-size:12px; resize:vertical;"></textarea>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
            <button class="btn btn-primary" type="button" onclick="importPasteList()">Import &amp; Select</button>
            <button class="btn" type="button" onclick="clearPasteBox()">Clear</button>
        </div>
        <div id="pasteResult" style="margin-top:6px;"></div>
    </div>
    <div class="legend">
        <div class="legend-item"><span class="legend-dot legend-dot-process"></span> TI Process</div>
        <div class="legend-item"><span class="legend-dot legend-dot-rule"></span> Rule</div>
    </div>
    <div class="tags" id="selectedTags"></div>
    <div style="margin-top: 12px;">
        <button class="btn btn-primary" onclick="checkSelected()" id="btnCheck" disabled>Check Target &amp; Review</button>
    </div>
</div>

<!-- STEP 3: Review & Deploy -->
<div class="step step-disabled" id="step3">
    <div class="step-header">Step 3 &mdash; Review &amp; Deploy</div>
    <table>
        <thead><tr><th>Object</th><th>Type</th><th>Status</th><th>Action</th><th>Diff</th><th></th></tr></thead>
        <tbody id="reviewBody"></tbody>
    </table>
    <div style="margin-top: 16px; display: flex; gap: 12px; align-items: center;">
        <button class="btn btn-deploy" onclick="doDeploy()" id="btnDeploy">&#9654; Deploy Selected Objects</button>
        <span id="deployStatus" style="font-size: 13px; color: var(--vscode-descriptionForeground);"></span>
    </div>
</div>

<!-- STEP 4: Results -->
<div class="step step-disabled" id="step4" style="display:none;">
    <div class="step-header">Results</div>
    <table>
        <thead><tr><th>Object</th><th>Type</th><th>Action</th><th>Result</th><th>Details</th></tr></thead>
        <tbody id="resultsBody"></tbody>
    </table>
</div>

<!-- Settings -->
<div class="step">
    <div class="settings-header" onclick="toggleSettings()">
        <span class="accordion-chevron" id="settingsArrow">&#9654;</span> Transport Log Settings
    </div>
    <div class="settings-body" id="settingsBody" style="display:none;">
        <div class="settings-row">
            <label>Enable Logging</label>
            <label class="toggle">
                <input type="checkbox" id="logEnabled" onchange="onLogToggle()">
                <span class="toggle-slider"></span>
            </label>
        </div>
        <div class="settings-row">
            <label>Log Directory</label>
            <input type="text" id="logDirectory" placeholder="e.g. C:\\\\Logs\\\\Deployment or ./deploy-logs" onchange="onLogDirChange()" />
        </div>
        <div style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
            When enabled, each deployment writes a JSON log with timestamp, source/target, and full before &amp; after code.
        </div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let processObjects = [];
let ruleObjects = [];
let selectedObjects = [];
let checkResults = [];
let connectedInstances = [];
let suggestionIndex = -1;
let currentType = 'process';
let browseChecked = new Set();

window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.command) {
        case 'init':
            connectedInstances = msg.connectedInstances || [];
            populateInstanceDropdowns(connectedInstances);
            if (document.getElementById('sourceInstance').value && document.getElementById('targetInstance').value) loadBothTypes();
            break;
        case 'objectList':
            if (msg.objectType === 'process') processObjects = msg.names || [];
            else ruleObjects = msg.names || [];
            showSuggestions();
            if (document.getElementById('browseBox') && document.getElementById('browseBox').style.display !== 'none') renderBrowseList();
            break;
        case 'logObjectsLoaded':
            applyLoadedObjects(msg.objects || [], msg.source || '', msg.target || '');
            break;
        case 'checkResults':
            checkResults = msg.results || [];
            renderReview();
            document.getElementById('step3').classList.remove('step-disabled');
            break;
        case 'deployResults':
            renderResults(msg.results);
            break;
        case 'settings':
            document.getElementById('logEnabled').checked = msg.logEnabled;
            document.getElementById('logDirectory').value = msg.logDirectory || '';
            break;
        case 'error':
            showError(msg.message);
            break;
    }
});

function populateInstanceDropdowns(instances) {
    connectedInstances = instances || [];
    rebuildInstanceOptions();
}

function buildInstanceOptions(sel, keepValue, excludeValue) {
    let html = '<option value="">-- Select --</option>';
    for (const inst of connectedInstances) {
        if (inst === excludeValue) continue;
        html += '<option value="' + escapeHtml(inst) + '"' + (inst === keepValue ? ' selected' : '') + '>' + escapeHtml(inst) + '</option>';
    }
    sel.innerHTML = html;
}

function rebuildInstanceOptions() {
    const srcSel = document.getElementById('sourceInstance');
    const tgtSel = document.getElementById('targetInstance');
    const curSrc = srcSel.value;
    const curTgt = tgtSel.value;
    buildInstanceOptions(srcSel, curSrc, curTgt);
    buildInstanceOptions(tgtSel, curTgt, curSrc);
}

function refreshConnections() {
    vscode.postMessage({ command: 'init' });
}

function onInstanceChange() {
    rebuildInstanceOptions();
    const src = document.getElementById('sourceInstance').value;
    const tgt = document.getElementById('targetInstance').value;
    document.getElementById('sourceStatus').innerHTML = src ? '<span class="status-connected">\\u25CF Connected</span>' : '';
    document.getElementById('targetStatus').innerHTML = tgt ? '<span class="status-connected">\\u25CF Connected</span>' : '';

    if (src && tgt && src !== tgt) {
        document.getElementById('step2').classList.remove('step-disabled');
        loadBothTypes();
    } else {
        document.getElementById('step2').classList.add('step-disabled');
    }
    document.getElementById('step3').classList.add('step-disabled');
    selectedObjects = [];
    checkResults = [];
    processObjects = [];
    ruleObjects = [];
    renderTags();
}

function loadBothTypes() {
    const src = document.getElementById('sourceInstance').value;
    if (!src) return;
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'process' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'rule' });
}

function onTypeChange() {
    currentType = document.getElementById('objectType').value;
    document.getElementById('objectSearch').value = '';
    document.getElementById('suggestions').style.display = 'none';
    suggestionIndex = -1;
    browseChecked.clear();
    if (document.getElementById('browseBox') && document.getElementById('browseBox').style.display !== 'none') renderBrowseList();
}

function onSearchInput() {
    suggestionIndex = -1;
    showSuggestions();
}

function getCurrentObjects() {
    return currentType === 'process' ? processObjects : ruleObjects;
}

function showSuggestions() {
    const input = document.getElementById('objectSearch').value.toLowerCase();
    const box = document.getElementById('suggestions');
    if (!input || input.length < 1) { box.style.display = 'none'; return; }
    const allObjs = getCurrentObjects();
    const selectedNames = new Set(selectedObjects.filter(o => o.type === currentType).map(o => o.name));
    const filtered = allObjs.filter(n =>
        n.toLowerCase().includes(input) && !selectedNames.has(n)
    ).slice(0, 50);
    if (filtered.length === 0) { box.style.display = 'none'; return; }
    const typeLabel = currentType === 'process' ? 'TI' : 'RX';
    const typeCls = 'type-indicator type-indicator-' + currentType;
    box.innerHTML = filtered.map((n, i) =>
        '<div class="suggestion-item' + (i === suggestionIndex ? ' selected' : '') + '" onclick="addObject(\\'' + escapeJs(n) + '\\')">'
        + '<span class="' + typeCls + '">' + typeLabel + '</span> '
        + escapeHtml(n) + '</div>'
    ).join('');
    box.style.display = 'block';
}

function onSearchKeydown(e) {
    const box = document.getElementById('suggestions');
    const items = box.querySelectorAll('.suggestion-item');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        suggestionIndex = Math.min(suggestionIndex + 1, items.length - 1);
        updateSuggestionHighlight(items);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        suggestionIndex = Math.max(suggestionIndex - 1, 0);
        updateSuggestionHighlight(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (suggestionIndex >= 0 && suggestionIndex < items.length) {
            items[suggestionIndex].click();
        }
    } else if (e.key === 'Escape') {
        box.style.display = 'none';
    }
}

function updateSuggestionHighlight(items) {
    items.forEach((el, i) => {
        el.classList.toggle('selected', i === suggestionIndex);
        if (i === suggestionIndex) el.scrollIntoView({ block: 'nearest' });
    });
}

function addObject(name) {
    const exists = selectedObjects.some(o => o.name === name && o.type === currentType);
    if (!exists) {
        selectedObjects.push({ name, type: currentType });
    }
    document.getElementById('objectSearch').value = '';
    document.getElementById('suggestions').style.display = 'none';
    document.getElementById('step3').classList.add('step-disabled');
    checkResults = [];
    renderTags();
}

function removeObject(name, type) {
    selectedObjects = selectedObjects.filter(o => !(o.name === name && o.type === type));
    checkResults = [];
    document.getElementById('step3').classList.add('step-disabled');
    renderTags();
}

function renderTags() {
    const container = document.getElementById('selectedTags');
    container.innerHTML = selectedObjects.map(o => {
        const cls = 'tag tag-' + o.type;
        const prefix = o.type === 'process' ? 'TI' : 'RX';
        return '<span class="' + cls + '">'
            + '<span class="type-indicator type-indicator-' + o.type + '">' + prefix + '</span> '
            + escapeHtml(o.name)
            + ' <span class="tag-remove" onclick="removeObject(\\'' + escapeJs(o.name) + '\\', \\'' + o.type + '\\')">&times;</span>'
            + '</span>';
    }).join('');
    document.getElementById('btnCheck').disabled = selectedObjects.length === 0;
}

// ---- Multi-select (Browse) ----
function toggleBrowse() {
    const box = document.getElementById('browseBox');
    const open = box.style.display === 'none';
    box.style.display = open ? 'block' : 'none';
    if (open) renderBrowseList();
}

function renderBrowseList() {
    const listEl = document.getElementById('browseList');
    const filter = (document.getElementById('browseFilter').value || '').toLowerCase();
    const all = getCurrentObjects();
    const selectedNames = new Set(selectedObjects.filter(o => o.type === currentType).map(o => o.name));
    const items = all.filter(n => n.toLowerCase().includes(filter));
    const typeLabel = currentType === 'process' ? 'TI' : 'RX';
    listEl.innerHTML = items.map(n => {
        const already = selectedNames.has(n);
        const checked = browseChecked.has(n) ? ' checked' : '';
        const dis = already ? ' disabled' : '';
        const style = already ? 'opacity:.5;' : '';
        return '<label class="browse-item" style="display:flex;align-items:center;gap:6px;padding:3px 4px;' + style + '">'
            + '<input type="checkbox"' + checked + dis + ' onchange="toggleBrowseCheck(\\'' + escapeJs(n) + '\\', this.checked)"> '
            + '<span class="type-indicator type-indicator-' + currentType + '">' + typeLabel + '</span> '
            + escapeHtml(n) + (already ? ' <span style="font-size:10px;opacity:.7;">(added)</span>' : '')
            + '</label>';
    }).join('') || '<div style="opacity:.6;padding:6px;">No objects.</div>';
    updateBrowseCount();
}

function toggleBrowseCheck(name, checked) {
    if (checked) browseChecked.add(name); else browseChecked.delete(name);
    updateBrowseCount();
}

function browseSelectAll(on) {
    const filter = (document.getElementById('browseFilter').value || '').toLowerCase();
    const selectedNames = new Set(selectedObjects.filter(o => o.type === currentType).map(o => o.name));
    getCurrentObjects().filter(n => n.toLowerCase().includes(filter) && !selectedNames.has(n)).forEach(n => {
        if (on) browseChecked.add(n); else browseChecked.delete(n);
    });
    renderBrowseList();
}

function updateBrowseCount() {
    document.getElementById('browseCount').textContent = browseChecked.size + ' checked';
}

function addBrowseSelected() {
    browseChecked.forEach(name => {
        if (!selectedObjects.some(o => o.name === name && o.type === currentType)) {
            selectedObjects.push({ name, type: currentType });
        }
    });
    browseChecked.clear();
    checkResults = [];
    document.getElementById('step3').classList.add('step-disabled');
    renderTags();
    renderBrowseList();
}

function clearSelected() {
    selectedObjects = [];
    checkResults = [];
    document.getElementById('step3').classList.add('step-disabled');
    renderTags();
    if (document.getElementById('browseBox').style.display !== 'none') renderBrowseList();
}

// ---- Paste a list of names and select them in bulk ----
function togglePasteBox() {
    const box = document.getElementById('pasteBox');
    const open = box.style.display === 'none';
    box.style.display = open ? 'block' : 'none';
    if (open) document.getElementById('pasteInput').focus();
}

function clearPasteBox() {
    document.getElementById('pasteInput').value = '';
    document.getElementById('pasteResult').innerHTML = '';
}

function importPasteList() {
    const resultEl = document.getElementById('pasteResult');
    if (processObjects.length === 0 && ruleObjects.length === 0) {
        resultEl.innerHTML = '<span style="color:#f85149;font-size:12px;">Select a connected Source and Target first so the object lists are loaded.</span>';
        return;
    }
    const raw = document.getElementById('pasteInput').value || '';
    // One name per line; also tolerate comma/semicolon/tab separators.
    const rawNames = raw.split(/[\\r\\n,;\\t]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    // Strip surrounding quotes and a trailing .ti/.rux/.pro extension if present.
    const clean = function (n) { return n.replace(/^["']|["']$/g, '').replace(/\\.(ti|rux|pro)$/i, '').trim(); };
    const procMap = new Map(processObjects.map(function (n) { return [n.toLowerCase(), n]; }));
    const ruleMap = new Map(ruleObjects.map(function (n) { return [n.toLowerCase(), n]; }));
    const selectedKey = new Set(selectedObjects.map(function (o) { return o.type + '|' + o.name; }));
    let added = 0, dup = 0;
    const notFound = [];
    const seen = new Set();
    for (const rawName of rawNames) {
        const name = clean(rawName);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue; // ignore duplicates within the pasted list
        seen.add(key);
        let match = null, type = null;
        if (procMap.has(key)) { match = procMap.get(key); type = 'process'; }
        else if (ruleMap.has(key)) { match = ruleMap.get(key); type = 'rule'; }
        if (!match) { notFound.push(rawName.trim()); continue; }
        if (selectedKey.has(type + '|' + match)) { dup++; continue; }
        selectedObjects.push({ name: match, type: type });
        selectedKey.add(type + '|' + match);
        added++;
    }
    checkResults = [];
    document.getElementById('step3').classList.add('step-disabled');
    renderTags();
    if (document.getElementById('browseBox').style.display !== 'none') renderBrowseList();

    let html = '<div style="font-size:12px;">';
    html += '<span style="color:#3fb950;font-weight:600;">' + added + ' added</span>';
    if (dup > 0) html += ' &middot; <span style="color:var(--vscode-descriptionForeground);">' + dup + ' already in list</span>';
    if (notFound.length > 0) {
        html += ' &middot; <span style="color:#f85149;font-weight:600;">' + notFound.length + ' not found</span>';
        html += '<div style="margin-top:4px;color:#f85149;max-height:140px;overflow:auto;border:1px solid var(--vscode-panel-border);border-radius:4px;padding:4px;font-family:var(--vscode-editor-font-family, monospace);">'
            + notFound.map(escapeHtml).join('<br>') + '</div>';
        html += '<div style="margin-top:4px;color:var(--vscode-descriptionForeground);">Not-found names don\\'t exist on the source instance (check spelling, or that the object type is loaded).</div>';
    }
    html += '</div>';
    resultEl.innerHTML = html;
}

// ---- Load objects from an existing transport log ----
function loadFromLog() {
    vscode.postMessage({ command: 'loadFromLog' });
}

function applyLoadedObjects(objects, source, target) {
    const srcSel = document.getElementById('sourceInstance');
    const tgtSel = document.getElementById('targetInstance');
    if (source && connectedInstances.includes(source)) srcSel.value = source;
    if (target && connectedInstances.includes(target)) tgtSel.value = target;
    const src = srcSel.value, tgt = tgtSel.value;
    document.getElementById('sourceStatus').innerHTML = src ? '<span class="status-connected">\\u25CF Connected</span>' : '';
    document.getElementById('targetStatus').innerHTML = tgt ? '<span class="status-connected">\\u25CF Connected</span>' : '';
    if (src && tgt && src !== tgt) {
        document.getElementById('step2').classList.remove('step-disabled');
        loadBothTypes();
    }
    document.getElementById('step3').classList.add('step-disabled');
    checkResults = [];
    selectedObjects = objects.slice();
    renderTags();
}

function checkSelected() {
    const src = document.getElementById('sourceInstance').value;
    const tgt = document.getElementById('targetInstance').value;
    vscode.postMessage({ command: 'checkObjects', sourceInstance: src, targetInstance: tgt, objects: selectedObjects });
}

function renderReview() {
    const tbody = document.getElementById('reviewBody');
    tbody.innerHTML = checkResults.map(r => {
        const badge = r.exists
            ? '<span class="badge badge-update">Update</span>'
            : '<span class="badge badge-create">Create</span>';
        const typeLabel = r.type === 'process' ? 'TI Process' : 'Rule';
        const typeCls = 'type-indicator type-indicator-' + r.type;
        const compareBtn = r.exists
            ? '<button class="btn btn-secondary" onclick="doCompare(\\'' + escapeJs(r.name) + '\\', \\'' + r.type + '\\')">Compare</button>'
            : '<span style="color:var(--vscode-descriptionForeground);font-size:12px;">New ' + typeLabel.toLowerCase() + '</span>';
        let diffStats = '';
        if (r.exists && r.added != null && r.removed != null) {
            if (r.added === 0 && r.removed === 0) {
                diffStats = '<span style="font-size:12px;color:var(--vscode-descriptionForeground);">identical</span>';
            } else {
                const parts = [];
                if (r.added > 0) parts.push('<span style="color:#3fb950;font-weight:600;">+' + r.added + '</span>');
                if (r.removed > 0) parts.push('<span style="color:#f85149;font-weight:600;">-' + r.removed + '</span>');
                diffStats = '<span style="font-size:12px;">' + parts.join(' ') + '</span>';
                // Tab-level indicators for processes
                if (r.type === 'process' && r.tabDiffs) {
                    const tabNames = ['Prolog', 'Metadata', 'Data', 'Epilog'];
                    const tabIndicators = tabNames.map(t => {
                        const td = r.tabDiffs[t];
                        if (!td || (td.added === 0 && td.removed === 0)) {
                            return '<span style="color:var(--vscode-descriptionForeground);font-size:11px;" title="' + t + ': identical">' + t.charAt(0) + '</span>';
                        }
                        return '<span style="color:#f85149;font-weight:600;font-size:11px;" title="' + t + ': +' + td.added + ' -' + td.removed + '">' + t.charAt(0) + '</span>';
                    }).join(' ');
                    diffStats += '<br><span style="font-size:11px;">' + tabIndicators + '</span>';
                }
            }
        }
        return '<tr><td>' + escapeHtml(r.name) + '</td><td><span class="' + typeCls + '">' + typeLabel + '</span></td><td>' + (r.exists ? 'Exists on target' : 'Not on target') + '</td><td>' + badge + '</td><td>' + diffStats + '</td><td>' + compareBtn + '</td></tr>';
    }).join('');
}

function doCompare(name, type) {
    const src = document.getElementById('sourceInstance').value;
    const tgt = document.getElementById('targetInstance').value;
    vscode.postMessage({ command: 'compare', sourceInstance: src, targetInstance: tgt, objectName: name, objectType: type });
}

function doDeploy() {
    const src = document.getElementById('sourceInstance').value;
    const tgt = document.getElementById('targetInstance').value;
    document.getElementById('btnDeploy').disabled = true;
    document.getElementById('deployStatus').textContent = 'Deploying...';
    vscode.postMessage({ command: 'deploy', sourceInstance: src, targetInstance: tgt, objects: checkResults });
}

function renderResults(results) {
    document.getElementById('step4').style.display = 'block';
    document.getElementById('step4').classList.remove('step-disabled');
    document.getElementById('btnDeploy').disabled = false;
    document.getElementById('deployStatus').textContent = '';

    const tbody = document.getElementById('resultsBody');
    tbody.innerHTML = results.map(r => {
        const badge = r.success
            ? '<span class="badge badge-success">' + escapeHtml(r.action) + '</span>'
            : '<span class="badge badge-failed">Failed</span>';
        const typeLabel = r.type === 'process' ? 'TI Process' : 'Rule';
        const typeCls = 'type-indicator type-indicator-' + r.type;
        const detail = r.success ? '\\u2714' : escapeHtml(r.error || '');
        return '<tr><td>' + escapeHtml(r.name) + '</td><td><span class="' + typeCls + '">' + typeLabel + '</span></td><td>' + escapeHtml(r.action) + '</td><td>' + badge + '</td><td>' + detail + '</td></tr>';
    }).join('');
}

function toggleSettings() {
    const body = document.getElementById('settingsBody');
    const arrow = document.getElementById('settingsArrow');
    if (body.style.display === 'none') {
        body.style.display = 'block';
        arrow.classList.add('open');
        vscode.postMessage({ command: 'getSettings' });
    } else {
        body.style.display = 'none';
        arrow.classList.remove('open');
    }
}

function onLogToggle() {
    const val = document.getElementById('logEnabled').checked;
    vscode.postMessage({ command: 'updateSetting', key: 'deployment.logEnabled', value: val });
}

function onLogDirChange() {
    const val = document.getElementById('logDirectory').value;
    vscode.postMessage({ command: 'updateSetting', key: 'deployment.logDirectory', value: val });
}

function showError(msg) {
    const el = document.getElementById('deployStatus');
    if (el) el.textContent = msg;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
}

function escapeJs(text) {
    return (text || '').replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}

document.addEventListener('click', e => {
    if (!e.target.closest('.search-container')) {
        document.getElementById('suggestions').style.display = 'none';
    }
});

vscode.postMessage({ command: 'init' });
</script>
</body>
</html>`;
    }
}

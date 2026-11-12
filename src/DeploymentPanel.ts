import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export class DeploymentPanel {
    public static currentPanel: DeploymentPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _preselectSource?: string;

    private constructor(panel: vscode.WebviewPanel, preselectSource?: string) {
        this._panel = panel;
        this._preselectSource = preselectSource;
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
                    await this._deploy(message.sourceInstance, message.targetInstance, message.objects, !!message.copyCubeData, message.packageId);
                    return;
                case 'getSettings':
                    this._sendSettings();
                    return;
                case 'updateSetting':
                    await this._updateSetting(message.key, message.value);
                    return;
                case 'listPackages':
                    this._sendPackages();
                    return;
                case 'savePackage':
                    await this._savePackage(message.name, message.description, message.objects);
                    return;
                case 'loadPackage':
                    this._loadPackage(message.id);
                    return;
                case 'deletePackage':
                    this._deletePackage(message.id);
                    return;
                case 'savePackageNotes':
                    this._savePackageNotes(message.id, message.notes);
                    return;
                case 'exportPackage':
                    await this._exportPackage(message.id);
                    return;
            }
        }, null, this._disposables);
    }

    public static render(preselectSource?: string) {
        if (DeploymentPanel.currentPanel) {
            DeploymentPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1Deployment', 'TM1 Deployment Assistant', vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DeploymentPanel.currentPanel = new DeploymentPanel(panel, preselectSource);
    }

    private async _sendInit() {
        const config = ConfigManager.getConfig();
        const environments = (config.environments || []).map((e: any) => e.name);
        const connectedInstances = TM1Service.getInstance().getConnectedInstanceNames();
        this._panel.webview.postMessage({ command: 'init', environments, connectedInstances, preselectSource: this._preselectSource });
    }

    private async _loadObjects(instanceName: string, objectType: string) {
        try {
            let names: string[] = [];
            if (objectType === 'process') {
                const procs = await TM1Service.getInstance().getProcesses(instanceName, 'all');
                names = procs.map(p => p.Name);
            } else if (objectType === 'dimension') {
                names = await TM1Service.getInstance().getDimensionNames(instanceName);
            } else if (objectType === 'cube') {
                names = await TM1Service.getInstance().getCubeNames(instanceName);
            } else if (objectType === 'view') {
                names = await TM1Service.getInstance().getAllViewsForDeploy(instanceName);
            } else if (objectType === 'subset') {
                names = await TM1Service.getInstance().getAllSubsetsForDeploy(instanceName);
            } else if (objectType === 'application') {
                names = await TM1Service.getInstance().getAllApplicationsForDeploy(instanceName);
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

            const dimensions = objects.filter(o => o.type === 'dimension');
            if (dimensions.length > 0) {
                const existingNames = new Set((await TM1Service.getInstance().getDimensionNames(targetInstance)).map(n => n.toLowerCase()));
                for (const obj of dimensions) {
                    results.push({ name: obj.name, type: 'dimension', exists: existingNames.has(obj.name.toLowerCase()) });
                }
            }

            const cubes = objects.filter(o => o.type === 'cube');
            if (cubes.length > 0) {
                const existingNames = new Set((await TM1Service.getInstance().getCubeNames(targetInstance)).map(n => n.toLowerCase()));
                for (const obj of cubes) {
                    results.push({ name: obj.name, type: 'cube', exists: existingNames.has(obj.name.toLowerCase()) });
                }
            }

            const views = objects.filter(o => o.type === 'view');
            if (views.length > 0) {
                const existingNames = new Set((await TM1Service.getInstance().getAllViewsForDeploy(targetInstance)).map(n => n.toLowerCase()));
                for (const obj of views) {
                    results.push({ name: obj.name, type: 'view', exists: existingNames.has(obj.name.toLowerCase()) });
                }
            }

            const subsets = objects.filter(o => o.type === 'subset');
            if (subsets.length > 0) {
                const existingNames = new Set((await TM1Service.getInstance().getAllSubsetsForDeploy(targetInstance)).map(n => n.toLowerCase()));
                for (const obj of subsets) {
                    results.push({ name: obj.name, type: 'subset', exists: existingNames.has(obj.name.toLowerCase()) });
                }
            }

            const applications = objects.filter(o => o.type === 'application');
            if (applications.length > 0) {
                const existingNames = new Set((await TM1Service.getInstance().getAllApplicationsForDeploy(targetInstance)).map(n => n.toLowerCase()));
                for (const obj of applications) {
                    results.push({ name: obj.name, type: 'application', exists: existingNames.has(obj.name.toLowerCase()) });
                }
            }

            this._panel.webview.postMessage({ command: 'checkResults', results });
        } catch (err: any) {
            this._panel.webview.postMessage({ command: 'error', message: `Failed to check target: ${err.message}` });
        }
    }

    /** LCS-based line diff: count added and removed lines between source and target. */
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

    // Does a process' properties define a real (non-None) datasource?
    private static _hasDataSource(code: any): boolean {
        try { const p = JSON.parse(code?.PropertiesJSON || '{}'); const ds = p.DataSource; return !!(ds && ds.Type && ds.Type !== 'None'); } catch { return false; }
    }

    // Splits a "Parent : Child" object name (view = "Cube : View", subset =
    // "Dimension : Subset") into its two parts.
    private static _splitParent(name: string): [string, string] {
        const idx = name.indexOf(' : ');
        if (idx < 0) { return [name, name]; }
        return [name.substring(0, idx), name.substring(idx + 3)];
    }

    // Replace the source's untransportable password with the target's own (kept)
    // password. Records the process for a manual-set warning when none exists.
    private static _withTargetPassword(srcCode: any, targetCode: any, name: string, todo: string[]): any {
        try {
            const sp = JSON.parse(srcCode?.PropertiesJSON || '{}');
            const tp = JSON.parse(targetCode?.PropertiesJSON || '{}');
            if (sp.DataSource && typeof sp.DataSource === 'object') {
                const tpw = tp.DataSource ? (tp.DataSource.dataSourcePassword ?? tp.DataSource.DatasourcePassword) : undefined;
                delete sp.DataSource.DatasourcePassword; delete sp.DataSource.Password; delete sp.DataSource.password;
                if (tpw !== undefined && tpw !== '') { sp.DataSource.dataSourcePassword = tpw; }
                else { delete sp.DataSource.dataSourcePassword; todo.push(name); }
            }
            return { ...srcCode, PropertiesJSON: JSON.stringify(sp) };
        } catch { return srcCode; }
    }
    // Strip any datasource password (used for new target processes).
    private static _withoutPassword(srcCode: any, name: string, todo: string[]): any {
        try {
            const sp = JSON.parse(srcCode?.PropertiesJSON || '{}');
            if (sp.DataSource && typeof sp.DataSource === 'object') {
                delete sp.DataSource.dataSourcePassword; delete sp.DataSource.DatasourcePassword;
                delete sp.DataSource.Password; delete sp.DataSource.password;
                todo.push(name);
            }
            return { ...srcCode, PropertiesJSON: JSON.stringify(sp) };
        } catch { return srcCode; }
    }

    private async _deploy(sourceInstance: string, targetInstance: string, objects: { name: string; type: string; exists: boolean }[], copyCubeData: boolean = false, packageId?: string) {
        const results: any[] = [];
        // Processes whose datasource password couldn't be transported (ODBC passwords
        // are encrypted per-server) — the user must set the password on the target.
        const passwordTodo: string[] = [];

        // Deploy in dependency order: dimensions (cubes/subsets need them) ->
        // cubes -> subsets -> views (views reference cubes & subsets) ->
        // processes -> rules (a rule attaches to its cube) -> applications
        // (references to all of the above).
        const order: Record<string, number> = { dimension: 0, cube: 1, subset: 2, view: 3, process: 4, rule: 5, application: 6 };
        const ordered = [...objects].sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Deploying objects...',
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < ordered.length; i++) {
                const obj = ordered[i];
                progress.report({ message: `(${i + 1}/${ordered.length}) ${obj.name}`, increment: (100 / ordered.length) });

                try {
                    if (obj.type === 'dimension') {
                        const def = await TM1Service.getInstance().getDimensionForDeploy(sourceInstance, obj.name);
                        await TM1Service.getInstance().deployDimension(targetInstance, def);
                        results.push({ name: obj.name, type: 'dimension', action: obj.exists ? 'updated' : 'created', success: true });
                    } else if (obj.type === 'cube') {
                        const dims = await TM1Service.getInstance().getCubeDimensionNames(sourceInstance, obj.name);
                        const created = await TM1Service.getInstance().deployCubeStructure(targetInstance, obj.name, dims);
                        let dataNote = '';
                        if (copyCubeData) {
                            const r = await TM1Service.getInstance().copyCubeData(sourceInstance, targetInstance, obj.name);
                            dataNote = ` (data: ${r.written} written${r.failed ? `, ${r.failed} failed` : ''}${(r.written === 0 || r.failed) ? ` — ${r.detail}` : ''})`;
                        }
                        results.push({ name: obj.name, type: 'cube', action: (created ? 'created' : 'updated') + (copyCubeData ? ' + data' : ' (shell)'), success: true, note: dataNote });
                    } else if (obj.type === 'view') {
                        const [cube, view] = DeploymentPanel._splitParent(obj.name);
                        const def = await TM1Service.getInstance().getViewForDeploy(sourceInstance, cube, view);
                        await TM1Service.getInstance().deployView(targetInstance, cube, view, def.body);
                        results.push({ name: obj.name, type: 'view', action: (obj.exists ? 'updated' : 'created') + (def.isMdx ? ' (MDX)' : ' (native)'), success: true });
                    } else if (obj.type === 'subset') {
                        const [dim, subset] = DeploymentPanel._splitParent(obj.name);
                        const content = await TM1Service.getInstance().getSubsetContent(sourceInstance, dim, dim, subset);
                        await TM1Service.getInstance().saveSubset(targetInstance, dim, dim, subset, true, { mdx: content.mdx || undefined, elements: content.elements });
                        results.push({ name: obj.name, type: 'subset', action: (obj.exists ? 'updated' : 'created') + (content.mdx ? ' (dynamic)' : ' (static)'), success: true });
                    } else if (obj.type === 'application') {
                        await TM1Service.getInstance().deployApplication(sourceInstance, targetInstance, obj.name);
                        results.push({ name: obj.name, type: 'application', action: obj.exists ? 'updated' : 'created', success: true });
                    } else if (obj.type === 'process') {
                        const srcCode = await TM1Service.getInstance().getProcessCode(sourceInstance, obj.name);
                        const hasDs = DeploymentPanel._hasDataSource(srcCode);
                        let previousCode: any = null;

                        if (obj.exists) {
                            previousCode = await TM1Service.getInstance().getProcessCode(targetInstance, obj.name);
                            // ODBC/datasource passwords are encrypted per-server and can't be
                            // transported. Keep the TARGET's existing password (its own blob
                            // round-trips on its own server) instead of pushing the source's.
                            const deployCode = hasDs ? DeploymentPanel._withTargetPassword(srcCode, previousCode, obj.name, passwordTodo) : srcCode;
                            await TM1Service.getInstance().updateProcessCode(targetInstance, obj.name, deployCode);
                        } else {
                            await TM1Service.getInstance().createProcess(targetInstance, obj.name);
                            // New target: the source password can't be decrypted here — strip it
                            // so we don't write a broken one; the user sets it on the target.
                            const deployCode = hasDs ? DeploymentPanel._withoutPassword(srcCode, obj.name, passwordTodo) : srcCode;
                            await TM1Service.getInstance().updateProcessCode(targetInstance, obj.name, deployCode);
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

        // When deploying a saved package, record each object's outcome (status,
        // timestamp, target, user) back into the package for compliance tracking.
        if (packageId) {
            this._recordPackageDeployment(packageId, targetInstance, results);
        }

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        // Auto-pull: update local files on target instance for deployed objects
        if (succeeded > 0) {
            await this._autoPullDeployed(targetInstance, results.filter(r => r.success));
        }

        if (failed === 0) {
            // Only mention local files when the target actually stores them.
            const envConfig = ConfigManager.getConfig().environments?.find((e: any) => targetInstance.startsWith(e.name + '_'));
            const wroteFiles = succeeded > 0 && envConfig?.storeFilesLocally !== false;
            vscode.window.showInformationMessage(`Deployment complete: ${succeeded} object(s) deployed successfully.${wroteFiles ? ' Local files updated.' : ''}`);
        } else {
            vscode.window.showWarningMessage(`Deployment complete: ${succeeded} succeeded, ${failed} failed.`);
        }

        // ODBC/datasource passwords can't be transported between servers — tell the
        // user which deployed processes still need their password set on the target.
        if (passwordTodo.length > 0) {
            const list = passwordTodo.join(', ');
            vscode.window.showWarningMessage(
                `Datasource password not transported for ${passwordTodo.length} process(es): ${list}. Set the password on the target (ODBC passwords are encrypted per server and can't be moved).`,
                { modal: true }
            );
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

    // --- DEPLOYMENT PACKAGES (issue #10) ---
    // Named containers of objects to deploy as a set, with per-object notes and
    // last-deployed tracking. Stored as a Git-trackable JSON file in the workspace.

    private _packagesFile(): string | null {
        const wf = vscode.workspace.workspaceFolders;
        if (!wf || wf.length === 0) { return null; }
        return path.join(wf[0].uri.fsPath, '.pa-code', 'deployment-packages.json');
    }

    private _readPackages(): any[] {
        const f = this._packagesFile();
        if (!f || !fs.existsSync(f)) { return []; }
        try { const arr = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(arr) ? arr : []; } catch { return []; }
    }

    private _writePackages(pkgs: any[]): void {
        const f = this._packagesFile();
        if (!f) { vscode.window.showErrorMessage('Open a workspace folder to save deployment packages.'); return; }
        const dir = path.dirname(f);
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
        fs.writeFileSync(f, JSON.stringify(pkgs, null, 2), 'utf8');
    }

    private _sendPackages(): void {
        this._panel.webview.postMessage({ command: 'packages', packages: this._readPackages() });
    }

    private async _savePackage(name: string | undefined, description: string | undefined, objects: { name: string; type: string; note?: string }[]): Promise<void> {
        let cleanName = (name || '').trim();
        let desc = description || '';
        if (!cleanName) {
            // Let the user update an existing package or create a new one — no
            // need to retype a name they already have.
            const pkgs0 = this._readPackages();
            const NEW = '$(add) Create new package…';
            const picks: vscode.QuickPickItem[] = [{ label: NEW }];
            if (pkgs0.length) { picks.push({ label: '', kind: vscode.QuickPickItemKind.Separator }); }
            for (const p of pkgs0.sort((a, b) => (b.updated || '').localeCompare(a.updated || ''))) {
                picks.push({ label: p.name, description: `${(p.objects || []).length} object(s) · updated ${String(p.updated || '').slice(0, 10)}` });
            }
            const pick = await vscode.window.showQuickPick(picks, { placeHolder: 'Save this selection to which package?', ignoreFocusOut: true });
            if (!pick) { return; }
            if (pick.label === NEW) {
                const entered = await vscode.window.showInputBox({ prompt: 'New deployment package name', ignoreFocusOut: true, placeHolder: 'e.g. Sprint 24 — P&L changes' });
                cleanName = (entered || '').trim();
                if (!cleanName) { return; }
                desc = (await vscode.window.showInputBox({ prompt: 'Description (optional)', ignoreFocusOut: true })) || '';
            } else {
                cleanName = pick.label;
                const target = pkgs0.find(p => p.name === cleanName);
                desc = target ? (target.description || '') : '';
                const ok = await vscode.window.showWarningMessage(`Update package '${cleanName}' with the current ${objects.length} object(s)?`, { modal: true }, 'Update');
                if (ok !== 'Update') { return; }
            }
        }
        const pkgs = this._readPackages();
        const now = new Date().toISOString();
        const existing = pkgs.find(p => p.name.toLowerCase() === cleanName.toLowerCase());
        const objs = (objects || []).map(o => ({ name: o.name, type: o.type, note: o.note || '' }));
        let savedId: string;
        if (existing) {
            // Preserve prior deploy history for objects that stay in the package.
            const prev = new Map(existing.objects.map((o: any) => [o.type + '|' + o.name, o]));
            existing.objects = objs.map(o => {
                const old: any = prev.get(o.type + '|' + o.name);
                return old ? { ...o, lastDeployed: old.lastDeployed, lastDeployedBy: old.lastDeployedBy, lastStatus: old.lastStatus, lastTarget: old.lastTarget } : o;
            });
            existing.description = desc;
            existing.updated = now;
            savedId = existing.id;
        } else {
            savedId = `pkg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            pkgs.push({ id: savedId, name: cleanName, description: desc, objects: objs, created: now, updated: now });
        }
        this._writePackages(pkgs);
        this._sendPackages();
        this._panel.webview.postMessage({ command: 'packageSaved', id: savedId });
        vscode.window.showInformationMessage(`Deployment package '${cleanName}' saved (${objs.length} object(s)).`);
    }

    private _loadPackage(id: string): void {
        const pkg = this._readPackages().find(p => p.id === id);
        if (!pkg) { return; }
        this._panel.webview.postMessage({ command: 'packageLoaded', pkg });
    }

    private _deletePackage(id: string): void {
        const pkgs = this._readPackages();
        const pkg = pkgs.find(p => p.id === id);
        const next = pkgs.filter(p => p.id !== id);
        this._writePackages(next);
        this._sendPackages();
        if (pkg) { vscode.window.showInformationMessage(`Deleted deployment package '${pkg.name}'.`); }
    }

    private _savePackageNotes(id: string, notes: { name: string; type: string; note: string }[]): void {
        const pkgs = this._readPackages();
        const pkg = pkgs.find(p => p.id === id);
        if (!pkg) { return; }
        const noteMap = new Map((notes || []).map(n => [n.type + '|' + n.name, n.note]));
        for (const o of pkg.objects) {
            const key = o.type + '|' + o.name;
            if (noteMap.has(key)) { o.note = noteMap.get(key) || ''; }
        }
        pkg.updated = new Date().toISOString();
        this._writePackages(pkgs);
    }

    private _recordPackageDeployment(id: string, targetInstance: string, results: any[]): void {
        const pkgs = this._readPackages();
        const pkg = pkgs.find(p => p.id === id);
        if (!pkg) { return; }
        const now = new Date().toISOString();
        const user = process.env.USERNAME || process.env.USER || 'unknown';
        const statusByKey = new Map(results.map(r => [r.type + '|' + r.name, r.success ? 'success' : 'failed']));
        let succeeded = 0, failed = 0;
        for (const o of pkg.objects) {
            const st = statusByKey.get(o.type + '|' + o.name);
            if (st) { o.lastStatus = st; o.lastDeployed = now; o.lastDeployedBy = user; o.lastTarget = targetInstance; if (st === 'success') { succeeded++; } else { failed++; } }
        }
        // Package-level deployment summary + history for traceability (Dev → Test).
        pkg.lastDeployment = { at: now, by: user, target: targetInstance, succeeded, failed, total: succeeded + failed };
        pkg.history = Array.isArray(pkg.history) ? pkg.history : [];
        pkg.history.unshift(pkg.lastDeployment);
        if (pkg.history.length > 20) { pkg.history = pkg.history.slice(0, 20); }
        pkg.updated = now;
        this._writePackages(pkgs);
        this._sendPackages();
    }

    private async _exportPackage(id: string): Promise<void> {
        const pkg = this._readPackages().find(p => p.id === id);
        if (!pkg) { return; }
        const lines: string[] = [];
        lines.push(`Deployment Package: ${pkg.name}`);
        if (pkg.description) { lines.push(`Description: ${pkg.description}`); }
        lines.push(`Created: ${pkg.created}`);
        lines.push(`Last updated: ${pkg.updated}`);
        lines.push(`Objects: ${pkg.objects.length}`);
        if (pkg.lastDeployment) {
            const ld = pkg.lastDeployment;
            lines.push(`Last deployment: ${ld.at} to ${ld.target} by ${ld.by} — ${ld.succeeded} ok, ${ld.failed} failed`);
        }
        lines.push('');
        lines.push('Type'.padEnd(12) + 'Name'.padEnd(50) + 'Last deployed'.padEnd(26) + 'Status'.padEnd(10) + 'Target');
        lines.push('-'.repeat(120));
        for (const o of pkg.objects) {
            lines.push(
                String(o.type).padEnd(12) +
                String(o.name).slice(0, 48).padEnd(50) +
                String(o.lastDeployed || '—').padEnd(26) +
                String(o.lastStatus || '—').padEnd(10) +
                String(o.lastTarget || '—')
            );
            if (o.note) { lines.push(`    Note: ${o.note}`); }
        }
        if (Array.isArray(pkg.history) && pkg.history.length) {
            lines.push('');
            lines.push('Deployment history (most recent first)');
            lines.push('-'.repeat(120));
            for (const h of pkg.history) {
                lines.push(`${h.at}  ${String(h.target || '?').padEnd(28)}  by ${String(h.by || '?').padEnd(16)}  ${h.succeeded} ok, ${h.failed} failed`);
            }
        }
        const content = lines.join('\n');
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${pkg.name.replace(/[^\w.-]+/g, '_')}_deployment.txt`),
            filters: { 'Text files': ['txt'], 'All files': ['*'] }
        });
        if (!uri) { return; }
        fs.writeFileSync(uri.fsPath, content, 'utf8');
        vscode.window.showInformationMessage(`Exported package '${pkg.name}' to ${path.basename(uri.fsPath)}.`);
    }

    private async _autoPullDeployed(targetInstance: string, deployedResults: any[]) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) return;
        const rootPath = workspaceFolders[0].uri.fsPath;
        const config = ConfigManager.getConfig();

        // Parse instanceName: "environmentName_serverRealName"
        const envConfig = config.environments?.find((e: any) => targetInstance.startsWith(e.name + '_'));
        if (!envConfig) return;
        // Respect the per-environment "store files locally" setting — browse-only
        // targets must not get files written on deploy.
        if (envConfig.storeFilesLocally === false) return;
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
    .tag-dimension { background: #2d4b2d; color: #7fd37f; border: 1px solid #7fd37f55; }
    .tag-cube { background: #4a2d5c; color: #c48fe2; border: 1px solid #c48fe255; }
    .tag-view { background: #1a4a4a; color: #5cd3d3; border: 1px solid #5cd3d355; }
    .tag-subset { background: #4a3a1a; color: #d3b45c; border: 1px solid #d3b45c55; }
    .tag-application { background: #3a2d4a; color: #a98fd3; border: 1px solid #a98fd355; }
    .tag-remove { cursor: pointer; font-weight: bold; opacity: 0.7; margin-left: 2px; }
    .tag-remove:hover { opacity: 1; }
    .type-indicator { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
    .type-indicator-process { background: #264f78; color: #4fc1ff; }
    .type-indicator-rule { background: #5c3d1a; color: #e2a24e; }
    .type-indicator-dimension { background: #2d4b2d; color: #7fd37f; }
    .type-indicator-cube { background: #4a2d5c; color: #c48fe2; }
    .type-indicator-view { background: #1a4a4a; color: #5cd3d3; }
    .type-indicator-subset { background: #4a3a1a; color: #d3b45c; }
    .type-indicator-application { background: #3a2d4a; color: #a98fd3; }
    .type-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
    .type-pill { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 999px; cursor: pointer; font-size: 12px; font-weight: 600; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); color: var(--vscode-foreground); opacity: 0.75; transition: opacity .12s, border-color .12s; }
    .type-pill:hover { opacity: 1; }
    .type-pill.active { opacity: 1; border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
    .pill-count { font-size: 10px; font-weight: 700; opacity: 0.7; }
    .package-bar { margin-bottom: 14px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px; background: transparent; }
    .package-bar-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; user-select: none; border-radius: 8px; }
    .package-bar-head:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
    .package-bar-content { padding: 0 12px 12px 12px; }
    .package-bar.collapsed .package-bar-content { display: none; }
    .package-bar.collapsed .accordion-chevron { transform: rotate(0deg); }
    .package-bar:not(.collapsed) .accordion-chevron { transform: rotate(90deg); }
    .package-bar-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .package-bar-title { font-size: 13px; font-weight: 600; color: var(--vscode-descriptionForeground); }
    .package-optional { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .4px; padding: 1px 6px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: .8; }
    .package-head-summary { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: auto; }
    .package-info { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; }
    .package-active { color: var(--vscode-charts-green, #89d185); font-weight: 600; }
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
    Select source and target instances, choose objects, review changes, and deploy. Both instances must be connected via the PA-Code Explorer.
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
    <div class="step-header">Step 2 &mdash; Choose what to deploy</div>
    <div id="packagesBar" class="package-bar collapsed">
        <div class="package-bar-head" onclick="togglePackages()">
            <span class="accordion-chevron" id="pkgChevron">&#9656;</span>
            <span class="package-bar-title">&#128230; Deployment Package</span>
            <span class="package-optional">optional</span>
            <span id="pkgHeadSummary" class="package-head-summary"></span>
        </div>
        <div class="package-bar-content" id="packageBarContent">
            <div class="package-bar-row">
                <select id="packageSelect" onchange="onPackageSelect()" style="min-width:200px;"><option value="">&mdash; No package (ad-hoc) &mdash;</option></select>
                <button class="btn" type="button" style="font-size:12px;" onclick="loadSelectedPackage()" title="Load this package's objects into the selection">&#128194; Load</button>
                <button class="btn btn-primary" type="button" style="font-size:12px;" onclick="saveAsPackage()" title="Save the current selection as a new package or update an existing one">&#128190; Save as Package&hellip;</button>
                <button class="btn" type="button" style="font-size:12px;" onclick="exportSelectedPackage()" title="Export the package and its deploy history to a text file">&#128228; Export</button>
                <button class="btn" type="button" style="font-size:12px;" onclick="deleteSelectedPackage()">&#128465; Delete</button>
            </div>
            <div id="packageInfo" class="package-info"></div>
        </div>
    </div>
    <label>Object type &mdash; pick one, add objects, switch type to mix several in one deployment</label>
    <div id="typePills" class="type-pills"></div>
    <div class="search-container" style="margin-top:12px;">
        <label>Search &amp; add <span id="searchTypeLabel" style="font-weight:600;color:var(--vscode-foreground);">TI Processes</span></label>
        <input type="text" id="objectSearch" placeholder="Type to search..." oninput="onSearchInput()" onkeydown="onSearchKeydown(event)" />
        <div class="suggestions" id="suggestions"></div>
    </div>
    <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn" type="button" style="font-size:12px;" onclick="toggleBrowse()" id="btnBrowse">&#9776; Browse / Select Multiple</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="togglePasteBox()" id="btnPaste">&#128203; Paste List</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="loadFromLog()">&#128193; Load from Log</button>
        <button class="btn" type="button" style="font-size:12px;" onclick="clearSelected()">Clear List</button>
    </div>
    <div id="cubeDataRow" style="display:none; margin-top:10px; align-items:center; gap:8px; font-size:12px;" title="Only applies to Cube objects. On: populated leaf cells are copied to the target in bulk (fast — one batched write, not cell by cell). Off: only the empty cube structure is created.">
        <input type="checkbox" id="copyCubeData"> <label for="copyCubeData" style="cursor:pointer;">Include cube data when deploying cubes (bulk copy &mdash; otherwise create an empty cube shell)</label>
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
        <label style="font-size:12px;">Paste a list of object names &mdash; one per line. Names are matched against the <strong>source</strong> instance; the active object type (see pills above) is tried first, then the others.</label>
        <textarea id="pasteInput" rows="8" placeholder="Process1&#10;Process2&#10;Process3&#10;..." style="width:100%; box-sizing:border-box; margin-top:6px; padding:6px 8px; border-radius:6px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground); font-family:var(--vscode-editor-font-family, monospace); font-size:12px; resize:vertical;"></textarea>
        <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
            <button class="btn btn-primary" type="button" onclick="importPasteList()">Import &amp; Select</button>
            <button class="btn" type="button" onclick="clearPasteBox()">Clear</button>
        </div>
        <div id="pasteResult" style="margin-top:6px;"></div>
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
        <thead><tr><th>Object</th><th>Type</th><th>Status</th><th>Action</th><th>Diff</th><th>Note</th><th></th></tr></thead>
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
const OBJ_TYPES = {
    process:   { label: 'TI Process', short: 'TI' },
    rule:      { label: 'Rule',       short: 'RX' },
    dimension: { label: 'Dimension',  short: 'DM' },
    cube:      { label: 'Cube',        short: 'CB' },
    view:      { label: 'View',        short: 'VW' },
    subset:    { label: 'Subset',      short: 'SB' },
    application:{ label: 'Application', short: 'AP' }
};
let objectsByType = { process: [], rule: [], dimension: [], cube: [], view: [], subset: [], application: [] };
let selectedObjects = [];
let checkResults = [];
let connectedInstances = [];
let suggestionIndex = -1;
let currentType = 'process';
let browseChecked = new Set();
let packages = [];
let activePackageId = '';
let objectNotes = {};

window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.command) {
        case 'init':
            connectedInstances = msg.connectedInstances || [];
            populateInstanceDropdowns(connectedInstances);
            if (msg.preselectSource && connectedInstances.includes(msg.preselectSource)) {
                const s = document.getElementById('sourceInstance');
                s.value = msg.preselectSource;
                onInstanceChange();
            }
            if (document.getElementById('sourceInstance').value && document.getElementById('targetInstance').value) loadBothTypes();
            break;
        case 'objectList':
            objectsByType[msg.objectType] = msg.names || [];
            showSuggestions();
            renderTypePills();
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
        case 'packages':
            packages = msg.packages || [];
            renderPackages();
            break;
        case 'packageLoaded':
            applyLoadedPackage(msg.pkg);
            break;
        case 'packageSaved':
            activePackageId = msg.id;
            document.getElementById('packagesBar').classList.remove('collapsed');
            setTimeout(function () { renderPackages(); document.getElementById('packageSelect').value = activePackageId; updatePackageInfo(); }, 0);
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
    objectsByType = { process: [], rule: [], dimension: [], cube: [], view: [], subset: [], application: [] };
    activePackageId = '';
    document.getElementById('packageSelect').value = '';
    updatePackageInfo();
    renderTags();
    renderTypePills();
}

function loadBothTypes() {
    const src = document.getElementById('sourceInstance').value;
    if (!src) return;
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'process' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'rule' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'dimension' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'cube' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'view' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'subset' });
    vscode.postMessage({ command: 'loadObjects', instanceName: src, objectType: 'application' });
}

function onTypeChange() {
    setType(document.getElementById('objectType') ? document.getElementById('objectType').value : currentType);
}

function setType(t) {
    currentType = t;
    document.getElementById('objectSearch').value = '';
    document.getElementById('suggestions').style.display = 'none';
    suggestionIndex = -1;
    browseChecked.clear();
    const lbl = document.getElementById('searchTypeLabel');
    if (lbl) { lbl.textContent = ((OBJ_TYPES[t] || {}).label || t) + 's'; }
    renderTypePills();
    updateCubeDataVisibility();
    if (document.getElementById('browseBox') && document.getElementById('browseBox').style.display !== 'none') renderBrowseList();
}

function renderTypePills() {
    const el = document.getElementById('typePills');
    if (!el) return;
    el.innerHTML = Object.keys(OBJ_TYPES).map(function (t) {
        const info = OBJ_TYPES[t];
        const cnt = (objectsByType[t] || []).length;
        const active = (t === currentType) ? ' active' : '';
        return '<button type="button" class="type-pill' + active + '" onclick="setType(\\'' + t + '\\')" title="' + cnt + ' available on source">'
            + '<span class="type-indicator type-indicator-' + t + '">' + info.short + '</span> ' + escapeHtml(info.label)
            + (cnt ? ' <span class="pill-count">' + cnt + '</span>' : '') + '</button>';
    }).join('');
}

function updateCubeDataVisibility() {
    const row = document.getElementById('cubeDataRow');
    if (!row) return;
    const relevant = (currentType === 'cube') || selectedObjects.some(function (o) { return o.type === 'cube'; });
    row.style.display = relevant ? 'flex' : 'none';
}

function onSearchInput() {
    suggestionIndex = -1;
    showSuggestions();
}

function getCurrentObjects() {
    return objectsByType[currentType] || [];
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
    const typeLabel = (OBJ_TYPES[currentType] || {}).short || '?';
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
        const prefix = (OBJ_TYPES[o.type] || {}).short || '?';
        return '<span class="' + cls + '">'
            + '<span class="type-indicator type-indicator-' + o.type + '">' + prefix + '</span> '
            + escapeHtml(o.name)
            + ' <span class="tag-remove" onclick="removeObject(\\'' + escapeJs(o.name) + '\\', \\'' + o.type + '\\')">&times;</span>'
            + '</span>';
    }).join('');
    document.getElementById('btnCheck').disabled = selectedObjects.length === 0;
    updateCubeDataVisibility();
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
    const typeLabel = (OBJ_TYPES[currentType] || {}).short || '?';
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
    const anyLoaded = Object.keys(OBJ_TYPES).some(function (t) { return (objectsByType[t] || []).length > 0; });
    if (!anyLoaded) {
        resultEl.innerHTML = '<span style="color:#f85149;font-size:12px;">Select a connected Source and Target first so the object lists are loaded.</span>';
        return;
    }
    const raw = document.getElementById('pasteInput').value || '';
    // One name per line; also tolerate comma/semicolon/tab separators.
    const rawNames = raw.split(/[\\r\\n,;\\t]+/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
    // Strip surrounding quotes and a trailing .ti/.rux/.pro extension if present.
    const clean = function (n) { return n.replace(/^["']|["']$/g, '').replace(/\\.(ti|rux|pro)$/i, '').trim(); };
    const typeOrder = [currentType].concat(Object.keys(OBJ_TYPES).filter(function (t) { return t !== currentType; }));
    const maps = {};
    Object.keys(OBJ_TYPES).forEach(function (t) { maps[t] = new Map((objectsByType[t] || []).map(function (n) { return [n.toLowerCase(), n]; })); });
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
        for (const t of typeOrder) { if (maps[t].has(key)) { match = maps[t].get(key); type = t; break; } }
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
        const typeLabel = (OBJ_TYPES[r.type] || {}).label || r.type;
        const typeCls = 'type-indicator type-indicator-' + r.type;
        const canCompare = (r.type === 'process' || r.type === 'rule');
        const compareBtn = (canCompare && r.exists)
            ? '<button class="btn btn-secondary" onclick="doCompare(\\'' + escapeJs(r.name) + '\\', \\'' + r.type + '\\')">Compare</button>'
            : '<span style="color:var(--vscode-descriptionForeground);font-size:12px;">' + (r.exists ? 'Structural update' : 'New ' + typeLabel.toLowerCase()) + '</span>';
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
        return '<tr><td>' + escapeHtml(r.name) + '</td><td><span class="' + typeCls + '">' + typeLabel + '</span></td><td>' + (r.exists ? 'Exists on target' : 'Not on target') + '</td><td>' + badge + '</td><td>' + diffStats + '</td><td><input type="text" value="' + escapeHtml(objectNotes[r.type + '|' + r.name] || '') + '" placeholder="note…" style="width:140px;font-size:11px;padding:2px 4px;" oninput="onNoteEdit(\\'' + r.type + '\\', \\'' + escapeJs(r.name) + '\\', this.value)"></td><td>' + compareBtn + '</td></tr>';
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
    vscode.postMessage({ command: 'deploy', sourceInstance: src, targetInstance: tgt, objects: checkResults, copyCubeData: document.getElementById('copyCubeData').checked, packageId: activePackageId || undefined });
}

// ---- Deployment packages ----
function togglePackages() {
    document.getElementById('packagesBar').classList.toggle('collapsed');
}

function renderPackages() {
    const sel = document.getElementById('packageSelect');
    const cur = sel.value || activePackageId;
    let html = '<option value="">\\u2014 None \\u2014</option>';
    for (const p of packages) {
        const count = p.objects ? p.objects.length : 0;
        const upd = p.updated ? ' · ' + String(p.updated).slice(0, 10) : '';
        html += '<option value="' + escapeHtml(p.id) + '"' + (p.id === cur ? ' selected' : '') + '>' + escapeHtml(p.name) + ' (' + count + upd + ')</option>';
    }
    sel.innerHTML = html;
    updatePackageInfo();
}

function onPackageSelect() {
    updatePackageInfo();
}

function fmtTs(ts) {
    if (!ts) return '\\u2014';
    return String(ts).slice(0, 16).replace('T', ' ');
}

function updatePackageInfo() {
    const id = document.getElementById('packageSelect').value;
    const p = packages.find(x => x.id === id);
    const info = document.getElementById('packageInfo');
    const head = document.getElementById('pkgHeadSummary');
    if (!p) {
        if (head) { head.textContent = activePackageId ? '' : (packages.length ? packages.length + ' saved' : 'not used'); }
        info.innerHTML = activePackageId
            ? 'Ad-hoc mode. Load a package to track deploy history, or press <b>Save as Package</b> to capture this selection.'
            : 'Packages are <b>optional</b>. They let you bundle a set of objects, add per-object notes and keep a full deploy history &mdash; handy for controlled Dev \\u2192 Test \\u2192 Prod promotion. You can deploy without one.';
        return;
    }
    const count = p.objects ? p.objects.length : 0;
    if (head) { head.textContent = (activePackageId === p.id ? '\\u25CF ' : '') + p.name + ' · ' + count + ' obj'; }
    const active = (activePackageId === p.id) ? '<span class="package-active">\\u25CF ACTIVE</span>' : '<span style="opacity:.7;">not loaded \\u2014 press Load</span>';
    let html = '<div>' + active + ' &nbsp;·&nbsp; <b>' + count + '</b> object(s)';
    if (p.description) { html += ' &nbsp;·&nbsp; ' + escapeHtml(p.description); }
    html += '</div>';
    html += '<div style="margin-top:3px;">Created ' + fmtTs(p.created) + ' &nbsp;·&nbsp; Updated ' + fmtTs(p.updated) + '</div>';
    const ld = p.lastDeployment;
    if (ld) {
        const okTxt = '<span class="package-active">' + ld.succeeded + ' ok</span>';
        const failTxt = ld.failed ? ' / <span style="color:#f85149;font-weight:600;">' + ld.failed + ' failed</span>' : '';
        html += '<div style="margin-top:3px;">Last deployed ' + fmtTs(ld.at) + ' to <b>' + escapeHtml(ld.target || '?') + '</b> by ' + escapeHtml(ld.by || '?') + ' &nbsp;·&nbsp; ' + okTxt + failTxt + '</div>';
        if (Array.isArray(p.history) && p.history.length > 1) {
            html += '<div style="margin-top:2px;opacity:.75;">' + p.history.length + ' deployment(s) recorded \\u2014 full history in Export.</div>';
        }
    } else {
        html += '<div style="margin-top:3px;opacity:.75;">Never deployed yet.</div>';
    }
    info.innerHTML = html;
}

function loadSelectedPackage() {
    const id = document.getElementById('packageSelect').value;
    if (!id) { showError('Select a package to load.'); return; }
    vscode.postMessage({ command: 'loadPackage', id: id });
}

function applyLoadedPackage(pkg) {
    if (!pkg) return;
    activePackageId = pkg.id;
    objectNotes = {};
    selectedObjects = (pkg.objects || []).map(o => ({ name: o.name, type: o.type }));
    for (const o of (pkg.objects || [])) { if (o.note) objectNotes[o.type + '|' + o.name] = o.note; }
    checkResults = [];
    document.getElementById('step3').classList.add('step-disabled');
    document.getElementById('packageSelect').value = pkg.id;
    document.getElementById('packagesBar').classList.remove('collapsed');
    renderTags();
    updatePackageInfo();
}

function saveAsPackage() {
    if (selectedObjects.length === 0) { showError('Select objects first, then save them as a package.'); return; }
    const objects = selectedObjects.map(o => ({ name: o.name, type: o.type, note: objectNotes[o.type + '|' + o.name] || '' }));
    vscode.postMessage({ command: 'savePackage', objects: objects });
}

function exportSelectedPackage() {
    const id = document.getElementById('packageSelect').value;
    if (!id) { showError('Select a package to export.'); return; }
    vscode.postMessage({ command: 'exportPackage', id: id });
}

function deleteSelectedPackage() {
    const id = document.getElementById('packageSelect').value;
    if (!id) { showError('Select a package to delete.'); return; }
    if (activePackageId === id) { activePackageId = ''; }
    vscode.postMessage({ command: 'deletePackage', id: id });
}

function onNoteEdit(type, name, value) {
    objectNotes[type + '|' + name] = value;
    if (activePackageId) {
        vscode.postMessage({ command: 'savePackageNotes', id: activePackageId, notes: [{ type: type, name: name, note: value }] });
    }
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
        const typeLabel = (OBJ_TYPES[r.type] || {}).label || r.type;
        const typeCls = 'type-indicator type-indicator-' + r.type;
        const detail = r.success ? ('\\u2714' + (r.note ? ' ' + escapeHtml(r.note) : '')) : escapeHtml(r.error || '');
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
vscode.postMessage({ command: 'listPackages' });
renderTypePills();
</script>
</body>
</html>`;
    }
}

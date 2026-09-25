import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ProcessProvider, TM1TreeItem } from './ProcessProvider';
import { ProcessParser } from './processParser';
import { ConfigManager } from './ConfigManager';
import { SettingsPanel } from './SettingsPanel';
import { ProcessCodeLensProvider } from './ProcessCodeLensProvider';
import { ProcessExecutionPanel } from './ProcessExecutionPanel';
import { CelebrationPanel } from './CelebrationPanel';
import { TM1Formatter } from './TM1Formatter';
import { TM1CompletionProvider } from './TM1CompletionProvider';
import { CAMLoginPanel } from './CAMLoginPanel';
import { TM1DebugAdapterFactory, TM1DebugConfigurationProvider } from './TM1DebugAdapter';
import { ConfigurationPanel } from './ConfigurationPanel';
import { ThreadViewerPanel } from './ThreadViewerPanel';
import { TIConsolePanel } from './TIConsolePanel';
import { FileManagerPanel } from './FileManagerPanel';
import { TM1FunctionReferenceProvider } from './TM1FunctionReferenceProvider';
import { TM1FunctionSnippetProvider } from './TM1FunctionSnippetProvider';
import { TM1VariableCompletionProvider } from './TM1VariableCompletionProvider';
import { TM1SignatureHelpProvider } from './TM1SignatureHelpProvider';
import { TM1HoverProvider } from './TM1HoverProvider';
import { TM1FunctionHoverProvider } from './TM1FunctionHoverProvider';
import { TM1Function } from './TM1FunctionDatabase';
import { DeploymentPanel } from './DeploymentPanel';
import { InstanceHubPanel } from './InstanceHubPanel';
import { BulkDeletePanel } from './BulkDeletePanel';
import { LogViewerPanel } from './LogViewerPanel';
import { SecurityPanel } from './SecurityPanel';
import { MDXWizardPanel } from './MDXWizardPanel';
import { LineagePanel } from './LineagePanel';
import { SubsetEditorPanel } from './SubsetEditorPanel';
import { CubeViewerPanel } from './CubeViewerPanel';
import { ChoreManagerPanel } from './ChoreManagerPanel';
import { ProcessPropertiesPanel } from './ProcessPropertiesPanel';
import { RecentItemsProvider, FavoritesProvider, QuickActionsProvider, ActivityBarItem } from './ActivityBarProviders';
import { ProxyHelper } from './ProxyHelper';
import { WhatsNewPanel } from './WhatsNewPanel';
import { PawOAuthService } from './PawOAuthService';
import { Tm1McpServer } from './mcp/Tm1McpServer';
import { TM1FoldingProvider } from './TM1FoldingProvider';
import { ProcessBaseline, SyncKind } from './ProcessBaseline';

/** Builds the local .ti file representation from a process' server content. */
function buildProcessFileContent(content: { Prolog: string; Metadata: string; Data: string; Epilog: string; PropertiesJSON: string }): string {
    // Write LF-only: .gitattributes forces *.ti eol=lf, so emitting the server's
    // CRLF here would make Git flag an untouched file as modified (EOL-only diff).
    const lf = (s: string) => (s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return `#SECTION Prolog\n${lf(content.Prolog)}\n\n#SECTION Metadata\n${lf(content.Metadata)}\n\n#SECTION Data\n${lf(content.Data)}\n\n#SECTION Epilog\n${lf(content.Epilog)}\n\n#JSON_PROPERTIES\n${lf(content.PropertiesJSON)}`;
}

/** Normalises text to LF so files written to disk match Git's eol=lf checkout. */
function toLf(s: string): string {
    return (s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Resolves a local .ti/.rux file path to its sync target (kind + instance +
 * object name), based on the `<env-folder>/<server>/<Processes|Rules|…>/<name>.<ext>`
 * layout. Returns undefined for files that are not pa-code project objects.
 */
function resolveSyncTarget(filePath: string): { kind: SyncKind; instanceId: string; name: string } | undefined {
    const ext = path.extname(filePath);
    if (ext !== '.ti' && ext !== '.rux') return undefined;
    const parentDir = path.dirname(filePath);
    const serverFolder = path.dirname(parentDir);
    const serverRealName = path.basename(serverFolder);
    const envFolder = path.basename(path.dirname(serverFolder));
    const config = ConfigManager.getConfig();
    const envConfig = (config.environments || []).find((e: any) => e.folder === envFolder);
    if (!envConfig) return undefined;
    return { kind: ext === '.ti' ? 'process' : 'rule', instanceId: `${envConfig.name}_${serverRealName}`, name: path.basename(filePath, ext) };
}

export function activate(context: vscode.ExtensionContext) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

    // Give ConfigManager access to VS Code storage (connections now live there
    // by default; the legacy tm1-project.json is still read if present).
    ConfigManager.init(context);

    // Route all HTTP(S) traffic through the correct agent based on VS Code
    // proxy settings + environment variables (respects http.noProxy).
    TM1Service.installProxyInterceptor();

    // Show the "What's New" page once after an update to a new version.
    WhatsNewPanel.maybeShow(context);

    // Provide a real MCP server (Tools + Resources + Prompts) backed by the live
    // connection. Started lazily on first use; no port is opened otherwise.
    // SecretStorage lets it persist the bearer token so external MCP clients
    // (Claude, Codex, Cline, Continue, …) can be configured once and keep working.
    const mcpServer = new Tm1McpServer(context.secrets);
    context.subscriptions.push({ dispose: () => mcpServer.dispose() });
    const mcpDidChange = new vscode.EventEmitter<void>();
    context.subscriptions.push(mcpDidChange);
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('paCodeTm1Mcp', {
        onDidChangeMcpServerDefinitions: mcpDidChange.event,
        provideMcpServerDefinitions: async () => {
            const enabled = vscode.workspace.getConfiguration('pa-code').get<boolean>('mcpServer.enabled', true);
            if (!enabled) return [];
            const ep = await mcpServer.ensureStarted();
            return [new vscode.McpHttpServerDefinition(
                'pa-code TM1 Model',
                vscode.Uri.parse(ep.uri),
                { 'Authorization': `Bearer ${ep.token}` },
                ep.version
            )];
        }
    }));

    // Reveal the MCP endpoint + token so users can wire it into ANY MCP-aware AI
    // tool (Claude Code/Desktop, Codex, Cline, Continue, …) — not just Copilot.
    context.subscriptions.push(vscode.commands.registerCommand('pa-code.showMcpEndpoint', async () => {
        const enabled = vscode.workspace.getConfiguration('pa-code').get<boolean>('mcpServer.enabled', true);
        if (!enabled) {
            const pick = await vscode.window.showWarningMessage(
                'The pa-code MCP server is disabled. Enable it to use it with external AI tools.',
                'Open Settings');
            if (pick === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'pa-code.mcpServer');
            }
            return;
        }

        const ep = await mcpServer.ensureStarted();
        const authHeader = `Authorization: Bearer ${ep.token}`;

        // Generic Streamable-HTTP MCP config used by most clients
        // (Claude Desktop, Cline, Continue, Cursor, Codex, …).
        const jsonSnippet = JSON.stringify({
            mcpServers: {
                'pa-code-tm1': {
                    type: 'http',
                    url: ep.uri,
                    headers: { 'Authorization': `Bearer ${ep.token}` }
                }
            }
        }, null, 2);

        // Claude Code CLI one-liner.
        const claudeCli = `claude mcp add --transport http pa-code-tm1 ${ep.uri} --header "Authorization: Bearer ${ep.token}"`;

        // Codex CLI. Codex reads the bearer token from an environment variable,
        // so we prefer the configured tokenEnvVar; otherwise we suggest one and
        // include the setx command to create it with the current token.
        const tokenEnvVar = (vscode.workspace.getConfiguration('pa-code').get<string>('mcpServer.tokenEnvVar', '') || '').trim() || 'PA_CODE_MCP_TOKEN';
        const codexCli = `setx ${tokenEnvVar} ${ep.token}\ncodex mcp add pa_code_tm1 --url ${ep.uri} --bearer-token-env-var ${tokenEnvVar}`;

        // stdio<->HTTP bridge for clients that only speak stdio MCP.
        const stdioBridge = `npx -y mcp-remote ${ep.uri} --header "Authorization: Bearer ${ep.token}"`;

        const fixedPort = vscode.workspace.getConfiguration('pa-code').get<number>('mcpServer.port', 0) || 0;

        type Item = vscode.QuickPickItem & { action: string };
        const items: Item[] = [
            { label: '$(copy) Copy config JSON (mcpServers / HTTP)', description: 'Claude Desktop, Cline, Continue, Cursor, …', action: 'json' },
            { label: '$(copy) Copy Claude Code CLI command', description: 'claude mcp add --transport http …', action: 'claude' },
            { label: '$(copy) Copy Codex CLI commands', description: 'setx token + codex mcp add …', action: 'codex' },
            { label: '$(copy) Copy stdio bridge command (mcp-remote)', description: 'For clients that only support stdio MCP', action: 'bridge' },
            { label: '$(link) Copy endpoint URL', description: ep.uri, action: 'url' },
            { label: '$(key) Copy bearer token', description: 'Authorization header value', action: 'token' },
            { label: '$(refresh) Regenerate token', description: 'Invalidates clients configured with the old token', action: 'regen' },
        ];
        if (fixedPort === 0) {
            items.push({ label: '$(gear) Set a fixed port…', description: 'Recommended for a stable external URL', action: 'setport' });
        }

        const detail = fixedPort === 0
            ? 'Note: the port is dynamic and changes each VS Code session. Set a fixed port for a stable config.'
            : `Fixed port ${fixedPort} — the URL is stable across restarts.`;

        const chosen = await vscode.window.showQuickPick(items, {
            title: `pa-code MCP endpoint — ${ep.uri}`,
            placeHolder: detail,
            ignoreFocusOut: true
        });
        if (!chosen) return;

        const copy = async (text: string, what: string) => {
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`${what} copied to clipboard.`);
        };

        switch (chosen.action) {
            case 'json': await copy(jsonSnippet, 'MCP config JSON'); break;
            case 'claude': await copy(claudeCli, 'Claude Code command'); break;
            case 'codex': await copy(codexCli, 'Codex commands (setx + codex mcp add)'); break;
            case 'bridge': await copy(stdioBridge, 'stdio bridge command'); break;
            case 'url': await copy(ep.uri, 'Endpoint URL'); break;
            case 'token': await copy(ep.token, 'Bearer token'); break;
            case 'setport':
                vscode.commands.executeCommand('workbench.action.openSettings', 'pa-code.mcpServer.port');
                break;
            case 'regen': {
                const ok = await vscode.window.showWarningMessage(
                    'Regenerate the MCP bearer token? Any external client using the current token must be reconfigured.',
                    { modal: true }, 'Regenerate');
                if (ok === 'Regenerate') {
                    await mcpServer.regenerateToken();
                    mcpDidChange.fire(); // refresh the token handed to the Copilot agent
                    vscode.window.showInformationMessage('MCP token regenerated. Re-run "PA Code: Show MCP Endpoint" to copy the new configuration.');
                }
                break;
            }
        }
    }));

    // Re-bind the MCP server when its port, token source or enabled state
    // changes so a fixed port / env-var token takes effect without a full reload.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (e) => {
        if (e.affectsConfiguration('pa-code.mcpServer.port')
            || e.affectsConfiguration('pa-code.mcpServer.enabled')
            || e.affectsConfiguration('pa-code.mcpServer.tokenEnvVar')
            || e.affectsConfiguration('pa-code.mcpServer.mode')
            || e.affectsConfiguration('pa-code.mcpServer.autoStart')) {
            const wasRunning = mcpServer.isRunning;
            mcpServer.dispose();
            mcpDidChange.fire();
            const cfg = vscode.workspace.getConfiguration('pa-code');
            const enabled = cfg.get<boolean>('mcpServer.enabled', true);
            const autoStart = cfg.get<boolean>('mcpServer.autoStart', false);
            if (enabled && (wasRunning || autoStart)) {
                try { await mcpServer.ensureStarted(); } catch { /* ignore */ }
            }
        }
    }));

    // Optionally start the MCP listener eagerly on activation. Needed for
    // external AI tools (e.g. Codex) that connect on their own and can't wait
    // for VS Code/Copilot to request the server definition first.
    {
        const cfg = vscode.workspace.getConfiguration('pa-code');
        if (cfg.get<boolean>('mcpServer.enabled', true) && cfg.get<boolean>('mcpServer.autoStart', false)) {
            mcpServer.ensureStarted().catch(err => console.error('[pa-code MCP autoStart]', err));
        }
    }

    // Open the Integrated Login (Kerberos/NTLM) diagnostic log on demand.
    context.subscriptions.push(vscode.commands.registerCommand('pa-code.showIntegratedLoginLog', () => {
        TM1Service.showIntegratedLog();
    }));

    const processProvider = new ProcessProvider();

    // Per-process baseline hashes for server-side change detection on save.
    const processBaseline = new ProcessBaseline(context);

    // Offline protection: files marked offline are never overwritten by Pull All.
    const offlineDecoRefresh = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    const toggleOfflineCmd = vscode.commands.registerCommand('pa-code.toggleOfflineProtection', async (arg?: vscode.Uri) => {
        const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
        if (!uri) return;
        const target = resolveSyncTarget(uri.fsPath);
        if (!target) {
            vscode.window.showWarningMessage('Offline protection only applies to pa-code .ti / .rux files inside a project folder.');
            return;
        }
        const currentlyOffline = processBaseline.isOffline(target.kind, target.instanceId, target.name);
        await processBaseline.setOffline(target.kind, target.instanceId, target.name, !currentlyOffline);
        offlineDecoRefresh.fire(uri);
        vscode.window.showInformationMessage(!currentlyOffline
            ? `'${target.name}' is now OFFLINE — Pull All will not overwrite it.`
            : `'${target.name}' is back ONLINE — Pull All may update it.`);
    });
    const offlineDecoProvider: vscode.FileDecorationProvider = {
        onDidChangeFileDecorations: offlineDecoRefresh.event,
        provideFileDecoration(uri) {
            const target = resolveSyncTarget(uri.fsPath);
            if (target && processBaseline.isOffline(target.kind, target.instanceId, target.name)) {
                return { badge: 'O', color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'), tooltip: 'Offline — protected from Pull All' };
            }
            return undefined;
        }
    };
    context.subscriptions.push(toggleOfflineCmd, offlineDecoRefresh, vscode.window.registerFileDecorationProvider(offlineDecoProvider));

    // Auto-push-on-save toggle + status bar (enables a manual "publish" workflow).
    const autoPushStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    autoPushStatus.command = 'pa-code.toggleAutoPush';
    function updateAutoPushStatus() {
        const on = vscode.workspace.getConfiguration('pa-code').get<boolean>('autoPushOnSave', true);
        autoPushStatus.text = on ? '$(cloud) TM1: Auto-Push On' : '$(cloud-offline) TM1: Auto-Push Off';
        autoPushStatus.tooltip = on
            ? 'TM1 changes are pushed to the server on save. Click to switch to manual publish.'
            : 'TM1 changes are NOT pushed on save. Run "PA Code: Publish Changed Files" to push. Click to re-enable auto-push.';
        autoPushStatus.show();
    }
    updateAutoPushStatus();
    const toggleAutoPushCmd = vscode.commands.registerCommand('pa-code.toggleAutoPush', async () => {
        const cfg = vscode.workspace.getConfiguration('pa-code');
        const cur = cfg.get<boolean>('autoPushOnSave', true);
        await cfg.update('autoPushOnSave', !cur, vscode.ConfigurationTarget.Global);
        updateAutoPushStatus();
        vscode.window.showInformationMessage(!cur
            ? 'TM1 auto-push on save is ON — saving a .ti/.rux pushes it to the server.'
            : 'TM1 auto-push on save is OFF — edits stay local until you run "PA Code: Publish Changed Files".');
    });
    context.subscriptions.push(autoPushStatus, toggleAutoPushCmd,
        vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('pa-code.autoPushOnSave')) updateAutoPushStatus(); }));

    // Reload connections from the (possibly relocated) tm1-project.json when its
    // configured location changes.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('pa-code.projectFile.location')
            || e.affectsConfiguration('pa-code.connections.defaultScope')) processProvider.refresh();
    }));

    // Migrate legacy tm1-project.json connections into VS Code storage, then
    // optionally delete the file.
    context.subscriptions.push(vscode.commands.registerCommand('pa-code.moveConnectionsToVSCode', async () => {
        if (!ConfigManager.hasProjectFile()) {
            vscode.window.showInformationMessage('No tm1-project.json connections found to move.');
            return;
        }
        const cfg = ConfigManager.getConfig();
        const fileCount = cfg.environments.filter(e => e.scope === 'file').length;
        if (fileCount === 0) {
            vscode.window.showInformationMessage('Your connections are already stored in VS Code.');
            return;
        }
        const scopePick = await vscode.window.showQuickPick(
            [
                { label: 'This workspace only', detail: 'Available when this folder is open (not shared via git).', value: 'workspace' as const },
                { label: 'All workspaces (global)', detail: 'Available in every VS Code window for your user.', value: 'global' as const }
            ],
            { placeHolder: `Move ${fileCount} connection(s) from tm1-project.json into VS Code…`, ignoreFocusOut: true }
        );
        if (!scopePick) return;
        const migrated = cfg.environments.map(e => e.scope === 'file' ? { ...e, scope: scopePick.value } : e);
        ConfigManager.saveConfig({ environments: migrated, featureSettings: cfg.featureSettings });

        const del = await vscode.window.showWarningMessage(
            `Moved ${fileCount} connection(s) into VS Code (${scopePick.value}). Delete the tm1-project.json file now?`,
            { modal: true }, 'Delete file', 'Keep file');
        if (del === 'Delete file') {
            ConfigManager.deleteProjectFile();
            vscode.window.showInformationMessage('tm1-project.json deleted. Connections now live in VS Code.');
        }
        processProvider.refresh();
    }));

    /**
     * Helper: If a command is invoked via shortcut (no tree item),
     * auto-resolve the connected instance. If multiple are connected, show a picker.
     */
    async function resolveInstance(item?: TM1TreeItem): Promise<TM1TreeItem | undefined> {
        if (item && item.type === 'instance') return item;
        // Data-model tree items (dimension/hierarchy/subset/cube/view) already carry
        // a connected instanceName — use it directly instead of prompting.
        if (item && item.instanceName && TM1Service.getInstance().isConnected(item.instanceName)) {
            return item;
        }

        const connectedNames = TM1Service.getInstance().getConnectedInstanceNames();
        if (connectedNames.length === 0) {
            vscode.window.showWarningMessage('No connected TM1 instance.');
            return undefined;
        }

        let instanceName: string;
        if (connectedNames.length === 1) {
            instanceName = connectedNames[0];
        } else {
            const picked = await vscode.window.showQuickPick(connectedNames, { placeHolder: 'Select TM1 Instance' });
            if (!picked) return undefined;
            instanceName = picked;
        }

        // Find the environment name by checking which config environment this instance belongs to
        const config = ConfigManager.getConfig();
        let envName = '';
        for (const env of config.environments || []) {
            if (instanceName.startsWith(env.name + '_')) {
                envName = env.name;
                break;
            }
        }
        if (!envName) envName = instanceName.substring(0, instanceName.indexOf('_'));

        return {
            type: 'instance',
            environmentName: envName,
            instanceName: instanceName,
            contextValue: 'tm1instance_connected'
        } as any;
    }
    vscode.window.registerTreeDataProvider('tm1ProcessView', processProvider);

    const recentItemsProvider = new RecentItemsProvider();
    recentItemsProvider.setContext(context);
    vscode.window.registerTreeDataProvider('tm1RecentItems', recentItemsProvider);

    const favoritesProvider = new FavoritesProvider();
    favoritesProvider.setContext(context);
    vscode.window.registerTreeDataProvider('tm1Favorites', favoritesProvider);

    const quickActionsProvider = new QuickActionsProvider();
    vscode.window.registerTreeDataProvider('tm1QuickActions', quickActionsProvider);

    // Status-bar indicator while impersonating another user (v11).
    const impersonationStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    impersonationStatus.command = 'pa-code.stopImpersonating';
    context.subscriptions.push(impersonationStatus);
    const updateImpersonationStatus = () => {
        const svc = TM1Service.getInstance();
        const active = svc.getConnectedInstanceNames()
            .map(n => ({ n, u: svc.getImpersonation(n) }))
            .filter(x => !!x.u);
        if (active.length) {
            impersonationStatus.text = `$(account) Impersonating: ${active[0].u}`;
            impersonationStatus.tooltip = active.map(a => `${a.u} @ ${a.n}`).join('\n') + '\nClick to stop impersonating.';
            impersonationStatus.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            impersonationStatus.show();
        } else {
            impersonationStatus.hide();
        }
    };

    // Helper: Ask user to pull all after connecting
    const askPullAllAfterConnect = (instanceName: string, environmentName: string, serverRealName: string) => {
        quickActionsProvider.refresh();
        CelebrationPanel.maybeDailyGreeting(context);
        const doPull = () => vscode.commands.executeCommand('pa-code.syncFromTM1', {
            type: 'instance', environmentName, instanceName, contextValue: 'tm1instance_connected'
        });
        const envConfig = ConfigManager.getConfig().environments.find((e: any) => e.name === environmentName);
        const mode = envConfig?.pullOnConnect || 'ask';
        if (mode === 'never') { return; }
        if (mode === 'auto') { doPull(); return; }
        vscode.window.showInformationMessage(
            `Connected to ${serverRealName}. Pull all processes from server?`,
            'Pull All', 'Skip'
        ).then(choice => { if (choice === 'Pull All') { doPull(); } });
    };

    // Register CodeLens provider
    const codeLensProvider = new ProcessCodeLensProvider();
    const codeLensDisposable = vscode.languages.registerCodeLensProvider({ language: 'tm1' }, codeLensProvider);

    // --- COMMAND: CONNECT (Kontext-Sensitiv) ---
    // Dieser Befehl wird aufgerufen, wenn man Rechtsklick auf eine Instanz macht
    let connectCmd = vscode.commands.registerCommand('pa-code.connectTM1', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;

        const environmentName = item.environmentName;
        const instanceName = item.instanceName; // format: ENV_SERVERNAME
        const serverRealName = instanceName.substring(environmentName.length + 1);

        if (!vscode.workspace.workspaceFolders) return;
        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.name === environmentName);

        if (!envConfig) return;

        // --- OAuth (PAW) flow: handled before the classic REST-URL path ---
        if (envConfig.authMethod === 'OAuth') {
            await connectViaOAuth(context, envConfig, instanceName, serverRealName, environmentName, processProvider, askPullAllAfterConnect);
            return;
        }

        let baseUrl = '';
        let isCam = false;
        let isApiKey = false;
        let isIbmCloudNonInteractive = false;

        if (envConfig.connectionType === 'customUrl' || envConfig.connectionType === 'v12Tenant') {
            baseUrl = envConfig.restUrl || '';
        } else {
            const targetPort = item.serverPort || envConfig.port;
            const targetSsl = item.serverSsl !== undefined ? item.serverSsl : (envConfig.ssl !== undefined ? envConfig.ssl : true);
            const protocol = targetSsl ? 'https' : 'http';
            const adminHost = envConfig.adminHost || '';
            const cleanHost = adminHost.replace('https://', '').replace('http://', '');
            
            if (!targetPort) {
                vscode.window.showErrorMessage(`Connection failed: Port is missing for ${serverRealName}.`);
                return;
            }
            baseUrl = `${protocol}://${cleanHost}:${targetPort}`;
        }

        if (!baseUrl) {
            vscode.window.showErrorMessage('Connection failed: Base URL is missing.');
            return;
        }

        const authMethod = envConfig.authMethod || 'Prompt';

        // Helper to open browser login
        const openBrowserLogin = (url: string) => {
            CAMLoginPanel.createOrShow(context.extensionUri, url, async (cookie) => {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: `Connecting to ${serverRealName}...`,
                    cancellable: false
                }, async (progress) => {
                    try {
                        await TM1Service.getInstance().setConnectionWithCookie(instanceName, baseUrl, cookie, envConfig.timeout);
                        vscode.window.showInformationMessage(`Successfully connected to ${serverRealName}`);
                        processProvider.refresh();
                        // InstanceHubPanel.render(instanceName, environmentName, serverRealName);
                        askPullAllAfterConnect(instanceName, environmentName, serverRealName);
                    } catch (e: any) {
                        vscode.window.showErrorMessage(e.message);
                    }
                });
            });
        };

        const camInfo = (authMethod === 'Integrated Login') ? { isCam: false } : await TM1Service.getInstance().getCamInfo(baseUrl);
        isCam = camInfo.isCam;

        if (authMethod === 'CAM Browser SSO') {
            let finalCamUrl = envConfig.camUrl || camInfo.camUrl || baseUrl;
            if (envConfig.namespace && !finalCamUrl.includes('CAMNamespace=')) {
                const separator = finalCamUrl.includes('?') ? '&' : '?';
                finalCamUrl += `${separator}CAMNamespace=${encodeURIComponent(envConfig.namespace)}`;
            }
            openBrowserLogin(finalCamUrl);
            return;
        }

        if (authMethod === 'IBM Cloud') {
            isCam = true;
            isIbmCloudNonInteractive = true;
        } else if (authMethod === 'API Key') {
            isApiKey = true;
        } else if (authMethod === 'Basic') {
            // Already checked isCam
        } else if (authMethod === 'Integrated Login') {
            // TM1 IntegratedSecurityMode 2/3: authenticate with Windows/AD
            // credentials via the NTLM (Negotiate) handshake — no CAM namespace,
            // no browser SSO. Handled in the connect step below.
            isCam = false;
        } else {
            // Prompt / Auto-Detect
            if (isCam) {
                // Default behavior for CAM now: Open browser window
                let finalCamUrl = envConfig.camUrl || camInfo.camUrl || baseUrl;
                if (envConfig.namespace && !finalCamUrl.includes('CAMNamespace=')) {
                    const separator = finalCamUrl.includes('?') ? '&' : '?';
                    finalCamUrl += `${separator}CAMNamespace=${encodeURIComponent(envConfig.namespace)}`;
                }
                openBrowserLogin(finalCamUrl);
                return;
            }
        }

        let namespace = '';
        if (isCam) {
            if (isIbmCloudNonInteractive) {
                namespace = 'LDAP';
            } else {
                const nsInput = await vscode.window.showInputBox({ prompt: `CAM Namespace required for ${serverRealName} (e.g. LDAP)`, ignoreFocusOut: true });
                if (!nsInput) return; // User cancelled
                namespace = nsInput;
            }
        }

        let user = '';
        let password = '';

        if (isApiKey) {
            user = 'apikey';
            const keyInput = await vscode.window.showInputBox({ prompt: `Enter API Key for ${serverRealName}`, password: true, ignoreFocusOut: true });
            if (!keyInput) return;
            password = keyInput;
        } else if (authMethod !== 'Integrated Login') {
            // Integrated Login uses Windows SSO (Kerberos) — no prompt here.
            // Credentials are only requested later, and only if it must fall back
            // to NTLM (see the credential provider passed to the connect step).
            const userInput = await vscode.window.showInputBox({ 
                prompt: `User for ${serverRealName}`, 
                placeHolder: isIbmCloudNonInteractive ? "e.g. non_interactive_user" : "admin", 
                ignoreFocusOut: true 
            });
            if (!userInput) return;
            user = userInput;

            const passInput = await vscode.window.showInputBox({ prompt: `Password for ${serverRealName}`, password: true, ignoreFocusOut: true });
            if (passInput === undefined) return;
            password = passInput;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Connecting to ${serverRealName}...`,
            cancellable: false
        }, async (progress) => {
            try {
                if (authMethod === 'Integrated Login') {
                    // TM1 IntegratedSecurityMode 2/3 — Kerberos SSO from the current
                    // Windows session (no prompt). Credentials are requested lazily
                    // only if it must fall back to NTLM.
                    await TM1Service.getInstance().setConnectionWithIntegrated(
                        instanceName,
                        baseUrl,
                        envConfig.timeout,
                        async () => {
                            const u = await vscode.window.showInputBox({
                                prompt: `Kerberos single sign-on didn't succeed for ${serverRealName}. Enter Windows/AD credentials to try NTLM instead, or press Escape to cancel.`,
                                placeHolder: "DOMAIN\\user (e.g. CONTOSO\\jdoe) or user@domain",
                                ignoreFocusOut: true
                            });
                            if (!u) return undefined;
                            const p = await vscode.window.showInputBox({
                                prompt: `Password for ${u}`,
                                password: true,
                                ignoreFocusOut: true
                            });
                            if (p === undefined) return undefined;
                            return { user: u, pass: p };
                        }
                    );
                } else {
                    await TM1Service.getInstance().setConnection(
                        instanceName,
                        baseUrl,
                        user,
                        password,
                        namespace,
                        envConfig.timeout
                    );
                }
                vscode.window.showInformationMessage(`Connected to ${serverRealName}`);
                processProvider.refresh();
                // InstanceHubPanel.render(instanceName, environmentName, serverRealName);
                askPullAllAfterConnect(instanceName, environmentName, serverRealName);
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        });
    });

    // --- COMMAND: DISCONNECT (NEU) ---
    let disconnectCmd = vscode.commands.registerCommand('pa-code.disconnectTM1', (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;

        TM1Service.getInstance().disconnect(item.instanceName);
        // Close every webview tab bound to this instance so the user isn't left
        // with panels that only error with "not connected".
        try {
            CubeViewerPanel.disposeForInstance(item.instanceName);
            SubsetEditorPanel.disposeForInstance(item.instanceName);
            MDXWizardPanel.disposeForInstance(item.instanceName);
            BulkDeletePanel.disposeForInstance(item.instanceName);
            LogViewerPanel.disposeForInstance(item.instanceName);
            TIConsolePanel.disposeForInstance(item.instanceName);
            updateImpersonationStatus();
        } catch { /* best effort */ }
        processProvider.refresh(); // Update UI (Grün -> Grau)
        vscode.window.showInformationMessage(`Disconnected from ${item.instanceName}`);
    });



    // --- COMMAND: REFRESH ---
    let refreshCmd = vscode.commands.registerCommand('pa-code.refreshProcesses', () => {
        processProvider.refresh();
    });

    // --- COMMAND: CREATE PROCESS ---
    let createProcessCmd = vscode.commands.registerCommand('pa-code.createProcess', async (item?: TM1TreeItem) => {
        if (!item || item.contextValue !== 'folder_processes') return;

        const processName = await vscode.window.showInputBox({
            prompt: `New Process Name for ${item.instanceName.substring(item.environmentName.length + 1)}`,
            placeHolder: "e.g. Sys.UpdateData",
            ignoreFocusOut: true
        });

        if (!processName || processName.trim() === "") return;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Creating process '${processName}'...`,
            cancellable: false
        }, async (progress) => {
            try {
                if (!vscode.workspace.workspaceFolders) throw new Error("No workspace open.");

                // 1. Create on TM1 Server
                await TM1Service.getInstance().createProcess(item.instanceName, processName);

                // 2. Refresh Tree
                processProvider.refresh();

                // 3. Create locally and open
                const defaultContent = `#SECTION Prolog\n\n#SECTION Metadata\n\n#SECTION Data\n\n#SECTION Epilog\n\n#JSON_PROPERTIES\n{\n  "Parameters": [],\n  "DataSource": {\n    "Type": "None"\n  },\n  "Variables": [],\n  "HasSecurityAccess": false\n}`;
                const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                const config = ConfigManager.getConfig();
                const envConfig = config.environments.find((e: any) => e.name === item.environmentName);
                if (!envConfig) return;

                const serverRealName = item.instanceName.substring(item.environmentName.length + 1);
                const targetDir = path.join(rootPath, envConfig.folder, serverRealName, 'Processes');
                if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                const filePath = path.join(targetDir, `${processName}.ti`);
                fs.writeFileSync(filePath, defaultContent, 'utf8');

                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
                vscode.window.showInformationMessage(`Process '${processName}' successfully created!`);

            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        });
    });

    // --- In-memory editing for browse-only connections (no local files) ---
    // Processes/rules from an environment with local storage disabled are opened
    // under the `tm1mem` scheme: the tab shows the object name, edits are allowed,
    // and Save (Ctrl+S) pushes straight to TM1 without ever writing a disk file.
    const memContent = new Map<string, Uint8Array>();
    const memMeta = new Map<string, { instanceId: string; kind: 'process' | 'rule'; name: string }>();
    const memMtime = new Map<string, number>();
    const memEmitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    const memFs: vscode.FileSystemProvider = {
        onDidChangeFile: memEmitter.event,
        watch: () => new vscode.Disposable(() => { }),
        stat: (uri) => {
            const key = uri.toString();
            const d = memContent.get(key);
            if (!d) { throw vscode.FileSystemError.FileNotFound(uri); }
            return { type: vscode.FileType.File, ctime: 0, mtime: memMtime.get(key) || 0, size: d.length };
        },
        readDirectory: () => [],
        createDirectory: () => { },
        readFile: (uri) => {
            const d = memContent.get(uri.toString());
            if (!d) { throw vscode.FileSystemError.FileNotFound(uri); }
            return d;
        },
        writeFile: async (uri, content) => {
            const key = uri.toString();
            memContent.set(key, content);
            memMtime.set(key, Date.now());
            const meta = memMeta.get(key);
            if (!meta) { return; }
            if (!TM1Service.getInstance().isConnected(meta.instanceId)) {
                vscode.window.showErrorMessage(`Not connected to ${meta.instanceId}. Reconnect to save to the server.`);
                return;
            }
            const text = Buffer.from(content).toString('utf8');
            try {
                if (meta.kind === 'process') {
                    await TM1Service.getInstance().updateProcessCode(meta.instanceId, meta.name, ProcessParser.parseFileContent(text));
                } else {
                    await TM1Service.getInstance().updateRule(meta.instanceId, meta.name, text);
                }
                vscode.window.showInformationMessage(`'${meta.name}' saved to server (no local file).`);
            } catch (e: any) {
                // Don't throw: a thrown FileSystemError makes VS Code add its own
                // "Failed to save" toast on top of ours. Show only the server/syntax
                // error, matching the on-disk save UX.
                vscode.window.showErrorMessage(e.message);
            }
        },
        delete: () => { },
        rename: () => { },
    };
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('tm1mem', memFs, { isCaseSensitive: true }));

    const openInMemoryEditor = async (instanceId: string, kind: 'process' | 'rule', name: string, text: string) => {
        const safeName = name.replace(/[\\/]/g, '_');
        const folder = kind === 'process' ? 'Processes' : 'Rules';
        const ext = kind === 'process' ? 'ti' : 'rux';
        const uri = vscode.Uri.from({ scheme: 'tm1mem', path: '/' + instanceId + '/' + folder + '/' + safeName + '.' + ext });
        const key = uri.toString();
        memContent.set(key, Buffer.from(text, 'utf8'));
        memMtime.set(key, Date.now());
        memMeta.set(key, { instanceId, kind, name });
        memEmitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, 'tm1');
        await vscode.window.showTextDocument(doc, { preview: false });
    };

    // --- COMMAND: OPEN PROCESS ---
    let openProcessCmd = vscode.commands.registerCommand('pa-code.openProcess', async (environmentName: string, instanceName: string, processName: string) => {
        try {
            if (!vscode.workspace.workspaceFolders) return;
            const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const config = ConfigManager.getConfig();
            const envConfig = config.environments.find((e: any) => e.name === environmentName);
            if (!envConfig) throw new Error(`Configuration for environment ${environmentName} not found.`);

            const serverRealName = instanceName.substring(environmentName.length + 1);
            const targetDir = path.join(rootPath, envConfig.folder, serverRealName, 'Processes');
            const filePath = path.join(targetDir, `${processName}.ti`);

            // Browse-only mode: don't touch the disk — open the server content in an
            // in-memory editor (tab shows the name, Save pushes to the server).
            if (envConfig.storeFilesLocally === false) {
                const content = await TM1Service.getInstance().getProcessCode(instanceName, processName);
                await openInMemoryEditor(instanceName, 'process', processName, buildProcessFileContent(content));
                return;
            }

            const openLocal = async () => {
                const d = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(d, { preview: false });
                recentItemsProvider.addItem(processName, filePath, instanceName, 'process');
            };

            // Protect local edits: never overwrite a locally-changed or offline file
            // without asking, so opening from the tree cannot silently discard work.
            const offline = processBaseline.isOffline('process', instanceName, processName);
            const localExists = fs.existsSync(filePath);
            if (localExists && offline) {
                await openLocal();
                return;
            }

            const content = await TM1Service.getInstance().getProcessCode(instanceName, processName);
            const fileContent = buildProcessFileContent(content);

            // "Local changes" only when the file is genuinely different from the server.
            // Compare like-for-like: run the server content through the SAME
            // build→parse path as the local file, so a process whose code contains a
            // literal "#SECTION"/"#JSON_PROPERTIES" (which the parser splits on) isn't
            // falsely flagged forever — and Overwrite Local actually converges.
            const serverCanon = ProcessBaseline.canonicalProcessHash(ProcessParser.parseFileContent(fileContent));
            const localModified = localExists && ProcessBaseline.canonicalProcessHash(ProcessParser.parseFileContent(fs.readFileSync(filePath, 'utf8'))) !== serverCanon;

            if (localModified) {
                const choice = await vscode.window.showWarningMessage(
                    `"${processName}" has local changes that are not on the server yet.`,
                    { modal: true, detail: 'Opening from the server would overwrite your local changes. Choose "Show Diff" to compare first.' },
                    'Keep Local', 'Show Diff', 'Overwrite Local'
                );
                if (choice === 'Show Diff') {
                    const serverTmp = path.join(os.tmpdir(), `${processName}.server.ti`);
                    fs.writeFileSync(serverTmp, fileContent, 'utf8');
                    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(serverTmp), vscode.Uri.file(filePath), `${processName}: Server \u2194 Local`);
                    return;
                }
                if (choice !== 'Overwrite Local') {
                    await openLocal(); // Keep Local (or dismissed)
                    return;
                }
                // else fall through and overwrite with the server version.
            }

            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            // Only write when the file is genuinely different (canonical compare). This
            // avoids rewriting a file whose only diff is EOL or TM1's regenerated
            // Variables, which would show a phantom change in Source Control.
            const sameOnDisk = fs.existsSync(filePath) && ProcessBaseline.canonicalProcessHash(ProcessParser.parseFileContent(fs.readFileSync(filePath, 'utf8'))) === serverCanon;
            if (!sameOnDisk) fs.writeFileSync(filePath, fileContent, 'utf8');

            const doc = await vscode.workspace.openTextDocument(filePath);
            // Always open a permanent (non-preview) tab so several processes can stay open.
            await vscode.window.showTextDocument(doc, { preview: false });

            // Record the server + local baseline so we can detect two-way changes.
            processBaseline.set('process', instanceName, processName, { s: ProcessBaseline.hashProcess(content), l: ProcessBaseline.hashText(fileContent) });

            recentItemsProvider.addItem(processName, filePath, instanceName, 'process');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });

    // --- COMMAND: DELETE PROCESS ---
    let deleteProcessCmd = vscode.commands.registerCommand('pa-code.deleteProcess', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'process') return;
        const processName = item.label as string;
        const instanceName = item.instanceName;
        const environmentName = item.environmentName;
        const serverRealName = instanceName.substring(environmentName.length + 1);
        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Not connected to ${serverRealName}.`);
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            `Delete process "${processName}" from ${serverRealName}?`,
            { modal: true, detail: 'This permanently removes it from the TM1 server and cannot be undone.' },
            'Delete'
        );
        if (confirm !== 'Delete') return;
        try {
            await TM1Service.getInstance().deleteProcess(instanceName, processName);
            // Also remove the local .ti file if it exists.
            try {
                const config = ConfigManager.getConfig();
                const envConfig = config.environments.find((e: any) => e.name === environmentName);
                if (envConfig && vscode.workspace.workspaceFolders) {
                    const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
                    const filePath = path.join(rootPath, envConfig.folder, serverRealName, 'Processes', `${processName}.ti`);
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                }
            } catch { /* ignore local cleanup errors */ }
            processBaseline.clear('process', instanceName, processName);
            processBaseline.setOffline('process', instanceName, processName, false);
            vscode.window.showInformationMessage(`Process '${processName}' deleted from ${serverRealName}.`);
            processProvider.refresh();
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to delete '${processName}': ${e.message}`);
        }
    });

    // --- COMMAND: RENAME PROCESS ---
    // TM1 has no native rename, so this copies the process to the new name
    // (create + update) and deletes the old one, then renames the local file.
    let renameProcessCmd = vscode.commands.registerCommand('pa-code.renameProcess', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'process') return;
        const oldName = item.label as string;
        const instanceName = item.instanceName;
        const environmentName = item.environmentName;
        const serverRealName = instanceName.substring(environmentName.length + 1);
        const tm1 = TM1Service.getInstance();
        if (!tm1.isConnected(instanceName)) { vscode.window.showWarningMessage(`Not connected to ${serverRealName}.`); return; }

        let existing: string[] = [];
        try { existing = (await tm1.getProcesses(instanceName, 'all')).map(p => p.Name); } catch { /* best-effort */ }

        const newName = await vscode.window.showInputBox({
            title: `Rename process "${oldName}"`,
            prompt: 'New process name',
            value: oldName,
            ignoreFocusOut: true,
            validateInput: (v) => {
                const name = (v || '').trim();
                if (!name) return 'Name must not be empty.';
                if (name === oldName) return 'Enter a different name.';
                if (/["\r\n]/.test(name)) return 'Invalid characters in name.';
                if (existing.includes(name)) return `A process named "${name}" already exists.`;
                return undefined;
            }
        });
        if (!newName) return;
        const target = newName.trim();

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Renaming "${oldName}" \u2192 "${target}"…`, cancellable: false }, async () => {
            try {
                const content = await tm1.getProcessCode(instanceName, oldName);
                await tm1.createProcess(instanceName, target);
                try {
                    await tm1.updateProcessCode(instanceName, target, content);
                } catch (e: any) {
                    // A compile/syntax error means the code was still saved (copied as-is);
                    // any other failure is a real problem, so roll back the new process.
                    if (!e.syntaxErrors) { try { await tm1.deleteProcess(instanceName, target); } catch { /* ignore */ } throw e; }
                }
                await tm1.deleteProcess(instanceName, oldName);

                // Rename the local file if present (Processes or Control Processes).
                try {
                    const config = ConfigManager.getConfig();
                    const envConfig = config.environments.find((e: any) => e.name === environmentName);
                    if (envConfig && vscode.workspace.workspaceFolders) {
                        const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
                        for (const sub of ['Processes', 'Control Processes']) {
                            const oldFile = path.join(root, envConfig.folder, serverRealName, sub, `${oldName}.ti`);
                            if (fs.existsSync(oldFile)) {
                                fs.renameSync(oldFile, path.join(path.dirname(oldFile), `${target}.ti`));
                                break;
                            }
                        }
                    }
                } catch { /* ignore local rename errors */ }

                // Transfer baseline + offline flag from old to new.
                const wasOffline = processBaseline.isOffline('process', instanceName, oldName);
                processBaseline.clear('process', instanceName, oldName);
                processBaseline.setOffline('process', instanceName, oldName, false);
                try {
                    const saved = await tm1.getProcessCode(instanceName, target);
                    processBaseline.set('process', instanceName, target, { s: ProcessBaseline.hashProcess(saved), l: ProcessBaseline.hashText(buildProcessFileContent(saved)) });
                } catch { /* ignore */ }
                if (wasOffline) processBaseline.setOffline('process', instanceName, target, true);

                processProvider.refresh();
                vscode.window.showInformationMessage(
                    `Renamed "${oldName}" to "${target}". References in other processes/chores (ExecuteProcess/RunProcess) are not updated automatically.`,
                    'Search Local Files'
                ).then(choice => {
                    if (choice === 'Search Local Files') {
                        vscode.commands.executeCommand('workbench.action.findInFiles', { query: oldName, triggerSearch: true });
                    }
                });
            } catch (e: any) {
                vscode.window.showErrorMessage(`Rename failed: ${e.message}`);
            }
        });
    });

    // --- COMMAND: PUBLISH CHANGED FILES (manual push of all pending .ti/.rux) ---
    const publishProcessFile = async (instanceId: string, name: string, text: string): Promise<'published' | 'conflict'> => {
        const tm1 = TM1Service.getInstance();
        const base = processBaseline.get('process', instanceId, name);
        let exists = true;
        try {
            const serverContent = await tm1.getProcessCode(instanceId, name);
            if (base && ProcessBaseline.hashProcess(serverContent) !== base.s) return 'conflict';
        } catch { exists = false; }
        const codeObj = ProcessParser.parseFileContent(text);
        if (!exists) await tm1.createProcess(instanceId, name);
        await tm1.updateProcessCode(instanceId, name, codeObj);
        const saved = await tm1.getProcessCode(instanceId, name);
        processBaseline.set('process', instanceId, name, { s: ProcessBaseline.hashProcess(saved), l: ProcessBaseline.hashText(text) });
        return 'published';
    };
    const publishRuleFile = async (instanceId: string, name: string, text: string): Promise<'published' | 'conflict'> => {
        const tm1 = TM1Service.getInstance();
        const base = processBaseline.get('rule', instanceId, name);
        try {
            const serverRule = await tm1.getRuleContent(instanceId, name);
            if (base && ProcessBaseline.hashText(serverRule) !== base.s) return 'conflict';
        } catch { /* rule may not exist on server yet */ }
        await tm1.updateRule(instanceId, name, text);
        const savedRule = await tm1.getRuleContent(instanceId, name);
        processBaseline.set('rule', instanceId, name, { s: ProcessBaseline.hashText(savedRule), l: ProcessBaseline.hashText(text) });
        return 'published';
    };
    let publishChangedFilesCmd = vscode.commands.registerCommand('pa-code.publishChangedFiles', async () => {
        const files = await vscode.workspace.findFiles('**/*.{ti,rux}');
        const tm1 = TM1Service.getInstance();
        const pending: { kind: SyncKind; instanceId: string; name: string; text: string }[] = [];
        const notConnected = new Set<string>();
        for (const uri of files) {
            const target = resolveSyncTarget(uri.fsPath);
            if (!target) continue;
            let text = '';
            try { text = fs.readFileSync(uri.fsPath, 'utf8'); } catch { continue; }
            const base = processBaseline.get(target.kind, target.instanceId, target.name);
            if (!base) continue;                                       // never synced -> not tracked
            if (ProcessBaseline.hashText(text) === base.l) continue;    // unchanged since last sync
            if (!tm1.isConnected(target.instanceId)) { notConnected.add(target.instanceId); continue; }
            pending.push({ kind: target.kind, instanceId: target.instanceId, name: target.name, text });
        }
        if (pending.length === 0) {
            const extra = notConnected.size ? ` (changed files exist for not-connected instance(s): ${[...notConnected].join(', ')})` : '';
            vscode.window.showInformationMessage(`No changed TM1 files to publish${extra}.`);
            return;
        }
        const preview = pending.slice(0, 15).map(p => `\u2022 ${p.name}.${p.kind === 'process' ? 'ti' : 'rux'}`).join('\n') + (pending.length > 15 ? `\n\u2026 and ${pending.length - 15} more` : '');
        const confirm = await vscode.window.showInformationMessage(
            `Publish ${pending.length} changed file(s) to the server?`,
            { modal: true, detail: preview }, 'Publish'
        );
        if (confirm !== 'Publish') return;

        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Publishing changed files…', cancellable: false }, async (progress) => {
            let published = 0; const conflicts: string[] = []; const errors: string[] = [];
            for (const p of pending) {
                progress.report({ message: p.name });
                try {
                    const res = p.kind === 'process' ? await publishProcessFile(p.instanceId, p.name, p.text) : await publishRuleFile(p.instanceId, p.name, p.text);
                    if (res === 'published') published++; else conflicts.push(p.name);
                } catch (e: any) { errors.push(`${p.name}: ${e.message}`); }
            }
            processProvider.refresh();
            let msg = `Published ${published} file(s).`;
            if (conflicts.length) msg += ` ${conflicts.length} skipped \u2014 changed on server (open them to resolve): ${conflicts.slice(0, 8).join(', ')}${conflicts.length > 8 ? '\u2026' : ''}.`;
            if (errors.length) msg += ` ${errors.length} error(s).`;
            if (conflicts.length || errors.length) vscode.window.showWarningMessage(msg); else vscode.window.showInformationMessage(msg);
        });
    });

    // --- COMMAND: EXECUTE PROCESS CORE LOGIC ---
    const doExecuteProcess = async (environmentName: string, instanceName: string, serverRealName: string, processName: string, parameters: any[] = []) => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Executing '${processName}' on ${serverRealName}`,
            cancellable: true
        }, async (progress, token) => {
            const startTime = Date.now();
            const controller = new AbortController();

            // Save last used parameters for "Run with last parameters" feature
            if (parameters.length > 0) {
                recentItemsProvider.saveLastParams(processName, instanceName, parameters);
            }

            // Real-time elapsed timer
            const timer = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const totalSec = Math.floor(elapsed / 1000);
                const mins = Math.floor(totalSec / 60);
                const secs = totalSec % 60;
                const timeStr = mins > 0
                    ? `${mins}:${secs.toString().padStart(2, '0')}`
                    : `0:${secs.toString().padStart(2, '0')}`;
                progress.report({ message: `(${timeStr})` });
            }, 1000);

            // Handle cancellation
            let cancelled = false;
            token.onCancellationRequested(async () => {
                cancelled = true;
                controller.abort();
                try {
                    await TM1Service.getInstance().cancelProcessExecution(instanceName, processName);
                    vscode.window.showWarningMessage(`Process '${processName}' was cancelled.`);
                } catch (cancelErr: any) {
                    vscode.window.showErrorMessage(`Failed to cancel '${processName}': ${cancelErr.message}`);
                }
            });

            const formatElapsed = () => {
                const elapsed = Date.now() - startTime;
                const totalSec = Math.floor(elapsed / 1000);
                const mins = Math.floor(totalSec / 60);
                const secs = totalSec % 60;
                return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            };

            try {
                const response = await TM1Service.getInstance().executeProcess(instanceName, processName, parameters, controller.signal);
                clearInterval(timer);
                const timeStr = formatElapsed();

                const statusCode = response.ProcessExecuteStatusCode;
                let messageStr = "";
                let logFilePath = "";
                let logContent = "";

                if (response.ErrorLogFile && response.ErrorLogFile.Filename) {
                    logFilePath = response.ErrorLogFile.Filename;
                }

                if (response.ErrorMessages && response.ErrorMessages.length > 0) {
                    messageStr = "\nError messages:\n" + response.ErrorMessages.map((msg: any) => {
                        if (msg.MessageFile && msg.MessageFile.endsWith('.log')) {
                            logFilePath = msg.MessageFile;
                        }
                        return msg.Message || JSON.stringify(msg);
                    }).join('\n');

                    if (!logFilePath) {
                        const match = messageStr.match(/(TM1ProcessError_.*?\.log)/i);
                        if (match) logFilePath = match[1];
                    }
                }

                if (!logFilePath && statusCode !== "CompletedSuccessfully" && statusCode !== "Normal") {
                    try {
                        const fallbackLog = await TM1Service.getInstance().getLatestErrorLog(instanceName, processName);
                        if (fallbackLog) {
                            logFilePath = fallbackLog.filename;
                            logContent = fallbackLog.content;
                            messageStr += `\n(Found log: ${logFilePath})`;
                        }
                    } catch (e: any) {
                        messageStr += `\n(Fallback log search failed: ${e.message})`;
                    }
                }

                if (statusCode === "CompletedSuccessfully" || statusCode === "Normal") {
                    // When the opt-in celebration is on it becomes the SOLE success toast
                    // (animated), so it isn't masked by a second, plain notification.
                    if (vscode.workspace.getConfiguration('pa-code').get<boolean>('delight.celebrateProcessSuccess', false)) {
                        CelebrationPanel.celebrateProcessSuccess(processName, timeStr);
                        if (messageStr) { vscode.window.showInformationMessage(`Process '${processName}'${messageStr}`); }
                    } else {
                        const fun = vscode.workspace.getConfiguration('pa-code').get<boolean>('delight.funMessages', true);
                        const base = fun ? CelebrationPanel.successMessage(processName, timeStr) : `Process '${processName}' successfully executed. (${timeStr})`;
                        vscode.window.showInformationMessage(`${base}${messageStr}`);
                    }
                } else if (statusCode === "HasMinorErrors" || statusCode === "CompletedWithMessages") {
                    vscode.window.showWarningMessage(`Process '${processName}' completed with warnings (${timeStr}, Status: ${statusCode}).${messageStr}`);
                } else {
                    vscode.window.showErrorMessage(`Process '${processName}' failed (${timeStr}, Status: ${statusCode}).${messageStr}`);
                }

                if (logFilePath) {
                    try {
                        if (!logContent) {
                            logContent = await TM1Service.getInstance().getErrorLog(instanceName, logFilePath);
                        }
                        const doc = await vscode.workspace.openTextDocument({ content: logContent, language: 'log' });
                        await vscode.window.showTextDocument(doc, { preview: false });
                    } catch (err: any) {
                        vscode.window.showWarningMessage(`Could not open error log: ${err.message}`);
                    }
                }
            } catch (e: any) {
                clearInterval(timer);
                if (cancelled || e.message === "PROCESS_CANCELLED") {
                    return;
                }
                vscode.window.showErrorMessage(e.message);
            }
        });
    };

    const prepareExecuteProcess = async (environmentName: string, instanceName: string, serverRealName: string, processName: string) => {
        try {
            const parameters = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Fetching parameters for '${processName}'...`,
                cancellable: false
            }, async () => {
                return await TM1Service.getInstance().getProcessParameters(instanceName, processName);
            });

            if (parameters && parameters.length > 0) {
                const lastParams = recentItemsProvider.getLastParams(processName, instanceName);
                const defaultParams = parameters.map((p: any) => ({ Name: p.Name, Value: p.Value }));

                // Pre-fill with last used params if available
                if (lastParams) {
                    for (const param of parameters) {
                        const saved = lastParams.find((p: any) => p.Name === param.Name);
                        if (saved) {
                            param.Value = saved.Value;
                        }
                    }
                }

                ProcessExecutionPanel.render(
                    context.extensionUri, processName, parameters,
                    (params) => { doExecuteProcess(environmentName, instanceName, serverRealName, processName, params); },
                    lastParams ? defaultParams : undefined,
                    lastParams || undefined
                );
            } else {
                await doExecuteProcess(environmentName, instanceName, serverRealName, processName);
            }
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
        }
    };

    // --- COMMAND: EXECUTE PROCESS (FROM TREE VIEW) ---
    let executeProcessCmd = vscode.commands.registerCommand('pa-code.executeProcess', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'process') return;

        const environmentName = item.environmentName;
        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(environmentName.length + 1);
        const processName = item.label;

        await prepareExecuteProcess(environmentName, instanceName, serverRealName, processName);
    });

    // --- COMMAND: EXECUTE PROCESS (FROM CODELENS) ---
    let executeProcessByLensCmd = vscode.commands.registerCommand('pa-code.executeProcessByLens', async (envFolder?: string, serverRealName?: string, processName?: string) => {
        // When called from editor/title (no args), parse from active editor
        if (!envFolder || !serverRealName || !processName) {
            const editor = vscode.window.activeTextEditor;
            if (!editor || path.extname(editor.document.fileName) !== '.ti') return;
            const fsPath = editor.document.fileName;
            processName = path.basename(fsPath, '.ti');
            const parentDir = path.dirname(fsPath);
            if (path.basename(parentDir) !== 'Processes') return;
            serverRealName = path.basename(path.dirname(parentDir));
            envFolder = path.basename(path.dirname(path.dirname(parentDir)));
        }

        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.folder === envFolder);
        if (!envConfig) {
            vscode.window.showErrorMessage(`Configuration for environment folder '${envFolder}' not found.`);
            return;
        }

        const environmentName = envConfig.name;
        const instanceName = `${environmentName}_${serverRealName}`;

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} via PA Code Explorer first!`);
            return;
        }

        await prepareExecuteProcess(environmentName, instanceName, serverRealName, processName);
    });

    // --- COMMAND: PULL ALL ---
    let pullAllCmd = vscode.commands.registerCommand('pa-code.syncFromTM1', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;
        const environmentName = item.environmentName;
        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(environmentName.length + 1);
        const rootPath = vscode.workspace.workspaceFolders![0].uri.fsPath;
        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.name === environmentName);
        if (!envConfig) return;

        // Always pull everything, including control objects (no prompt).
        const typeArg = 'all';

        // Per-environment opt-out of writing files to disk (Test/Prod you only
        // want to browse/analyse without polluting a Dev-only repo).
        if (envConfig.storeFilesLocally === false) {
            vscode.window.showInformationMessage(
                `Local file storage is disabled for '${environmentName}'. You stay connected for browsing/analysis, but no process/rule files are written. Enable it in the connection settings to pull files.`);
            return;
        }

        // Files whose local copy differs from the last sync (or marked offline) are
        // NOT overwritten by Pull; they are collected here for an optional overwrite.
        const pullSkipped: { label: string; reason: string; write: () => void }[] = [];

        const personality = vscode.workspace.getConfiguration('pa-code').get<boolean>('delight.progressPersonality', true);
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: personality ? `☕ Rounding up ${serverRealName}…` : `Synchronizing ${serverRealName}...`,
            cancellable: false
        }, async (progress) => {
            try {
                // Ensure .gitattributes exists with correct line-ending rules
                const gitattributesPath = path.join(rootPath, '.gitattributes');
                const gitattributesLines = ['*.ti text eol=lf', '*.rux text eol=lf'];
                if (!fs.existsSync(gitattributesPath)) {
                    fs.writeFileSync(gitattributesPath, gitattributesLines.join('\n') + '\n', 'utf8');
                } else {
                    const existing = fs.readFileSync(gitattributesPath, 'utf8');
                    const missing = gitattributesLines.filter(line => !existing.includes(line));
                    if (missing.length > 0) {
                        const append = (existing.endsWith('\n') ? '' : '\n') + missing.join('\n') + '\n';
                        fs.appendFileSync(gitattributesPath, append, 'utf8');
                    }
                }

                // 1. Prozesse laden
                progress.report({ message: personality ? 'Fetching your processes… 🧰' : 'Loading processes...' });
                const allProcs = await TM1Service.getInstance().getAllProcessesDetails(instanceName, typeArg);
                const procDir = path.join(rootPath, envConfig.folder, serverRealName, 'Processes');
                const ctrlProcDir = path.join(rootPath, envConfig.folder, serverRealName, 'Control Processes');

                for (const proc of allProcs) {
                    const isControl = proc.Name.startsWith('}');
                    const targetDir = isControl ? ctrlProcDir : procDir;
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                    const filePath = path.join(targetDir, `${proc.Name}.ti`);
                    const fileContent = buildProcessFileContent(proc.Content);
                    const serverHash = ProcessBaseline.hashProcess(proc.Content);
                    const localHash = ProcessBaseline.hashText(fileContent);

                    // Protect local edits: skip if the file was changed locally since the
                    // last sync, or if it is explicitly marked offline.
                    const offline = processBaseline.isOffline('process', instanceName, proc.Name);
                    const exists = fs.existsSync(filePath);
                    // Compare like-for-like: run the server content through the SAME
                    // build→parse path as the local file, so processes whose code contains
                    // a literal "#SECTION"/"#JSON_PROPERTIES" aren't falsely flagged.
                    const serverCanon = ProcessBaseline.canonicalProcessHash(ProcessParser.parseFileContent(fileContent));
                    let localModified = false;
                    if (exists) {
                        const diskCanon = ProcessBaseline.canonicalProcessHash(ProcessParser.parseFileContent(fs.readFileSync(filePath, 'utf8')));
                        localModified = diskCanon !== serverCanon;
                    }
                    if (offline || localModified) {
                        pullSkipped.push({
                            label: `${proc.Name}.ti`, reason: offline ? 'offline' : 'local changes',
                            write: () => { fs.writeFileSync(filePath, fileContent, 'utf8'); processBaseline.set('process', instanceName, proc.Name, { s: serverHash, l: localHash }); }
                        });
                        continue;
                    }
                    // Only write NEW files. An existing, canonically-identical file is left
                    // untouched so Pull doesn't dirty Git with an invisible (EOL) diff.
                    if (!exists) fs.writeFileSync(filePath, fileContent, 'utf8');
                    processBaseline.set('process', instanceName, proc.Name, { s: serverHash, l: localHash });
                }

                // 2. Rules laden
                progress.report({ message: personality ? 'Rounding up the rules… 📜' : 'Loading rules...' });
                const allRules = await TM1Service.getInstance().getAllRulesDetails(instanceName, typeArg);
                const ruleDir = path.join(rootPath, envConfig.folder, serverRealName, 'Rules');
                const ctrlRuleDir = path.join(rootPath, envConfig.folder, serverRealName, 'Control Rules');

                for (const rule of allRules) {
                    const isControl = rule.CubeName.startsWith('}');
                    const targetDir = isControl ? ctrlRuleDir : ruleDir;
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

                    const filePath = path.join(targetDir, `${rule.CubeName}.rux`);
                    const serverHash = ProcessBaseline.hashText(rule.Content);
                    const ruleFileContent = toLf(rule.Content);

                    const offline = processBaseline.isOffline('rule', instanceName, rule.CubeName);
                    const exists = fs.existsSync(filePath);
                    let localModified = false;
                    if (exists) {
                        // Canonical compare: ignore EOL / trailing whitespace so Git pulls
                        // aren't flagged as local changes.
                        const diskCanon = ProcessBaseline.canonicalTextHash(fs.readFileSync(filePath, 'utf8'));
                        localModified = diskCanon !== ProcessBaseline.canonicalTextHash(rule.Content);
                    }
                    if (offline || localModified) {
                        pullSkipped.push({
                            label: `${rule.CubeName}.rux`, reason: offline ? 'offline' : 'local changes',
                            write: () => { fs.writeFileSync(filePath, ruleFileContent, 'utf8'); processBaseline.set('rule', instanceName, rule.CubeName, { s: serverHash, l: serverHash }); }
                        });
                        continue;
                    }
                    // Only write NEW files; leave an existing, identical file untouched.
                    if (!exists) fs.writeFileSync(filePath, ruleFileContent, 'utf8');
                    processBaseline.set('rule', instanceName, rule.CubeName, { s: serverHash, l: serverHash });
                }

                const totalObjects = allProcs.length + allRules.length;
                const written = totalObjects - pullSkipped.length;
                if (pullSkipped.length > 0) {
                    vscode.window.showInformationMessage(`${serverRealName}: ${written} object(s) loaded, ${pullSkipped.length} kept (local changes / offline).`);
                    vscode.window.showWarningMessage(
                        `${pullSkipped.length} file(s) were NOT overwritten by Pull to protect your local changes.`,
                        'Overwrite Local', 'Show List'
                    ).then(async choice => {
                        if (choice === 'Show List') {
                            const list = pullSkipped.map(s => `\u2022 ${s.label} (${s.reason})`).join('\n');
                            const c2 = await vscode.window.showWarningMessage(`These files were kept (not overwritten):\n\n${list}`, { modal: true }, 'Overwrite Local');
                            if (c2 === 'Overwrite Local') { pullSkipped.forEach(s => { try { s.write(); } catch { /* ignore */ } }); processProvider.refresh(); vscode.window.showInformationMessage(`${pullSkipped.length} file(s) overwritten from server.`); }
                        } else if (choice === 'Overwrite Local') {
                            pullSkipped.forEach(s => { try { s.write(); } catch { /* ignore */ } });
                            processProvider.refresh();
                            vscode.window.showInformationMessage(`${pullSkipped.length} file(s) overwritten from server.`);
                        }
                    });
                } else {
                    vscode.window.showInformationMessage(`${serverRealName}: ${allProcs.length} processes and ${allRules.length} rules loaded.`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(e.message);
            }
        });
    });

    // --- COMMAND: VIEW LOG ---
    let viewLogCmd = vscode.commands.registerCommand('pa-code.viewLog', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;
        const environmentName = item.environmentName;
        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(environmentName.length + 1);
        LogViewerPanel.render(instanceName, serverRealName);
    });

    const checkRuleSyntaxCmd = vscode.commands.registerCommand('pa-code.checkRuleSyntax', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { vscode.window.showWarningMessage('Open a cube rule (.rux) file first.'); return; }
        const uri = editor.document.uri;
        let instanceId = '', cubeName = '';
        if (uri.scheme === 'tm1mem') {
            const meta = memMeta.get(uri.toString());
            if (!meta || meta.kind !== 'rule') { vscode.window.showWarningMessage('The active editor is not a cube rule.'); return; }
            instanceId = meta.instanceId; cubeName = meta.name;
        } else {
            const target = resolveSyncTarget(uri.fsPath);
            if (!target || target.kind !== 'rule') { vscode.window.showWarningMessage('Open a cube rule (.rux) file from a pa-code project to check it.'); return; }
            instanceId = target.instanceId; cubeName = target.name;
        }
        if (!TM1Service.getInstance().isConnected(instanceId)) { vscode.window.showWarningMessage('Connect to the instance first.'); return; }
        const rules = editor.document.getText();
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking rule syntax for '${cubeName}'…`, cancellable: false }, async () => {
            try {
                const res = await TM1Service.getInstance().checkRuleSyntax(instanceId, cubeName, rules);
                if (res.ok) {
                    tm1DiagnosticCollection.delete(uri);
                    vscode.window.showInformationMessage(`✓ Rule syntax OK for '${cubeName}' — safe to save (checked on a throwaway cube, no re-feed).`);
                } else {
                    const diags: vscode.Diagnostic[] = [];
                    for (const line of res.message.split('\n')) {
                        const m = line.match(/Line\s+(\d+)\s*:\s*(.*)/i);
                        if (m) {
                            const ln = Math.max(0, parseInt(m[1], 10) - 1);
                            diags.push(new vscode.Diagnostic(new vscode.Range(ln, 0, ln, Number.MAX_SAFE_INTEGER), m[2], vscode.DiagnosticSeverity.Error));
                        }
                    }
                    if (diags.length) { tm1DiagnosticCollection.set(uri, diags); }
                    vscode.window.showErrorMessage(`Rule syntax errors in '${cubeName}':\n${res.message}`);
                }
            } catch (e: any) {
                vscode.window.showErrorMessage(`Rule check failed: ${e?.message || e}`);
            }
        });
    });

    let openRuleCmd = vscode.commands.registerCommand('pa-code.openRule', async (environmentName: string, instanceName: string, cubeName: string) => {
        try {
            if (!vscode.workspace.workspaceFolders) return;
            const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            const config = ConfigManager.getConfig();
            const envConfig = config.environments.find((e: any) => e.name === environmentName);
            if (!envConfig) throw new Error(`Configuration for environment ${environmentName} not found.`);

            const serverRealName = instanceName.substring(environmentName.length + 1);
            const targetDir = path.join(rootPath, envConfig.folder, serverRealName, 'Rules');
            const filePath = path.join(targetDir, `${cubeName}.rux`);

            // Browse-only mode: don't touch the disk — open the server rule in an
            // in-memory editor (tab shows the name, Save pushes to the server).
            if (envConfig.storeFilesLocally === false) {
                const content = await TM1Service.getInstance().getRuleContent(instanceName, cubeName);
                await openInMemoryEditor(instanceName, 'rule', cubeName, content);
                return;
            }

            const openLocal = async () => {
                const d = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(d, { preview: false });
            };

            const offline = processBaseline.isOffline('rule', instanceName, cubeName);
            const localExists = fs.existsSync(filePath);
            if (localExists && offline) {
                await openLocal();
                return;
            }

            const content = await TM1Service.getInstance().getRuleContent(instanceName, cubeName);
            // Only prompt when the file is genuinely different from the server (ignoring
            // line endings / trailing whitespace); a matching file has nothing to protect.
            const serverCanon = ProcessBaseline.canonicalTextHash(content);
            const localModified = localExists && ProcessBaseline.canonicalTextHash(fs.readFileSync(filePath, 'utf8')) !== serverCanon;

            if (localModified) {
                const choice = await vscode.window.showWarningMessage(
                    `"${cubeName}" rules have local changes that are not on the server yet.`,
                    { modal: true, detail: 'Opening from the server would overwrite your local changes. Choose "Show Diff" to compare first.' },
                    'Keep Local', 'Show Diff', 'Overwrite Local'
                );
                if (choice === 'Show Diff') {
                    const serverTmp = path.join(os.tmpdir(), `${cubeName}.server.rux`);
                    fs.writeFileSync(serverTmp, content, 'utf8');
                    await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(serverTmp), vscode.Uri.file(filePath), `${cubeName}: Server \u2194 Local rules`);
                    return;
                }
                if (choice !== 'Overwrite Local') {
                    await openLocal();
                    return;
                }
            }

            if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
            const ruleFileContent = toLf(content);
            // Skip the write when the file already matches (canonical compare) so a plain
            // "open" doesn't rewrite it and show a phantom change in Source Control.
            const sameOnDisk = fs.existsSync(filePath) && ProcessBaseline.canonicalTextHash(fs.readFileSync(filePath, 'utf8')) === serverCanon;
            if (!sameOnDisk) fs.writeFileSync(filePath, ruleFileContent, 'utf8');

            const doc = await vscode.workspace.openTextDocument(filePath);
            await vscode.window.showTextDocument(doc, { preview: false });
            // Record the rule baseline (local file text equals server content for rules).
            processBaseline.set('rule', instanceName, cubeName, { s: ProcessBaseline.hashText(content), l: ProcessBaseline.hashText(content) });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Error: ${error.message}`);
        }
    });

    // --- TM1 DIAGNOSTICS ---
    const tm1DiagnosticCollection = vscode.languages.createDiagnosticCollection('tm1');

    function findSectionLine(document: vscode.TextDocument, procedure: string): number {
        const marker = `#SECTION ${procedure}`.toUpperCase();
        for (let i = 0; i < document.lineCount; i++) {
            if (document.lineAt(i).text.trim().toUpperCase().startsWith(marker)) {
                return i;
            }
        }
        return -1;
    }

    /** Find the first non-blank code line after a section header, skipping leading empty lines. */
    function findCodeStartLine(document: vscode.TextDocument, sectionHeaderLine: number): number {
        for (let i = sectionHeaderLine + 1; i < document.lineCount; i++) {
            const text = document.lineAt(i).text.trim();
            if (text !== '') return i;
        }
        return sectionHeaderLine + 1;
    }

    function showRuleSyntaxError(document: vscode.TextDocument, ruleSyntaxError: { LineNumber: number; Message: string }) {
        // TM1 rule line numbers are 1-based, VS Code is 0-based
        const errorLine = ruleSyntaxError.LineNumber - 1;
        if (errorLine < 0 || errorLine >= document.lineCount) {
            tm1DiagnosticCollection.set(document.uri, [
                new vscode.Diagnostic(new vscode.Range(0, 0, 0, 0), ruleSyntaxError.Message, vscode.DiagnosticSeverity.Error)
            ]);
            return;
        }

        const lineText = document.lineAt(errorLine).text;
        const range = new vscode.Range(errorLine, 0, errorLine, lineText.length);
        const diag = new vscode.Diagnostic(range, ruleSyntaxError.Message, vscode.DiagnosticSeverity.Error);
        diag.source = 'TM1';
        tm1DiagnosticCollection.set(document.uri, [diag]);

        // Jump to error line and highlight
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.toString() === document.uri.toString()) {
            const targetPosition = new vscode.Position(errorLine, 0);
            editor.selection = new vscode.Selection(targetPosition, targetPosition);
            editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
            const highlightRange = new vscode.Range(errorLine, 0, errorLine, 0);
            editor.setDecorations(jumpHighlightDecoration, [highlightRange]);
            if (jumpHighlightTimeout) clearTimeout(jumpHighlightTimeout);
            jumpHighlightTimeout = setTimeout(() => {
                editor.setDecorations(jumpHighlightDecoration, []);
            }, 1500);
        }
    }

    function showSyntaxErrors(document: vscode.TextDocument, syntaxErrors: { LineNumber: number; Message: string; Procedure: string }[]) {
        const diagnostics: vscode.Diagnostic[] = [];
        let firstAbsoluteLine = -1;

        for (const err of syntaxErrors) {
            const sectionLine = findSectionLine(document, err.Procedure);
            if (sectionLine < 0) continue;
            const codeStart = findCodeStartLine(document, sectionLine);
            const absoluteLine = codeStart + err.LineNumber - 1; // TM1 LineNumber is 1-based
            if (absoluteLine >= document.lineCount) continue;

            if (firstAbsoluteLine < 0) firstAbsoluteLine = absoluteLine;

            const lineText = document.lineAt(absoluteLine).text;
            const range = new vscode.Range(absoluteLine, 0, absoluteLine, lineText.length);
            const diag = new vscode.Diagnostic(range, `[${err.Procedure}] ${err.Message}`, vscode.DiagnosticSeverity.Error);
            diag.source = 'TM1';
            diagnostics.push(diag);
        }

        tm1DiagnosticCollection.set(document.uri, diagnostics);

        // Jump to the first error line and highlight it
        if (firstAbsoluteLine >= 0) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.uri.toString() === document.uri.toString()) {
                const targetPosition = new vscode.Position(firstAbsoluteLine, 0);
                editor.selection = new vscode.Selection(targetPosition, targetPosition);
                editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
                const highlightRange = new vscode.Range(firstAbsoluteLine, 0, firstAbsoluteLine, 0);
                editor.setDecorations(jumpHighlightDecoration, [highlightRange]);
                if (jumpHighlightTimeout) clearTimeout(jumpHighlightTimeout);
                jumpHighlightTimeout = setTimeout(() => {
                    editor.setDecorations(jumpHighlightDecoration, []);
                }, 1500);
            }
        }
    }

    // --- SAVE LISTENER ---
    let saveListener = vscode.workspace.onDidSaveTextDocument(async (document) => {
        // In-memory (tm1mem) and other non-file docs push via their own provider.
        if (document.uri.scheme !== 'file') { return; }
        const ext = path.extname(document.fileName);
        if (ext === '.ti' || ext === '.rux') {
            // Manual-publish mode: don't push to the server on save.
            if (!vscode.workspace.getConfiguration('pa-code').get<boolean>('autoPushOnSave', true)) {
                vscode.window.setStatusBarMessage('$(cloud-offline) Saved locally — TM1 auto-push is off', 3000);
                return;
            }

            const parentDir = path.dirname(document.fileName);
            const subFolder = path.basename(parentDir); // "Processes" oder "Rules"
            const serverFolder = path.dirname(parentDir);
            const serverRealName = path.basename(serverFolder);
            const envFolderDir = path.dirname(serverFolder);
            const envFolder = path.basename(envFolderDir);

            const config = ConfigManager.getConfig();
            const envConfig = config.environments.find((e: any) => e.folder === envFolder);

            if (!envConfig) return;
            const instanceId = `${envConfig.name}_${serverRealName}`;

            if (TM1Service.getInstance().isConnected(instanceId)) {
                const fileName = path.basename(document.fileName, ext);
                const statusBarMsg = vscode.window.setStatusBarMessage(`Saving ${fileName} to ${serverRealName}...`);

                try {
                    if (ext === '.ti') {
                        // Conflict guard: did the process change on the server since we pulled/opened it?
                        const base = processBaseline.get('process', instanceId, fileName);
                        if (base) {
                            try {
                                const serverContent = await TM1Service.getInstance().getProcessCode(instanceId, fileName);
                                const serverHash = ProcessBaseline.hashProcess(serverContent);
                                if (serverHash !== base.s) {
                                    const choice = await vscode.window.showWarningMessage(
                                        `"${fileName}" was changed on ${serverRealName} after you opened it.`,
                                        { modal: true, detail: 'Saving overwrites those server-side changes. Choose "Show Diff" to compare first.' },
                                        'Show Diff', 'Overwrite Server'
                                    );
                                    if (choice === 'Show Diff') {
                                        const tmpPath = path.join(os.tmpdir(), `${fileName}.server.ti`);
                                        fs.writeFileSync(tmpPath, buildProcessFileContent(serverContent), 'utf8');
                                        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmpPath), document.uri, `${fileName}: Server \u2194 Local (not saved)`);
                                        vscode.window.showWarningMessage(`Save aborted for '${fileName}'. Review the diff, then save again and choose "Overwrite Server" to push.`);
                                        statusBarMsg.dispose();
                                        return;
                                    }
                                    if (choice !== 'Overwrite Server') {
                                        vscode.window.showInformationMessage(`Save cancelled — '${fileName}' was not pushed.`);
                                        statusBarMsg.dispose();
                                        return;
                                    }
                                    // 'Overwrite Server' -> fall through and push.
                                }
                            } catch { /* process may not exist on server yet — fall through to normal save */ }
                        }
                        const codeObj = ProcessParser.parseFileContent(document.getText());
                        await TM1Service.getInstance().updateProcessCode(instanceId, fileName, codeObj);
                        tm1DiagnosticCollection.delete(document.uri);
                        // Refresh the baseline to the just-saved server state.
                        try {
                            const saved = await TM1Service.getInstance().getProcessCode(instanceId, fileName);
                            processBaseline.set('process', instanceId, fileName, { s: ProcessBaseline.hashProcess(saved), l: ProcessBaseline.hashText(document.getText()) });
                        } catch { /* ignore */ }
                        vscode.window.showInformationMessage(`${serverRealName}: '${fileName}' saved!`);
                    } else {
                        // Rule (.rux) conflict guard: did the rules change on the server since we opened them?
                        const rbase = processBaseline.get('rule', instanceId, fileName);
                        if (rbase) {
                            try {
                                const serverRule = await TM1Service.getInstance().getRuleContent(instanceId, fileName);
                                if (ProcessBaseline.hashText(serverRule) !== rbase.s) {
                                    const choice = await vscode.window.showWarningMessage(
                                        `"${fileName}" rules were changed on ${serverRealName} after you opened them.`,
                                        { modal: true, detail: 'Saving overwrites those server-side changes. Choose "Show Diff" to compare first.' },
                                        'Show Diff', 'Overwrite Server'
                                    );
                                    if (choice === 'Show Diff') {
                                        const tmpPath = path.join(os.tmpdir(), `${fileName}.server.rux`);
                                        fs.writeFileSync(tmpPath, serverRule, 'utf8');
                                        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmpPath), document.uri, `${fileName}: Server ↔ Local rules (not saved)`);
                                        vscode.window.showWarningMessage(`Save aborted for '${fileName}'. Review the diff, then save again and choose "Overwrite Server" to push.`);
                                        return;
                                    }
                                    if (choice !== 'Overwrite Server') {
                                        vscode.window.showInformationMessage(`Save cancelled — '${fileName}' rules were not pushed.`);
                                        return;
                                    }
                                }
                            } catch { /* rule may not exist on server yet */ }
                        }
                        // Rule save with progress timer and cancel button
                        await vscode.window.withProgress({
                            location: vscode.ProgressLocation.Notification,
                            title: `Saving rule '${fileName}' to ${serverRealName}`,
                            cancellable: true
                        }, async (progress, token) => {
                            const startTime = Date.now();
                            const controller = new AbortController();

                            const timer = setInterval(() => {
                                const elapsed = Date.now() - startTime;
                                const totalSec = Math.floor(elapsed / 1000);
                                const mins = Math.floor(totalSec / 60);
                                const secs = totalSec % 60;
                                const timeStr = mins > 0
                                    ? `${mins}:${secs.toString().padStart(2, '0')}`
                                    : `0:${secs.toString().padStart(2, '0')}`;
                                progress.report({ message: `(${timeStr})` });
                            }, 1000);

                            let cancelled = false;
                            token.onCancellationRequested(() => {
                                cancelled = true;
                                controller.abort();
                            });

                            try {
                                await TM1Service.getInstance().updateRule(instanceId, fileName, document.getText(), controller.signal);
                                clearInterval(timer);
                                const elapsed = Date.now() - startTime;
                                const totalSec = Math.floor(elapsed / 1000);
                                const mins = Math.floor(totalSec / 60);
                                const secs = totalSec % 60;
                                const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                                tm1DiagnosticCollection.delete(document.uri);
                                // Refresh the rule baseline to the just-saved server state.
                                try {
                                    const savedRule = await TM1Service.getInstance().getRuleContent(instanceId, fileName);
                                    processBaseline.set('rule', instanceId, fileName, { s: ProcessBaseline.hashText(savedRule), l: ProcessBaseline.hashText(document.getText()) });
                                } catch { /* ignore */ }
                                vscode.window.showInformationMessage(`${serverRealName}: '${fileName}' saved! (${timeStr})`);
                            } catch (ruleErr: any) {
                                clearInterval(timer);
                                if (cancelled || ruleErr.message === 'RULE_SAVE_CANCELLED') {
                                    vscode.window.showWarningMessage(`Rule save for '${fileName}' was cancelled.`);
                                    return;
                                }
                                if (ruleErr.ruleSyntaxError) {
                                    vscode.window.showErrorMessage(ruleErr.message);
                                    showRuleSyntaxError(document, ruleErr.ruleSyntaxError);
                                } else {
                                    vscode.window.showErrorMessage(ruleErr.message);
                                }
                            }
                        });
                    }
                } catch (e: any) {
                    if (e.message === "PROCESS_NOT_FOUND" && ext === '.ti') {
                        const createChoice = await vscode.window.showInformationMessage(
                            `Process '${fileName}' does not exist on server ${serverRealName}. Do you want to create it?`,
                            "Yes", "No"
                        );
                        if (createChoice === "Yes") {
                            try {
                                await TM1Service.getInstance().createProcess(instanceId, fileName);
                                const codeObj = ProcessParser.parseFileContent(document.getText());
                                await TM1Service.getInstance().updateProcessCode(instanceId, fileName, codeObj);
                                // Establish a baseline for the freshly-created process.
                                try {
                                    const saved = await TM1Service.getInstance().getProcessCode(instanceId, fileName);
                                    processBaseline.set('process', instanceId, fileName, { s: ProcessBaseline.hashProcess(saved), l: ProcessBaseline.hashText(document.getText()) });
                                } catch { /* ignore */ }
                                vscode.window.showInformationMessage(`${serverRealName}: Process '${fileName}' created and saved!`);
                                processProvider.refresh();
                            } catch (createErr: any) {
                                vscode.window.showErrorMessage(createErr.message);
                            }
                        }
                    } else {
                        vscode.window.showErrorMessage(e.message);
                        if (e.syntaxErrors && ext === '.ti') {
                            showSyntaxErrors(document, e.syntaxErrors);
                        }
                    }
                } finally {
                    statusBarMsg.dispose();
                }
            }
        }
    });

    // --- SEARCH CMD ---
    let searchCmd = vscode.commands.registerCommand('pa-code.searchProcesses', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;
        const serverRealName = item.instanceName.substring(item.environmentName.length + 1);
        const instanceName = item.instanceName;

        // Live filtering (instant, no Enter to confirm) — consistent with folder search.
        const inputBox = vscode.window.createInputBox();
        inputBox.placeholder = `Search processes & cubes in ${serverRealName}…`;
        inputBox.title = `Search ${serverRealName}`;
        inputBox.value = processProvider.getInstanceFilter(instanceName);
        inputBox.onDidChangeValue(value => processProvider.setFilter(instanceName, value));
        inputBox.onDidAccept(() => inputBox.dispose());
        inputBox.onDidHide(() => inputBox.dispose());
        inputBox.show();
    });

    // --- CLEAR SEARCH CMD ---
    let clearSearchCmd = vscode.commands.registerCommand('pa-code.clearSearch', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;
        processProvider.setFilter(item.instanceName, '');
    });

    // --- FOLDER SEARCH CMD ---
    // Resolve which filter key + title a folder/subfolder search should use.
    // Top-level folders (Cubes/Dimensions/Processes/Chores) key by label; Control
    // Objects subfolders by base contextValue; Views/Subsets folders by a key
    // scoped to their cube (or dim+hierarchy) so each searches independently.
    const resolveFolderFilterTarget = (item: TM1TreeItem): { filterKey: string; titleLabel: string } | undefined => {
        const baseCtx = (item.contextValue || '').replace(/_filtered$/, '');
        if (item.type === 'folder') return { filterKey: item.label as string, titleLabel: item.label as string };
        if (item.type === 'subfolder' && baseCtx.startsWith('control_')) {
            return { filterKey: baseCtx, titleLabel: `Control ${item.label as string}` };
        }
        if (baseCtx === 'cube_views' && item.cubeName) {
            return { filterKey: ProcessProvider.viewsFilterKey(item.cubeName), titleLabel: `Views of ${item.cubeName}` };
        }
        if (baseCtx === 'hierarchy_subsets' && item.dimensionName && item.hierarchyName) {
            return { filterKey: ProcessProvider.subsetsFilterKey(item.dimensionName, item.hierarchyName), titleLabel: `Subsets of ${item.dimensionName}` };
        }
        return undefined;
    };

    let folderSearchCmd = vscode.commands.registerCommand('pa-code.folderSearch', async (item?: TM1TreeItem) => {
        if (!item) return;
        const resolved = resolveFolderFilterTarget(item);
        if (!resolved) return;
        const { filterKey, titleLabel } = resolved;
        const instanceName = item.instanceName;
        const currentFilter = processProvider.getFolderFilter(instanceName, filterKey);

        const inputBox = vscode.window.createInputBox();
        inputBox.placeholder = `Search in ${titleLabel}...`;
        inputBox.title = `Search ${titleLabel}`;
        inputBox.value = currentFilter;

        inputBox.onDidChangeValue(value => {
            processProvider.setFolderFilter(instanceName, filterKey, value);
        });

        inputBox.onDidAccept(() => {
            inputBox.dispose();
        });

        inputBox.onDidHide(() => {
            inputBox.dispose();
        });

        inputBox.show();
    });

    // --- CLEAR FOLDER SEARCH CMD ---
    let clearFolderSearchCmd = vscode.commands.registerCommand('pa-code.clearFolderSearch', async (item?: TM1TreeItem) => {
        if (!item) return;
        const resolved = resolveFolderFilterTarget(item);
        if (!resolved) return;
        processProvider.setFolderFilter(item.instanceName, resolved.filterKey, '');
    });

    // --- COMMAND: SETTINGS ---
    let settingsCmd = vscode.commands.registerCommand('pa-code.manageSettings', () => {
        SettingsPanel.render(context.extensionUri, context, () => processProvider.refresh());
    });

    // --- COMMAND: SHOW PROXY DIAGNOSTIC LOG ---
    let showProxyLogCmd = vscode.commands.registerCommand('pa-code.showProxyLog', () => {
        ProxyHelper.logConfigSummary();
        ProxyHelper.showLog();
    });

    // --- COMMAND: WHAT'S NEW ---
    let whatsNewCmd = vscode.commands.registerCommand('pa-code.whatsNew', () => {
        WhatsNewPanel.show(context.extension.packageJSON.version);
    });

    // --- COMMAND: CLEAR STORED OAUTH CREDENTIALS ---
    let clearOAuthCredentialsCmd = vscode.commands.registerCommand('pa-code.clearOAuthCredentials', async () => {
        const cfg = ConfigManager.getConfig();
        const oauthEnvs = (cfg.environments || []).filter((e: any) => e.authMethod === 'OAuth');
        if (oauthEnvs.length === 0) { vscode.window.showInformationMessage('No OAuth environments are configured.'); return; }
        const pick = await vscode.window.showQuickPick(oauthEnvs.map((e: any) => e.name), { placeHolder: 'Clear stored OAuth credentials (client secret + refresh token) for which environment?' });
        if (!pick) return;
        await context.secrets.delete(`pa-code.oauth.secret.${pick}`);
        await context.secrets.delete(`pa-code.oauth.refresh.${pick}`);
        oauthTokenCache.delete(pick);
        vscode.window.showInformationMessage(`Cleared stored OAuth credentials for ${pick}. You'll be asked to sign in again on next connect.`);
    });

    // --- COMMAND: PUSH TO TM1 (FROM EXPLORER) ---
    let pushToTM1Cmd = vscode.commands.registerCommand('pa-code.pushToTM1', async (uri: vscode.Uri) => {
        if (!uri) return;

        const filePath = uri.fsPath;
        const ext = path.extname(filePath);
        if (ext !== '.ti') return;

        const fileName = path.basename(filePath, ext);
        const parentDir = path.dirname(filePath);
        const serverFolder = path.dirname(parentDir);
        const serverRealName = path.basename(serverFolder);
        const envFolderDir = path.dirname(serverFolder);
        const envFolder = path.basename(envFolderDir);

        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.folder === envFolder);

        if (!envConfig) {
            vscode.window.showErrorMessage(`Environment config not found for folder '${envFolder}'`);
            return;
        }

        const instanceId = `${envConfig.name}_${serverRealName}`;

        if (!TM1Service.getInstance().isConnected(instanceId)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} via PA Code Explorer first!`);
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Pushing '${fileName}' to ${serverRealName}...`,
            cancellable: false
        }, async () => {
            try {
                const document = await vscode.workspace.openTextDocument(filePath);
                const codeObj = ProcessParser.parseFileContent(document.getText());
                
                try {
                    await TM1Service.getInstance().updateProcessCode(instanceId, fileName, codeObj);
                    vscode.window.showInformationMessage(`${serverRealName}: '${fileName}' successfully updated!`);
                } catch (e: any) {
                    if (e.message === "PROCESS_NOT_FOUND") {
                        await TM1Service.getInstance().createProcess(instanceId, fileName);
                        await TM1Service.getInstance().updateProcessCode(instanceId, fileName, codeObj);
                        vscode.window.showInformationMessage(`${serverRealName}: '${fileName}' successfully created!`);
                        processProvider.refresh();
                    } else {
                        throw e;
                    }
                }
            } catch (err: any) {
                vscode.window.showErrorMessage(err.message);
            }
        });
    });

    // --- TM1 LINE TRACKER: Status Bar ---
    // Helper: given a document and a 0-based line index, returns
    // the active section name and TM1-relative line number.
    function getTM1LineInfo(document: vscode.TextDocument, cursorLine: number): { section: string; tm1Line: number } | null {
        if (!document.fileName.endsWith('.ti')) return null;

        let activeSection = '';
        let sectionStartLine = -1;

        for (let i = cursorLine; i >= 0; i--) {
            const lineText = document.lineAt(i).text.trim();
            // Match both #SECTION <name> and #JSON_PROPERTIES
            const sectionMatch = lineText.match(/^#SECTION\s+(\w+)/i);
            const jsonMatch = lineText.match(/^#JSON_PROPERTIES/i);
            if (sectionMatch) {
                activeSection = sectionMatch[1];
                sectionStartLine = i;
                break;
            } else if (jsonMatch) {
                activeSection = 'JSON Properties';
                sectionStartLine = i;
                break;
            }
        }

        if (!activeSection || sectionStartLine < 0) return null;

        // For JSON Properties we just show the position, no meaningful TM1 line
        if (activeSection === 'JSON Properties') {
            return { section: 'JSON Properties', tm1Line: cursorLine - sectionStartLine };
        }

        // Skip leading blank lines to find actual code start
        const codeStart = findCodeStartLine(document, sectionStartLine);
        const tm1Line = cursorLine < codeStart ? 0 : cursorLine - codeStart + 1;
        return { section: activeSection, tm1Line };
    }

    // Create the status bar item
    const tm1LineStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    tm1LineStatusBar.command = 'pa-code.gotoTM1Line';
    tm1LineStatusBar.tooltip = 'Click to jump to a TM1 line';

    // Decoration type for the jump highlight
    const jumpHighlightDecoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: new vscode.ThemeColor('editor.findMatchBorder'),
    });
    let jumpHighlightTimeout: ReturnType<typeof setTimeout> | undefined;

    function updateTM1StatusBar(editor: vscode.TextEditor | undefined) {
        if (!editor || !editor.document.fileName.endsWith('.ti')) {
            tm1LineStatusBar.hide();
            return;
        }
        const info = getTM1LineInfo(editor.document, editor.selection.active.line);
        if (info) {
            if (info.section === 'JSON Properties') {
                tm1LineStatusBar.text = `$(symbol-numeric) TM1: JSON Properties`;
            } else {
                tm1LineStatusBar.text = `$(symbol-numeric) TM1: ${info.section} · Line ${info.tm1Line}`;
            }
            tm1LineStatusBar.show();
        } else {
            tm1LineStatusBar.text = `$(symbol-numeric) TM1: (no section)`;
            tm1LineStatusBar.show();
        }
    }

    // Update on cursor move and editor switch
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(e => updateTM1StatusBar(e.textEditor)),
        vscode.window.onDidChangeActiveTextEditor(e => updateTM1StatusBar(e))
    );
    // Initialise for whatever is already open
    updateTM1StatusBar(vscode.window.activeTextEditor);

    // --- COMMAND: GO TO TM1 LINE ---
    let gotoTM1LineCmd = vscode.commands.registerCommand('pa-code.gotoTM1Line', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.ti')) {
            vscode.window.showWarningMessage('Please open a .ti file first.');
            return;
        }

        const doc = editor.document;

        // Find all sections and their line numbers (including #JSON_PROPERTIES as a boundary)
        const sections: { name: string; startLine: number; nextSectionLine: number }[] = [];
        for (let i = 0; i < doc.lineCount; i++) {
            const lineText = doc.lineAt(i).text.trim();
            const sectionMatch = lineText.match(/^#SECTION\s+(\w+)/i);
            const jsonMatch = lineText.match(/^#JSON_PROPERTIES/i);
            if (sectionMatch) {
                sections.push({ name: sectionMatch[1], startLine: i, nextSectionLine: doc.lineCount });
            } else if (jsonMatch) {
                // Use JSON_PROPERTIES as a boundary to cap the last real section, but don't add it as a navigable section
                if (sections.length > 0) {
                    sections[sections.length - 1].nextSectionLine = i;
                }
            }
        }
        // Fill in the nextSectionLine
        for (let i = 0; i < sections.length - 1; i++) {
            sections[i].nextSectionLine = sections[i + 1].startLine;
        }

        if (sections.length === 0) {
            vscode.window.showWarningMessage('No #SECTION markers found in this file.');
            return;
        }

        // Let user pick section
        const sectionPick = await vscode.window.showQuickPick(
            sections.map(s => s.name),
            { placeHolder: 'Select TM1 procedure section' }
        );
        if (!sectionPick) return;

        const section = sections.find(s => s.name === sectionPick)!;
        const codeStart = findCodeStartLine(doc, section.startLine);
        const maxLine = section.nextSectionLine - codeStart;

        // Let user enter the TM1 line number
        const lineInput = await vscode.window.showInputBox({
            prompt: `Go to line in ${sectionPick} (1–${maxLine})`,
            placeHolder: 'e.g. 21',
            validateInput: val => {
                const n = parseInt(val, 10);
                if (isNaN(n) || n < 1 || n > maxLine) return `Enter a number between 1 and ${maxLine}`;
                return null;
            }
        });
        if (!lineInput) return;

        // Calculate the absolute line in the file (0-based)
        const tm1Line = parseInt(lineInput, 10);
        const absoluteLine = codeStart + tm1Line - 1; // TM1 line 1 = first code line after skipping blank lines

        const targetPosition = new vscode.Position(absoluteLine, 0);
        editor.selection = new vscode.Selection(targetPosition, targetPosition);
        editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);

        // Highlight the line briefly
        const highlightRange = new vscode.Range(absoluteLine, 0, absoluteLine, 0);
        editor.setDecorations(jumpHighlightDecoration, [highlightRange]);
        if (jumpHighlightTimeout) clearTimeout(jumpHighlightTimeout);
        jumpHighlightTimeout = setTimeout(() => {
            editor.setDecorations(jumpHighlightDecoration, []);
        }, 1500);
    });

    // --- COMMAND: JUMP TO LINE (used by hover provider) ---
    let jumpToLineCmd = vscode.commands.registerCommand('pa-code.jumpToLine', (lineNumber: number) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const line = Math.max(0, lineNumber);
        const targetPosition = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(targetPosition, targetPosition);
        editor.revealRange(new vscode.Range(targetPosition, targetPosition), vscode.TextEditorRevealType.InCenter);
        const highlightRange = new vscode.Range(line, 0, line, 0);
        editor.setDecorations(jumpHighlightDecoration, [highlightRange]);
        if (jumpHighlightTimeout) clearTimeout(jumpHighlightTimeout);
        jumpHighlightTimeout = setTimeout(() => {
            editor.setDecorations(jumpHighlightDecoration, []);
        }, 1500);
    });

    // --- Register Formatter & IntelliSense ---
    const tm1LangSelector = { language: 'tm1' };
    const formatterDisposable = vscode.languages.registerDocumentFormattingEditProvider(tm1LangSelector, new TM1Formatter());
    const completionDisposable = vscode.languages.registerCompletionItemProvider(
        tm1LangSelector,
        new TM1CompletionProvider(),
        "'"  // trigger on single-quote
    );
    // Function snippet completions (triggered when typing function names)
    const functionSnippetDisposable = vscode.languages.registerCompletionItemProvider(
        tm1LangSelector,
        new TM1FunctionSnippetProvider()
    );
    // Variable completions: the process' own variables/parameters (TI files)
    const variableCompletionDisposable = vscode.languages.registerCompletionItemProvider(
        tm1LangSelector,
        new TM1VariableCompletionProvider()
    );
    context.subscriptions.push(variableCompletionDisposable);
    // Signature help: shows the current function's parameters while typing arguments
    const signatureHelpDisposable = vscode.languages.registerSignatureHelpProvider(
        tm1LangSelector,
        new TM1SignatureHelpProvider(),
        '(', ','
    );
    context.subscriptions.push(signatureHelpDisposable);
    // Hover provider: shows variable values from last debug session
    const hoverDisposable = vscode.languages.registerHoverProvider(tm1LangSelector, new TM1HoverProvider());
    // Hover provider: shows TM1 function syntax/description (TI & Rules)
    const functionHoverDisposable = vscode.languages.registerHoverProvider(tm1LangSelector, new TM1FunctionHoverProvider());
    context.subscriptions.push(functionHoverDisposable);
    // Folding provider: folds #SECTION blocks and #Region/#EndRegion regions in .ti files
    const foldingDisposable = vscode.languages.registerFoldingRangeProvider(tm1LangSelector, new TM1FoldingProvider());
    context.subscriptions.push(foldingDisposable);
    // Clear IntelliSense cache on disconnect so next connect gets fresh data
    context.subscriptions.push(
        vscode.commands.registerCommand('pa-code._clearCompletionCache', () => {
            TM1Service.getInstance().clearIntelliSenseCache();
        })
    );

    // --- TI DEBUGGER REGISTRATION ---
    const debugAdapterFactory = new TM1DebugAdapterFactory();
    const debugConfigProvider = new TM1DebugConfigurationProvider();

    const debugFactoryDisposable = vscode.debug.registerDebugAdapterDescriptorFactory('tm1', debugAdapterFactory);
    const debugConfigDisposable = vscode.debug.registerDebugConfigurationProvider('tm1', debugConfigProvider);

    // --- COMMAND: DEBUG PROCESS (FROM CODELENS) ---
    let debugProcessByLensCmd = vscode.commands.registerCommand('pa-code.debugProcessByLens', async (envFolder?: string, serverRealName?: string, processName?: string) => {
        // When called from editor/title (no args), parse from active editor
        if (!envFolder || !serverRealName || !processName) {
            const editor = vscode.window.activeTextEditor;
            if (!editor || path.extname(editor.document.fileName) !== '.ti') return;
            const fsPath = editor.document.fileName;
            processName = path.basename(fsPath, '.ti');
            const parentDir = path.dirname(fsPath);
            if (path.basename(parentDir) !== 'Processes') return;
            serverRealName = path.basename(path.dirname(parentDir));
            envFolder = path.basename(path.dirname(path.dirname(parentDir)));
        }

        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.folder === envFolder);
        if (!envConfig) {
            vscode.window.showErrorMessage(`Configuration for environment folder '${envFolder}' not found.`);
            return;
        }

        const environmentName = envConfig.name;
        const instanceName = `${environmentName}_${serverRealName}`;

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} via PA Code Explorer first!`);
            return;
        }

        // Check if TI debugging is enabled on the server
        const debugEnabled = await TM1Service.getInstance().checkTIDebuggingEnabled(instanceName);
        if (!debugEnabled) {
            const choice = await vscode.window.showWarningMessage(
                `TI debugging is not enabled on ${serverRealName}. The parameter EnableTIDebugging must be set to true.\n\nWould you like to enable it now? (This is a dynamic parameter and takes effect immediately.)`,
                'Enable & Continue',
                'Open Configuration',
                'Cancel'
            );
            if (choice === 'Enable & Continue') {
                try {
                    await TM1Service.getInstance().updateConfigurationParameterByName(instanceName, 'EnableTIDebugging', true);
                    vscode.window.showInformationMessage(`${serverRealName}: EnableTIDebugging has been enabled.`);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to enable TI debugging: ${err.message}`);
                    return;
                }
            } else if (choice === 'Open Configuration') {
                await ConfigurationPanel.render(instanceName, serverRealName);
                return;
            } else {
                return;
            }
        }

        // Determine the file path of the process
        if (!vscode.workspace.workspaceFolders) return;
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const programPath = path.join(rootPath, envConfig.folder, serverRealName, 'Processes', `${processName}.ti`);

        if (!fs.existsSync(programPath)) {
            vscode.window.showErrorMessage(`Process file not found: ${programPath}`);
            return;
        }

        // Check if process has parameters, and if so collect them
        let parameters: any[] = [];
        try {
            const params = await TM1Service.getInstance().getProcessParameters(instanceName, processName);
            if (params && params.length > 0) {
                // Use the ProcessExecutionPanel to collect parameter values
                ProcessExecutionPanel.render(context.extensionUri, processName, params, async (collectedParams) => {
                    // Start debug with collected parameters
                    await vscode.debug.startDebugging(vscode.workspace.workspaceFolders![0], {
                        type: 'tm1',
                        request: 'launch',
                        name: `Debug: ${processName}`,
                        program: programPath,
                        stopOnEntry: true,
                        parameters: collectedParams
                    });
                });
                return;
            }
        } catch (e: any) {
            // If we can't fetch params, proceed without them
            vscode.window.showWarningMessage(`Could not fetch parameters: ${e.message}. Starting debug without parameters.`);
        }

        // No parameters — start debug directly
        await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
            type: 'tm1',
            request: 'launch',
            name: `Debug: ${processName}`,
            program: programPath,
            stopOnEntry: true,
            parameters: parameters
        });
    });

    // --- COMMAND: MANAGE TM1 CONFIGURATION ---
    let manageConfigCmd = vscode.commands.registerCommand('pa-code.manageConfiguration', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;

        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(item.environmentName.length + 1);

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} first!`);
            return;
        }

        await ConfigurationPanel.render(instanceName, serverRealName);
    });

    // --- COMMAND: VIEW TM1 THREADS ---
    let viewThreadsCmd = vscode.commands.registerCommand('pa-code.viewThreads', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;

        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(item.environmentName.length + 1);

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} first!`);
            return;
        }

        await ThreadViewerPanel.render(instanceName, serverRealName);
    });

    let viewTIConsoleCmd = vscode.commands.registerCommand('pa-code.tiConsole', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        const serverRealName = resolved.instanceName.substring(resolved.environmentName.length + 1);
        if (!TM1Service.getInstance().isConnected(resolved.instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} first!`);
            return;
        }
        TIConsolePanel.render(resolved.instanceName, serverRealName);
    });

    let fileManagerCmd = vscode.commands.registerCommand('pa-code.fileManager', async (item?: TM1TreeItem) => {
        if (!item || item.type !== 'instance') return;

        const instanceName = item.instanceName;
        const serverRealName = instanceName.substring(item.environmentName.length + 1);

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} first!`);
            return;
        }

        FileManagerPanel.render(instanceName, serverRealName);
    });

    // --- FUNCTION REFERENCE PANEL ---
    const functionRefProvider = new TM1FunctionReferenceProvider();
    vscode.window.registerTreeDataProvider('tm1FunctionReference', functionRefProvider);

    const insertFunctionCmd = vscode.commands.registerCommand('pa-code.insertFunction', (func: TM1Function) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        editor.insertSnippet(new vscode.SnippetString(func.snippet));
    });

    const searchFunctionsCmd = vscode.commands.registerCommand('pa-code.searchFunctions', async () => {
        const input = await vscode.window.showInputBox({ prompt: 'Search TM1 functions', placeHolder: 'e.g. CellPut, Dimension, Attr...' });
        if (input !== undefined) {
            functionRefProvider.setFilter(input);
        }
    });

    const clearFunctionSearchCmd = vscode.commands.registerCommand('pa-code.clearFunctionSearch', () => {
        functionRefProvider.clearFilter();
    });

    const deploymentCmd = vscode.commands.registerCommand('pa-code.deploymentAssistant', () => {
        DeploymentPanel.render();
    });

    // --- COMMAND: INSTANCE HUB ---
    const instanceHubCmd = vscode.commands.registerCommand('pa-code.instanceHub', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;

        const serverRealName = resolved.instanceName.substring(resolved.environmentName.length + 1);
        InstanceHubPanel.render(resolved.instanceName, resolved.environmentName, serverRealName);
    });

    // --- SHORTCUT COMMANDS (work without tree item) ---
    const shortcutSearchCmd = vscode.commands.registerCommand('pa-code.shortcutSearch', async () => {
        const resolved = await resolveInstance();
        if (resolved) vscode.commands.executeCommand('pa-code.searchProcesses', resolved);
    });
    const shortcutCreateProcessCmd = vscode.commands.registerCommand('pa-code.shortcutCreateProcess', async () => {
        const resolved = await resolveInstance();
        if (!resolved) return;
        // createProcess expects a folder item
        vscode.commands.executeCommand('pa-code.createProcess', {
            type: 'folder', environmentName: resolved.environmentName,
            instanceName: resolved.instanceName, contextValue: 'folder_processes'
        });
    });
    const shortcutPullAllCmd = vscode.commands.registerCommand('pa-code.shortcutPullAll', async () => {
        const resolved = await resolveInstance();
        if (resolved) vscode.commands.executeCommand('pa-code.syncFromTM1', resolved);
    });
    const shortcutServerLogCmd = vscode.commands.registerCommand('pa-code.shortcutServerLog', async () => {
        const resolved = await resolveInstance();
        if (resolved) vscode.commands.executeCommand('pa-code.viewLog', resolved);
    });
    const shortcutThreadViewerCmd = vscode.commands.registerCommand('pa-code.shortcutThreadViewer', async () => {
        const resolved = await resolveInstance();
        if (resolved) vscode.commands.executeCommand('pa-code.viewThreads', resolved);
    });
    const shortcutTIConsoleCmd = vscode.commands.registerCommand('pa-code.shortcutTiConsole', async () => {
        const resolved = await resolveInstance();
        if (resolved) vscode.commands.executeCommand('pa-code.tiConsole', resolved);
    });
    const shortcutDeploymentCmd = vscode.commands.registerCommand('pa-code.shortcutDeployment', async () => {
        await resolveInstance(); // just check there's a connection
        vscode.commands.executeCommand('pa-code.deploymentAssistant');
    });

    const impersonateUserCmd = vscode.commands.registerCommand('pa-code.impersonateUser', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        const instanceName = resolved.instanceName;
        const serverRealName = instanceName.substring(resolved.environmentName.length + 1);
        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} first!`);
            return;
        }
        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.name === resolved.environmentName);
        if (envConfig?.connectionType === 'v12Tenant') {
            vscode.window.showWarningMessage('User impersonation is a TM1 v11 feature and is not supported on v12 / Planning Analytics as a Service.');
            return;
        }
        const svc = TM1Service.getInstance();
        const current = svc.getImpersonation(instanceName);

        // Offer a searchable list of the model's users (avoids typos); fall back to
        // a free-text box if the user list can't be loaded.
        let target: string | undefined;
        try {
            const users = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Window, title: `Loading users of ${serverRealName}…` },
                () => svc.getUsersForImpersonation(instanceName)
            );
            const manualItem: any = { label: '$(edit) Enter a user name manually…', alwaysShow: true, manual: true };
            const items: any[] = [manualItem, ...users.map(u => ({
                label: u.Name,
                description: u.FriendlyName && u.FriendlyName !== u.Name ? u.FriendlyName : '',
                detail: u.isAdmin ? '$(shield) Admin — TM1 does not allow impersonating admins' : undefined,
                user: u
            }))];
            const picked: any = await vscode.window.showQuickPick(items, {
                title: `Impersonate a user on ${serverRealName}`,
                placeHolder: 'Type to search users…', matchOnDescription: true, ignoreFocusOut: true
            });
            if (!picked) return;
            if (!picked.manual) {
                if (picked.user.isAdmin) {
                    vscode.window.showWarningMessage(`'${picked.user.Name}' is an administrator. TM1 does not allow impersonating members of the ADMIN group — pick a non-admin user.`);
                    return;
                }
                target = picked.user.Name;
            }
        } catch {
            // Ignore — fall back to manual entry below.
        }
        if (!target) {
            const user = await vscode.window.showInputBox({
                prompt: `Impersonate which user on ${serverRealName}? You'll see TM1 exactly as that user does.`,
                value: current || '', placeHolder: 'e.g. jsmith', ignoreFocusOut: true
            });
            if (user === undefined) return;
            target = user.trim();
        }
        if (!target) return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Impersonating '${target}' on ${serverRealName}…`, cancellable: false }, async () => {
            try {
                const active = await svc.impersonate(instanceName, target!);
                vscode.window.showInformationMessage(`✓ Now viewing '${serverRealName}' as '${active}'. Your admin session is unchanged — use "Stop Impersonating" to switch back.`);
                updateImpersonationStatus();
                processProvider.refresh();
                quickActionsProvider.refresh();
            } catch (e: any) {
                updateImpersonationStatus();
                const status = e?.response?.status;
                const detail = e?.response?.data?.error?.message || e?.message || String(e);
                if (status === 403) {
                    vscode.window.showErrorMessage(`Impersonation of '${target}' failed (403 Forbidden). TM1 does not allow impersonating administrators (members of the ADMIN group) — choose a non-admin user. Details: ${detail}`);
                } else {
                    vscode.window.showErrorMessage(`Impersonation of '${target}' failed: ${detail}. It needs admin rights, TM1 v11 and an existing user name.`);
                }
            }
        });
    });

    const stopImpersonatingCmd = vscode.commands.registerCommand('pa-code.stopImpersonating', async (item?: TM1TreeItem) => {
        const svc = TM1Service.getInstance();
        let targets: string[];
        if (item && item.instanceName && svc.getImpersonation(item.instanceName)) {
            targets = [item.instanceName];
        } else {
            targets = svc.getConnectedInstanceNames().filter(n => !!svc.getImpersonation(n));
        }
        if (targets.length === 0) { vscode.window.showInformationMessage('No active impersonation.'); return; }
        for (const n of targets) { await svc.stopImpersonation(n); }
        vscode.window.showInformationMessage(`Stopped impersonating — back to your own session.`);
        updateImpersonationStatus();
        processProvider.refresh();
        quickActionsProvider.refresh();
    });

    const securityPanelCmd = vscode.commands.registerCommand('pa-code.securityPanel', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        SecurityPanel.render(resolved.instanceName);
    });

    const addFavoriteCmd = vscode.commands.registerCommand('pa-code.addFavorite', (item?: TM1TreeItem) => {
        if (!item || item.type !== 'process') return;
        favoritesProvider.addItem(item.label as string, '', item.instanceName, 'process');
        vscode.window.showInformationMessage(`Added "${item.label}" to Favorites`);
    });

    const addFavoriteFromEditorCmd = vscode.commands.registerCommand('pa-code.addFavoriteFromEditor', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const filePath = editor.document.fileName;
        const ext = path.extname(filePath);
        if (ext !== '.ti' && ext !== '.rux') return;

        const fileName = path.basename(filePath, ext);
        const parentDir = path.dirname(filePath);
        const serverFolder = path.dirname(parentDir);
        const serverRealName = path.basename(serverFolder);
        const envFolderDir = path.dirname(serverFolder);
        const envFolder = path.basename(envFolderDir);

        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.folder === envFolder);
        if (!envConfig) {
            vscode.window.showWarningMessage('Could not determine instance. Make sure the file is in a synced workspace.');
            return;
        }
        const instanceName = `${envConfig.name}_${serverRealName}`;
        const type = ext === '.ti' ? 'process' : 'rule';
        favoritesProvider.addItem(fileName, filePath, instanceName, type as any);
        vscode.window.showInformationMessage(`Added "${fileName}" to Favorites`);
    });

    const removeFavoriteCmd = vscode.commands.registerCommand('pa-code.removeFavorite', (item?: any) => {
        if (!item) return;
        favoritesProvider.removeItem(item.label as string, item.instanceName);
    });

    const clearRecentItemsCmd = vscode.commands.registerCommand('pa-code.clearRecentItems', () => {
        recentItemsProvider.clear();
    });

    const executeWithLastParamsCmd = vscode.commands.registerCommand('pa-code.executeWithLastParams', async (item?: ActivityBarItem) => {
        if (!item) return;
        const processName = item.label as string;
        const instanceName = item.instanceName;
        let environmentName = instanceName.split('_')[0];
        const config = ConfigManager.getConfig();
        for (const env of config.environments || []) {
            if (instanceName.startsWith(env.name + '_')) {
                environmentName = env.name;
                break;
            }
        }
        const serverRealName = instanceName.substring(environmentName.length + 1);

        if (!TM1Service.getInstance().isConnected(instanceName)) {
            vscode.window.showWarningMessage(`Please connect to ${serverRealName} via PA Code Explorer first!`);
            return;
        }

        await prepareExecuteProcess(environmentName, instanceName, serverRealName, processName);
    });

    const bulkDeleteCmd = vscode.commands.registerCommand('pa-code.bulkDelete', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        BulkDeletePanel.render(resolved.instanceName);
    });

    const mdxWizardCmd = vscode.commands.registerCommand('pa-code.mdxWizard', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        MDXWizardPanel.render(resolved.instanceName);
    });

    const subsetEditorCmd = vscode.commands.registerCommand('pa-code.subsetEditor', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        let initial: { dimension?: string; hierarchy?: string; subset?: string } | undefined;
        if (item && item.dimensionName) {
            initial = { dimension: item.dimensionName, hierarchy: item.hierarchyName, subset: item.subsetName };
        }
        SubsetEditorPanel.render(resolved.instanceName, initial);
    });

    const processLineageCmd = vscode.commands.registerCommand('pa-code.processLineage', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        let proc = (item && item.type === 'process') ? (item.label as string) : undefined;
        if (!proc) {
            const procs = await TM1Service.getInstance().getProcesses(resolved.instanceName, 'all');
            proc = await vscode.window.showQuickPick(procs.map(p => p.Name).sort(), { placeHolder: 'Process to trace lineage from' });
            if (!proc) return;
        }
        LineagePanel.showProcess(resolved.instanceName, proc);
    });

    const ruleLineageCmd = vscode.commands.registerCommand('pa-code.ruleLineage', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        let cube = item && (item.contextValue === 'tm1cube' || item.contextValue === 'tm1rule' || item.type === 'cube') ? (item.cubeName || (item.label as string)) : undefined;
        if (!cube) {
            const cubes = await TM1Service.getInstance().getCubes(resolved.instanceName, 'all');
            cube = await vscode.window.showQuickPick(cubes.map(c => c.Name).sort(), { placeHolder: 'Cube to trace rule lineage from' });
            if (!cube) return;
        }
        LineagePanel.showRule(resolved.instanceName, cube);
    });

    // Cube Viewer — PAW-style pivot grid.
    const openCubeViewCmd = vscode.commands.registerCommand('pa-code.openCubeView', async (_env?: string, instance?: string, cube?: string, view?: string) => {
        if (!instance || !cube) return;
        CubeViewerPanel.render(instance, cube, view);
    });

    const openCubeViewerCmd = vscode.commands.registerCommand('pa-code.openCubeViewer', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        const cube = (item && (item.cubeName || (item.type === 'cube' ? (item.label as string) : undefined)));
        if (!cube) { vscode.window.showWarningMessage('No cube selected.'); return; }
        CubeViewerPanel.render(resolved.instanceName, cube);
    });

    const choreManagerCmd = vscode.commands.registerCommand('pa-code.choreManager', async (item?: TM1TreeItem) => {
        const resolved = await resolveInstance(item);
        if (!resolved) return;
        ChoreManagerPanel.render(resolved.instanceName);
    });

    const processPropertiesCmd = vscode.commands.registerCommand('pa-code.processProperties', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !editor.document.fileName.endsWith('.ti')) {
            vscode.window.showWarningMessage('Please open a .ti process file first.');
            return;
        }
        ProcessPropertiesPanel.render(editor.document);
    });

    // Session health check — detect expired sessions every 20 minutes
    const sessionCheckTimer = setInterval(async () => {
        const tm1 = TM1Service.getInstance();
        const connected = tm1.getConnectedInstanceNames();
        if (connected.length === 0) return;

        let anyExpired = false;
        const expiredNames: string[] = [];
        for (const name of connected) {
            const alive = await tm1.checkSession(name);
            if (!alive) {
                anyExpired = true;
                expiredNames.push(name.split('_').slice(1).join('_'));
            }
        }
        if (anyExpired) {
            processProvider.refresh();
            vscode.window.showWarningMessage(`TM1 session expired: ${expiredNames.join(', ')}`);
        }
    }, 1200000);

    // WICHTIG: disconnectCmd zu subscriptions hinzufügen
    context.subscriptions.push(connectCmd, disconnectCmd, refreshCmd, createProcessCmd, openProcessCmd, deleteProcessCmd, renameProcessCmd, publishChangedFilesCmd, pullAllCmd, saveListener, searchCmd, clearSearchCmd, folderSearchCmd, clearFolderSearchCmd, openRuleCmd, checkRuleSyntaxCmd, executeProcessCmd, executeProcessByLensCmd, settingsCmd, viewLogCmd, showProxyLogCmd, whatsNewCmd, clearOAuthCredentialsCmd, pushToTM1Cmd, codeLensDisposable, tm1LineStatusBar, gotoTM1LineCmd, jumpHighlightDecoration, jumpToLineCmd, formatterDisposable, completionDisposable, functionSnippetDisposable, hoverDisposable, debugFactoryDisposable, debugConfigDisposable, debugProcessByLensCmd, manageConfigCmd, viewThreadsCmd, viewTIConsoleCmd, shortcutTIConsoleCmd, impersonateUserCmd, stopImpersonatingCmd, fileManagerCmd, insertFunctionCmd, searchFunctionsCmd, clearFunctionSearchCmd, deploymentCmd, instanceHubCmd, shortcutSearchCmd, shortcutCreateProcessCmd, shortcutPullAllCmd, shortcutServerLogCmd, shortcutThreadViewerCmd, shortcutDeploymentCmd, securityPanelCmd, addFavoriteCmd, addFavoriteFromEditorCmd, removeFavoriteCmd, clearRecentItemsCmd, executeWithLastParamsCmd, bulkDeleteCmd, mdxWizardCmd, subsetEditorCmd, processLineageCmd, ruleLineageCmd, openCubeViewCmd, openCubeViewerCmd, choreManagerCmd, processPropertiesCmd, tm1DiagnosticCollection, { dispose: () => clearInterval(sessionCheckTimer) });
}

export function deactivate() { }

// In-memory OAuth token cache per environment (access token + expiry + refresh token)
const oauthTokenCache = new Map<string, import('./PawOAuthService').PawOAuthToken>();

/**
 * Obtains a valid PAW OAuth bearer header for an environment, reusing a cached
 * access token, silently refreshing via a stored refresh token, or falling back
 * to a full browser login. Refresh tokens are persisted in SecretStorage so the
 * user can reconnect across restarts without re-authenticating in the browser.
 */
async function getOAuthBearer(
    context: vscode.ExtensionContext,
    environmentName: string,
    opts: import('./PawOAuthService').PawOAuthOptions,
    progress?: vscode.Progress<{ message?: string }>
): Promise<string> {
    const refreshKey = `pa-code.oauth.refresh.${environmentName}`;
    const now = Date.now();

    // 1. Valid cached access token?
    const cached = oauthTokenCache.get(environmentName);
    if (cached && cached.expiresAt && cached.expiresAt > now + 60000) {
        return `${cached.tokenType || 'Bearer'} ${cached.accessToken}`;
    }

    // 2. Try a silent refresh (in-memory or persisted refresh token)
    const refreshToken = cached?.refreshToken || await context.secrets.get(refreshKey);
    if (refreshToken) {
        try {
            progress?.report({ message: 'Refreshing session…' });
            const token = await PawOAuthService.refresh(opts, refreshToken);
            oauthTokenCache.set(environmentName, token);
            if (token.refreshToken) await context.secrets.store(refreshKey, token.refreshToken);
            return `${token.tokenType || 'Bearer'} ${token.accessToken}`;
        } catch {
            // Refresh failed (expired/revoked) — fall through to interactive login
        }
    }

    // 3. Full browser authorization code flow
    progress?.report({ message: 'Signing in…' });
    const token = await PawOAuthService.authenticate(opts);
    oauthTokenCache.set(environmentName, token);
    if (token.refreshToken) await context.secrets.store(refreshKey, token.refreshToken);
    return `${token.tokenType || 'Bearer'} ${token.accessToken}`;
}

/**
 * Connects to a PAW-routed TM1 database using OAuth. Retrieves the client secret
 * from SecretStorage (prompting once if missing), obtains a token (cache /
 * refresh / browser), discovers the target database if not fixed, and stores
 * the connection.
 */
async function connectViaOAuth(
    context: vscode.ExtensionContext,
    envConfig: any,
    instanceName: string,
    serverRealName: string,
    environmentName: string,
    processProvider: ProcessProvider,
    askPullAllAfterConnect: (instanceName: string, environmentName: string, serverRealName: string) => void
) {
    const pawUrl = envConfig.oauthPawUrl;
    const clientId = envConfig.oauthClientId;
    if (!pawUrl || !clientId) {
        vscode.window.showErrorMessage('OAuth environment is missing the PAW Base URL or Client ID. Open Settings to configure it.');
        return;
    }

    const secretKey = `pa-code.oauth.secret.${environmentName}`;
    let clientSecret = await context.secrets.get(secretKey);
    if (!clientSecret) {
        const entered = await vscode.window.showInputBox({
            prompt: `OAuth Client Secret for ${environmentName}`,
            password: true, ignoreFocusOut: true,
            placeHolder: 'Leave blank if your PAW OAuth client has no secret'
        });
        if (entered === undefined) return; // cancelled
        clientSecret = entered;
        if (clientSecret) {
            const save = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Save this client secret securely for next time?' });
            if (save === 'Yes') await context.secrets.store(secretKey, clientSecret);
        }
    }

    const tm1 = TM1Service.getInstance();
    const opts = {
        pawBaseUrl: pawUrl,
        clientId,
        clientSecret: clientSecret || undefined,
        redirectPort: envConfig.oauthRedirectPort || 53173,
        scope: 'v0userContext'
    };

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Connecting to ${environmentName} via OAuth…`,
        cancellable: false
    }, async (progress) => {
        try {
            const authHeader = await getOAuthBearer(context, environmentName, opts, progress);

            // Determine the target database/server
            let database = (envConfig.oauthDatabase || '').trim();
            if (!database) {
                progress.report({ message: 'Listing databases…' });
                const servers = await tm1.getPawServers(pawUrl, authHeader);
                if (servers.length === 0) {
                    vscode.window.showErrorMessage('No TM1 databases were returned by PAW for this account.');
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    servers.map(s => ({ label: s.Name, description: s.Status })),
                    { placeHolder: 'Select a TM1 database/server' }
                );
                if (!picked) return;
                database = picked.label;
            }

            progress.report({ message: `Connecting to ${database}…` });
            const restBase = tm1.buildPawTm1Base(pawUrl, database);
            await tm1.setConnectionWithOAuth(instanceName, restBase, authHeader, envConfig.timeout);

            vscode.window.showInformationMessage(`Connected to ${database} (${environmentName}) via OAuth.`);
            processProvider.refresh();
            askPullAllAfterConnect(instanceName, environmentName, serverRealName);
        } catch (e: any) {
            vscode.window.showErrorMessage(e.message);
        }
    });
}
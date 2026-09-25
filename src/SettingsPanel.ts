import * as vscode from 'vscode';
import { ConfigManager, TM1ProjectConfig, TM1EnvironmentConfig } from './ConfigManager';
import { TM1Service } from './TM1Service';

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, private readonly _extensionUri: vscode.Uri, private readonly _context: vscode.ExtensionContext, private readonly onConfigChanged?: () => void) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'saveConfig':
                        try {
                            const newConfig = {
                                environments: message.environments,
                                featureSettings: ConfigManager.getConfig().featureSettings
                            };
                            ConfigManager.saveConfig(newConfig);
                            vscode.window.showInformationMessage('Configuration saved successfully!');
                            if (this.onConfigChanged) this.onConfigChanged();
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to save configuration: ${err.message}`);
                        }
                        return;
                    case 'saveFeatureSettings':
                        try {
                            const cfg = ConfigManager.getConfig();
                            cfg.featureSettings = message.featureSettings;
                            ConfigManager.saveConfig(cfg);
                            vscode.window.showInformationMessage('Feature settings saved!');
                        } catch (err: any) {
                            vscode.window.showErrorMessage(`Failed to save feature settings: ${err.message}`);
                        }
                        return;
                    case 'refreshConfig':
                        this._sendConfigToWebview();
                        return;
                    case 'showError':
                        vscode.window.showErrorMessage(message.message);
                        return;
                    case 'storeOAuthSecret':
                        // Store the OAuth client secret in SecretStorage — never in tm1-project.json
                        (async () => {
                            const key = `pa-code.oauth.secret.${message.envName}`;
                            if (message.secret) {
                                await this._context.secrets.store(key, message.secret);
                            }
                            this._panel.webview.postMessage({ command: 'oauthSecretStored', envName: message.envName });
                        })();
                        return;
                    case 'checkOAuthSecret':
                        (async () => {
                            const key = `pa-code.oauth.secret.${message.envName}`;
                            const existing = await this._context.secrets.get(key);
                            this._panel.webview.postMessage({ command: 'oauthSecretStatus', envName: message.envName, hasSecret: !!existing });
                        })();
                        return;
                    case 'testConnection':
                        (async () => {
                            try {
                                const result = await TM1Service.getInstance().testConnection(message.data || {});
                                this._panel.webview.postMessage({ command: 'testConnectionResult', ok: result.ok, message: result.message });
                            } catch (err: any) {
                                this._panel.webview.postMessage({ command: 'testConnectionResult', ok: false, message: err?.message || String(err) });
                            }
                        })();
                        return;
                    case 'confirmDelete':
                        vscode.window.showWarningMessage(`Are you sure you want to delete the "${message.envName}" environment?`, { modal: true }, 'Yes').then(selection => {
                            if (selection === 'Yes') {
                                this._panel.webview.postMessage({ command: 'deleteConfirmed', index: message.index });
                            }
                        });
                        return;
                }
            },
            null,
            this._disposables
        );

        // Send initial config
        this._sendConfigToWebview();
    }

    public static render(extensionUri: vscode.Uri, context: vscode.ExtensionContext, onConfigChanged?: () => void) {
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
        } else {
            const panel = vscode.window.createWebviewPanel(
                'tm1Settings',
                'TM1 Environments Settings',
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    // Keep the form alive when the panel loses focus so a half-filled
                    // connection isn't lost when the user clicks into another window.
                    retainContextWhenHidden: true,
                    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
                }
            );

            SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri, context, onConfigChanged);
        }
    }

    private _sendConfigToWebview() {
        const config = ConfigManager.getConfig();
        const defaultScope = vscode.workspace.getConfiguration('pa-code').get<string>('connections.defaultScope', 'workspace');
        if (this._panel) {
            this._panel.webview.postMessage({ command: 'loadConfig', config: config, defaultScope });
        }
    }

    public dispose() {
        SettingsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getWebviewContent() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TM1 Environments Settings</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
        }
        h2 {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 14px;
            cursor: pointer;
            border-radius: 6px;
            font-size: 13px;
            transition: background-color .15s ease;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        button.danger {
            background-color: var(--vscode-errorForeground);
            color: white;
        }
        table {
            width: 100%;
            border-collapse: separate;
            border-spacing: 0;
            margin-top: 20px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 10px;
            overflow: hidden;
        }
        thead th {
            background-color: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.14));
            color: var(--vscode-foreground);
            font-weight: 600;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: .04em;
            opacity: .85;
        }
        th, td {
            text-align: left;
            padding: 11px 14px;
            border-bottom: 1px solid var(--vscode-panel-border);
        }
        tbody tr:last-child td { border-bottom: none; }
        tbody tr:hover { background-color: var(--vscode-list-hoverBackground); }
        .modal {
            display: none;
            position: fixed;
            top: 0; left: 0; width: 100%; height: 100%;
            background-color: rgba(0,0,0,0.5);
            z-index: 1000;
        }
        .modal-content {
            background-color: var(--vscode-editor-background);
            margin: 4% auto;
            padding: 24px;
            border: 1px solid var(--vscode-panel-border);
            width: 540px;
            max-width: 92%;
            max-height: 86vh;
            overflow-y: auto;
            border-radius: 12px;
            box-shadow: 0 10px 32px rgba(0,0,0,0.45);
        }
        .form-group {
            margin-bottom: 15px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        .form-group label.req::after {
            content: ' *';
            color: var(--vscode-inputValidation-errorForeground, #f14c4c);
            font-weight: bold;
        }
        .form-group .invalid,
        input.invalid, select.invalid {
            border-color: var(--vscode-inputValidation-errorBorder, #f14c4c) !important;
            box-shadow: 0 0 0 1px var(--vscode-inputValidation-errorBorder, #f14c4c);
        }
        .form-group input[type="text"],
        .form-group input[type="number"],
        .form-group input[type="password"] {
            width: 100%;
            padding: 8px 10px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            transition: border-color .15s ease;
        }
        .form-group select {
            width: 100%;
            padding: 8px 10px;
            box-sizing: border-box;
            background-color: var(--vscode-dropdown-background);
            color: var(--vscode-dropdown-foreground);
            border: 1px solid var(--vscode-dropdown-border);
            border-radius: 6px;
        }
        .form-group input:focus,
        .form-group select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .test-result {
            margin-top: 10px;
            padding: 10px 12px;
            border-radius: 8px;
            font-size: 12px;
            line-height: 1.4;
            border-left: 3px solid transparent;
            white-space: pre-wrap;
        }
        .test-result.ok { background: rgba(63,185,80,0.12); border-left-color: var(--vscode-testing-iconPassed, #3fb950); }
        .test-result.err { background: rgba(220,80,80,0.12); border-left-color: var(--vscode-errorForeground); }
        .test-result.pending { background: var(--vscode-input-background); border-left-color: var(--vscode-focusBorder); opacity: .9; }
        #testConnBtn {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background-color: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.16));
            color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
            border: 1px solid var(--vscode-contrastBorder, var(--vscode-panel-border));
            padding: 8px 14px;
            border-radius: 6px;
        }
        #testConnBtn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,0.28));
        }
        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 20px;
        }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0; }
        .tab-btn {
            background: transparent;
            color: var(--vscode-editor-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
            border-radius: 0;
            margin-bottom: -1px;
        }
        .tab-btn.active {
            border-bottom-color: var(--vscode-focusBorder);
            color: var(--vscode-focusBorder);
        }
        .tab-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
        .features-section { margin-top: 20px; }
        .features-section h3 { margin-bottom: 8px; font-size: 14px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
        .feature-row { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 16px; padding: 12px; background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
        .feature-row input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; }
        .feature-row label { cursor: pointer; }
        .feature-row .feature-desc { font-size: 11px; opacity: 0.7; margin-top: 2px; }
        .actions-cell { white-space: nowrap; }
    </style>
</head>
<body>

    <div class="tabs">
        <button class="tab-btn active" onclick="showTab('envTab', this)">Environments</button>
        <button class="tab-btn" onclick="showTab('featuresTab', this)">Features</button>
    </div>

    <!-- Environments Tab -->
    <div id="envTab" class="tab-content">
    <div class="header">
        <h2>
            TM1 Environments Configuration
            <button id="addBtn">+ Add Environment</button>
        </h2>
    </div>

    <table id="environmentsTable">
        <thead>
            <tr>
                <th>Name</th>
                <th>Admin Host</th>
                <th>Port</th>
                <th>SSL</th>
                <th>Folder</th>
                <th>Local Files</th>
                <th>Scope</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>
            <!-- Rows generated by JS -->
        </tbody>
    </table>

    <!-- Edit Modal -->
    <div id="editModal" class="modal">
        <div class="modal-content">
            <h3 id="modalTitle">Add Environment</h3>
            <input type="hidden" id="editIndex" value="-1">
            <div class="form-group">
                <label id="lblName">Name (Unique Identifier)</label>
                <input type="text" id="inpName" placeholder="e.g. Planning_PROD">
            </div>
            <div class="form-group">
                <label>Description</label>
                <input type="text" id="inpDesc" placeholder="Optional description">
            </div>
            <div class="form-group">
                <label>Storage Scope</label>
                <select id="inpScope" style="width: 100%; padding: 8px;">
                    <option value="workspace">This workspace only</option>
                    <option value="global">Global (available in every workspace)</option>
                    <option value="file">Project file (legacy tm1-project.json)</option>
                </select>
            </div>
            <div class="form-group">
                <label>Connection Type</label>
                <select id="inpConnectionType" style="width: 100%; padding: 8px;">
                    <option value="onPremise">Admin Server (Discovers Instances)</option>
                    <option value="singleInstance">Single Instance (Host + Port)</option>
                    <option value="customUrl">Cloud / Custom REST URL</option>
                    <option value="v12Tenant">v12 Tenant (Multi-Database)</option>
                </select>
            </div>

            <details id="connExamplesBox" style="margin: 0 0 12px; background: rgba(127,127,127,0.06); border: 1px solid var(--vscode-panel-border,#333); border-radius:6px; padding:8px 10px;">
                <summary id="connExamplesSummary" style="cursor:pointer; font-size:12px; opacity:0.9;">📖 Connection example</summary>
                <div id="connExamples" style="font-size:11px; opacity:0.88; line-height:1.5; margin-top:8px;">
                    <p class="ex" data-types="onPremise" style="margin:6px 0;"><b>On-prem v11 — Admin Server</b><br>Type: <i>Admin Server</i> · Host: <code>tm1server.company.com</code> · Port: <code>5898</code> (Admin Server port) · Auth: <i>Basic</i>, <i>CAM Browser SSO</i> or <i>Integrated Login</i>.</p>
                    <p class="ex" data-types="singleInstance" style="margin:6px 0;"><b>On-prem v11 — Single Instance</b><br>Type: <i>Single Instance</i> · Host + the instance's <b>HTTP(S) REST port</b> (e.g. <code>12354</code>) · Auth: <i>Basic</i>.</p>
                    <p class="ex" data-types="customUrl" style="margin:6px 0;"><b>PA on Cloud (v11)</b><br>Type: <i>Cloud / Custom REST URL</i> · URL: <code>https://&lt;region&gt;.planning-analytics.cloud.ibm.com/tm1/api/&lt;tenant&gt;/</code> · Auth: <b>API Key / Token</b>.</p>
                    <p class="ex" data-types="customUrl v12Tenant" style="margin:6px 0;"><b>PA as a Service (v12) — API key</b> ⭐<br>Type: <i>Cloud / Custom REST URL</i> · URL: <code>https://&lt;region&gt;.planninganalytics.saas.ibm.com/api/&lt;tenant&gt;/v0/tm1/&lt;database&gt;</code> (e.g. …/v0/tm1/TM1) · Auth: <b>API Key / Token</b>. On connect the username is set to <code>apikey</code> automatically and you paste the <b>API key</b> as the password.<br><i>Typical 401 causes: choosing CAM instead of API Key, or leaving off the <code>/v0/tm1/&lt;database&gt;</code> tail of the URL.</i></p>
                    <p class="ex" data-auth="OAuth" style="margin:6px 0;"><b>PAW OAuth</b><br>Auth: <i>OAuth</i> — your PAW admin issues a Client ID; register the shown Callback URL in PAW.</p>
                </div>
            </details>
            


            <div id="onPremiseFields">
                <div class="form-group">
                    <label id="lblHost">Admin Host</label>
                    <input type="text" id="inpHost" placeholder="e.g. your-tm1-server.com">
                </div>
                <div class="form-group">
                    <label id="lblPort">Port</label>
                    <input type="number" id="inpPort" placeholder="e.g. 5898">
                </div>
                <div class="form-group">
                    <label>
                        <input type="checkbox" id="inpSsl"> Use SSL (HTTPS)
                    </label>
                </div>
            </div>



            <div class="form-group">
                <label>Authentication Method</label>
                <select id="inpAuthMethod" style="width: 100%; padding: 8px;">
                    <option value="Prompt">Prompt / Auto-Detect</option>
                    <option value="Basic">Basic (User + Password)</option>
                    <option value="Integrated Login">Integrated Login (Windows / Security Mode 3)</option>
                    <option value="CAM Browser SSO">CAM Browser SSO / MFA</option>
                    <option value="IBM Cloud">IBM Cloud (Non-Interactive LDAP)</option>
                    <option value="API Key">API Key / Token</option>
                    <option value="OAuth">OAuth (PAW Authorization Code)</option>
                </select>
                <div class="hint" id="hintAuth" style="font-size: 11px; opacity: 0.7; margin-top: 5px;"></div>
            </div>

            <div id="oauthSettings" style="display: none;">
                <div class="hint" style="font-size:11px; opacity:0.75; margin-bottom:10px; padding:8px; border-left:2px solid #0e639c;">
                    Your PAW administrator registers an OAuth integration in PAW and gives you a <b>Client ID</b> (and optionally a <b>Client Secret</b>). Requires PAW 3.1.8+ / 2.1.21+.
                </div>
                <div class="form-group">
                    <label id="lblOAuthPawUrl">PAW Base URL</label>
                    <input type="text" id="inpOAuthPawUrl" placeholder="e.g. https://your-paw-host">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Host only, <b>without</b> any /api path. The extension adds /oauth2/... and /api/v1/tm1/... automatically.</div>
                </div>
                <div class="form-group">
                    <label id="lblOAuthClientId">OAuth Client ID</label>
                    <input type="text" id="inpOAuthClientId" placeholder="Client ID from the PAW OAuth integration">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Identifies the app (pa-code) to PAW &mdash; this is <b>not</b> your username.</div>
                </div>
                <div class="form-group">
                    <label>OAuth Client Secret <small id="oauthSecretHint" style="opacity:0.7"></small></label>
                    <input type="password" id="inpOAuthClientSecret" placeholder="Stored securely in VS Code SecretStorage">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Stored encrypted in VS Code, never in the project file. Leave blank for a public client or to be prompted once on connect.</div>
                </div>
                <div class="form-group">
                    <label>Callback Port</label>
                    <input type="number" id="inpOAuthRedirectPort" placeholder="53173">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Keep 53173 unless that port is already in use on your machine.</div>
                </div>
                <div class="form-group">
                    <label>Callback URL (register this in PAW)</label>
                    <input type="text" id="inpOAuthCallbackUrl" readonly style="opacity:0.8">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Read-only. Give this exact URL to your PAW admin to register as an allowed redirect URI.</div>
                </div>
                <div class="form-group">
                    <label>TM1 Database / Server (optional)</label>
                    <input type="text" id="inpOAuthDatabase" placeholder="Leave blank to list available databases on connect">
                    <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Leave blank to pick from a list when you connect, or fix one database here.</div>
                </div>
            </div>

            <div id="camSettings" style="display: none;">
                <div class="form-group">
                    <label>Cognos / CAM Dispatcher URL</label>
                    <input type="text" id="inpCamUrl" placeholder="e.g. https://server/ibmcognos/bi/v1/disp">
                </div>
                <div class="form-group">
                    <label>Standard CAM Namespace</label>
                    <input type="text" id="inpNamespace" placeholder="e.g. LDAP">
                </div>
            </div>

            <div id="cloudFields" style="display: none;">
                <div class="form-group">
                    <label id="lblRestUrl">Base REST API URL</label>
                    <input type="text" id="inpRestUrl" placeholder="e.g. https://.../api/tenant/v0/tm1/myInstance/">
                </div>
            </div>

            <div class="form-group">
                <label id="lblFolder">Local Workspace Folder</label>
                <input type="text" id="inpFolder" placeholder="e.g. PROD">
            </div>
            <div class="form-group">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:normal;">
                    <input type="checkbox" id="inpStoreLocally" checked style="width:auto;"> Store process/rule files locally on "Pull All"
                </label>
                <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">On (default): Pull writes files to the workspace folder. Off: stay connected for browsing/analysis (Cube Viewer, rules, processes) without writing files — e.g. keep a repo Dev-only while Test/Prod stay connected.</div>
            </div>
            <div class="form-group">
                <label>Pull from Server on connect</label>
                <select id="inpPullOnConnect" style="width: 100%; padding: 8px;">
                    <option value="ask">Ask each time (default)</option>
                    <option value="auto">Always pull automatically</option>
                    <option value="never">Never pull</option>
                </select>
                <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">After connecting: <b>Ask</b> prompts you (current behaviour), <b>Always</b> pulls all processes/rules without asking, <b>Never</b> skips it — ideal when your files come from Git (e.g. the dev branch) and you don't want the server version pulled over them.</div>
            </div>
            <div class="form-group">
                <label>Request Timeout (ms)</label>
                <input type="number" id="inpTimeout" placeholder="15000" min="1000">
                <div class="hint" style="font-size:11px; opacity:0.7; margin-top:4px;">Per-environment REST timeout. Increase for slow connections — default 15000 (15s); e.g. 30000 for 30s.</div>
            </div>
            <div class="form-group">
                <button type="button" id="testConnBtn" class="secondary">🔌 Test Connection</button>
                <div id="testConnResult" class="test-result" style="display:none;"></div>
            </div>
            <div class="form-actions">
                <button id="cancelBtn" class="secondary">Cancel</button>
                <button id="saveBtn">Save</button>
            </div>
        </div>
    </div>
    </div> <!-- end #envTab -->

    <!-- Features Tab -->
    <div id="featuresTab" class="tab-content">
        <div class="features-section">
            <h3>IntelliSense</h3>
            <div class="feature-row">
                <input type="checkbox" id="chkElementCompletion">
                <div>
                    <label for="chkElementCompletion"><strong>Enable Element Auto-Complete</strong></label>
                    <div class="feature-desc">When enabled, element names are suggested inside string literals after you start typing. Only fetched when at least 1 character is typed. May be slow for large dimensions.</div>
                </div>
            </div>
            <button id="saveFeaturesBtn">Save Feature Settings</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentEnvironments = [];
        let currentFeatureSettings = { enableElementCompletion: false };
        let defaultScope = 'workspace';

        function showTab(tabId, btn) {
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.getElementById(tabId).classList.add('active');
            btn.classList.add('active');
        }
        // Show first tab by default
        document.getElementById('envTab').classList.add('active');

        document.getElementById('saveFeaturesBtn').addEventListener('click', () => {
            currentFeatureSettings.enableElementCompletion = document.getElementById('chkElementCompletion').checked;
            vscode.postMessage({ command: 'saveFeatureSettings', featureSettings: currentFeatureSettings });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'loadConfig':
                    currentEnvironments = message.config.environments || [];
                    currentFeatureSettings = message.config.featureSettings || { enableElementCompletion: false };
                    defaultScope = message.defaultScope || 'workspace';
                    document.getElementById('chkElementCompletion').checked = currentFeatureSettings.enableElementCompletion;
                    renderTable();
                    break;
                case 'deleteConfirmed':
                    currentEnvironments.splice(message.index, 1);
                    renderTable();
                    vscode.postMessage({ command: 'saveConfig', environments: currentEnvironments });
                    break;
                case 'oauthSecretStatus':
                    if (typeof oauthSecretHint !== 'undefined' && oauthSecretHint) {
                        oauthSecretHint.innerText = message.hasSecret ? '(a secret is stored — leave blank to keep it)' : '(no secret stored yet)';
                    }
                    break;
                case 'oauthSecretStored':
                    if (typeof oauthSecretHint !== 'undefined' && oauthSecretHint) {
                        oauthSecretHint.innerText = '(secret saved securely)';
                    }
                    break;
                case 'testConnectionResult': {
                    const el = document.getElementById('testConnResult');
                    if (el) {
                        el.style.display = 'block';
                        el.className = 'test-result ' + (message.ok ? 'ok' : 'err');
                        el.textContent = (message.ok ? '✅ ' : '❌ ') + message.message;
                    }
                    break;
                }
            }
        });

        // Request initial config
        vscode.postMessage({ command: 'refreshConfig' });

        const modal = document.getElementById('editModal');
        const modalTitle = document.getElementById('modalTitle');
        const editIndex = document.getElementById('editIndex');
        
        const inpName = document.getElementById('inpName');
        const inpDesc = document.getElementById('inpDesc');
        const inpConnectionType = document.getElementById('inpConnectionType');
        const onPremiseFields = document.getElementById('onPremiseFields');
        const cloudFields = document.getElementById('cloudFields');
        const lblHost = document.getElementById('lblHost');
        const lblPort = document.getElementById('lblPort');
        const inpHost = document.getElementById('inpHost');
        const inpPort = document.getElementById('inpPort');
        const inpSsl = document.getElementById('inpSsl');
        const inpRestUrl = document.getElementById('inpRestUrl');

        const inpFolder = document.getElementById('inpFolder');
        const inpTimeout = document.getElementById('inpTimeout');
        const inpStoreLocally = document.getElementById('inpStoreLocally');
        // "Local Workspace Folder" is only meaningful when files are stored locally.
        function syncFolderState() {
            const on = inpStoreLocally.checked;
            inpFolder.disabled = !on;
            inpFolder.style.opacity = on ? '1' : '0.5';
            inpFolder.placeholder = on ? 'e.g. PROD' : 'Not used (browse-only)';
            markRequiredLabels();
        }
        inpStoreLocally.addEventListener('change', syncFolderState);
        const inpAuthMethod = document.getElementById('inpAuthMethod');
        const hintAuth = document.getElementById('hintAuth');
        const camSettings = document.getElementById('camSettings');
        const inpCamUrl = document.getElementById('inpCamUrl');
        const inpNamespace = document.getElementById('inpNamespace');
        const oauthSettings = document.getElementById('oauthSettings');
        const inpOAuthPawUrl = document.getElementById('inpOAuthPawUrl');
        const inpOAuthClientId = document.getElementById('inpOAuthClientId');
        const inpOAuthClientSecret = document.getElementById('inpOAuthClientSecret');
        const inpOAuthRedirectPort = document.getElementById('inpOAuthRedirectPort');
        const inpOAuthCallbackUrl = document.getElementById('inpOAuthCallbackUrl');
        const inpOAuthDatabase = document.getElementById('inpOAuthDatabase');
        const oauthSecretHint = document.getElementById('oauthSecretHint');

        // --- Required-field marking, dynamic examples & validation helpers ---
        const lblName = document.getElementById('lblName');
        const lblFolder = document.getElementById('lblFolder');
        const lblRestUrl = document.getElementById('lblRestUrl');
        const lblOAuthPawUrl = document.getElementById('lblOAuthPawUrl');
        const lblOAuthClientId = document.getElementById('lblOAuthClientId');
        function setReq(lbl, on){ if(lbl){ lbl.classList.toggle('req', !!on); } }
        function markRequiredLabels(){
            const type = inpConnectionType.value; const auth = inpAuthMethod.value;
            const isCloud = (type === 'customUrl' || type === 'v12Tenant');
            setReq(lblName, true);
            setReq(lblFolder, inpStoreLocally.checked);
            setReq(lblHost, !isCloud && auth !== 'OAuth');
            setReq(lblPort, !isCloud && auth !== 'OAuth');
            setReq(lblRestUrl, isCloud && auth !== 'OAuth');
            setReq(lblOAuthPawUrl, auth === 'OAuth');
            setReq(lblOAuthClientId, auth === 'OAuth');
        }
        function updateExamples(){
            const type = inpConnectionType.value; const auth = inpAuthMethod.value;
            document.querySelectorAll('#connExamples .ex').forEach(function(p){
                const forAuth = p.getAttribute('data-auth');
                const show = forAuth ? (auth === forAuth) : ((p.getAttribute('data-types')||'').split(' ').indexOf(type) >= 0);
                p.style.display = show ? 'block' : 'none';
            });
            const sum = document.getElementById('connExamplesSummary');
            if(sum){ const opt = inpConnectionType.options[inpConnectionType.selectedIndex]; sum.textContent = '📖 Connection example for: ' + (opt ? opt.text : type) + (auth === 'OAuth' ? ' · OAuth' : ''); }
        }
        function clearInvalid(){ document.querySelectorAll('.invalid').forEach(function(el){ el.classList.remove('invalid'); }); }
        ['inpName','inpFolder','inpHost','inpPort','inpRestUrl','inpOAuthPawUrl','inpOAuthClientId'].forEach(function(id){
            const el = document.getElementById(id); if(el){ el.addEventListener('input', function(){ el.classList.remove('invalid'); }); }
        });

        function updateCallbackUrl() {
            const port = (inpOAuthRedirectPort.value || '53173').trim();
            inpOAuthCallbackUrl.value = 'http://127.0.0.1:' + port + '/callback';
        }
        inpOAuthRedirectPort.addEventListener('input', updateCallbackUrl);

        function updateAuthHint() {
            const val = inpAuthMethod.value;
            camSettings.style.display = (val === 'CAM Browser SSO' || val === 'Prompt') ? 'block' : 'none';
            oauthSettings.style.display = (val === 'OAuth') ? 'block' : 'none';
            if (val === 'OAuth') updateCallbackUrl();

            // Reset any stale test-connection result when the setup changes.
            const _tr = document.getElementById('testConnResult');
            if (_tr) { _tr.style.display = 'none'; _tr.textContent = ''; }

            // OAuth builds its own REST path from the PAW URL, so the manual
            // Base REST API URL and on-prem Host/Port fields are irrelevant.
            if (val === 'OAuth') {
                cloudFields.style.display = 'none';
                onPremiseFields.style.display = 'none';
            } else {
                const type = inpConnectionType.value;
                const isCloud = (type === 'customUrl' || type === 'v12Tenant');
                cloudFields.style.display = isCloud ? 'block' : 'none';
                onPremiseFields.style.display = isCloud ? 'none' : 'block';
            }

            if (val === 'CAM Browser SSO') {
                hintAuth.innerText = "Will open an interactive browser window to log you in (best for SSO/MFA).";
            } else if (val === 'Prompt') {
                hintAuth.innerText = "The extension will check the server security mode and ask for credentials or open the browser window as needed.";
            } else if (val === 'IBM Cloud') {
                hintAuth.innerText = "Uses LDAP namespace and fixed credentials (for non-interactive cloud access).";
            } else if (val === 'OAuth') {
                hintAuth.innerText = "Signs in to PAW via OAuth 2.0 and connects to a PAW-routed TM1 database. Register the callback URL below in your PAW OAuth client.";
            } else if (val === 'Integrated Login') {
                hintAuth.innerText = "Windows Integrated Login (TM1 Security Mode 2/3): signs in with Kerberos SSO from your current Windows session — no username or password needed (like Architect). Only if SSO can't be used does it ask for Windows/AD credentials to try NTLM. No CAM namespace.";
            } else if (val === 'API Key') {
                hintAuth.innerText = "Cloud / v12 API key: the username is set to 'apikey' automatically and you paste your API key as the password on connect. Use it with 'Cloud / Custom REST URL' and the full REST URL — for PA as a Service that ends with /v0/tm1/<database>.";
            } else {
                hintAuth.innerText = "";
            }
            markRequiredLabels();
            updateExamples();
        }

        inpConnectionType.addEventListener('change', (e) => {
            const type = e.target.value;
            if (type === 'customUrl') {
                onPremiseFields.style.display = 'none';
                cloudFields.style.display = 'block';
            } else if (type === 'v12Tenant') {
                onPremiseFields.style.display = 'none';
                cloudFields.style.display = 'block';
            } else if (type === 'singleInstance') {
                onPremiseFields.style.display = 'block';
                cloudFields.style.display = 'none';
                lblHost.textContent = "TM1 Host / IP";
                lblPort.textContent = "HTTP Port (REST API)";
            } else {
                onPremiseFields.style.display = 'block';
                cloudFields.style.display = 'none';
                lblHost.textContent = "Admin Host";
                lblPort.textContent = "Port";
            }
            updateAuthHint();
        });

        inpAuthMethod.addEventListener('change', updateAuthHint);

        document.getElementById('addBtn').addEventListener('click', () => {
            modalTitle.textContent = "Add Environment";
            editIndex.value = -1;
            inpName.value = "";
            inpDesc.value = "";
            inpConnectionType.value = "onPremise";
            onPremiseFields.style.display = 'block';
            cloudFields.style.display = 'none';
            lblHost.textContent = "Admin Host";
            lblPort.textContent = "Port";
            inpHost.value = "";
            inpPort.value = "5898";
            inpSsl.checked = true;
            inpRestUrl.value = "";
            inpAuthMethod.value = "Prompt";
            inpCamUrl.value = "";
            inpNamespace.value = "";
            inpOAuthPawUrl.value = "";
            inpOAuthClientId.value = "";
            inpOAuthClientSecret.value = "";
            inpOAuthRedirectPort.value = "53173";
            inpOAuthDatabase.value = "";
            oauthSecretHint.innerText = "";
            updateAuthHint();
            inpFolder.value = "";
            inpTimeout.value = "15000";
            document.getElementById('inpStoreLocally').checked = true;
            document.getElementById('inpPullOnConnect').value = 'ask';
            syncFolderState();
            document.getElementById('inpScope').value = defaultScope;
            clearInvalid();
            modal.style.display = 'block';
        });

        document.getElementById('cancelBtn').addEventListener('click', () => {
            modal.style.display = 'none';
        });

        document.getElementById('testConnBtn').addEventListener('click', () => {
            const resultEl = document.getElementById('testConnResult');
            const data = {
                connectionType: inpConnectionType.value,
                authMethod: inpAuthMethod.value,
                host: inpHost.value.trim(),
                port: parseInt(inpPort.value.trim(), 10) || undefined,
                ssl: inpSsl.checked,
                restUrl: inpRestUrl.value.trim(),
                oauthPawUrl: inpOAuthPawUrl.value.trim(),
                timeoutMs: parseInt(inpTimeout.value.trim(), 10) || 15000
            };
            resultEl.style.display = 'block';
            resultEl.className = 'test-result pending';
            resultEl.textContent = '⏳ Testing connection…';
            vscode.postMessage({ command: 'testConnection', data: data });
        });

        document.getElementById('saveBtn').addEventListener('click', () => {
            const formData = {
                name: inpName.value.trim(),
                description: inpDesc.value.trim(),
                connectionType: inpConnectionType.value,
                adminHost: inpHost.value.trim(),
                port: parseInt(inpPort.value.trim(), 10) || 5898,
                ssl: inpSsl.checked,
                restUrl: inpRestUrl.value.trim(),
                authMethod: inpAuthMethod.value,
                camUrl: inpCamUrl.value.trim(),
                namespace: inpNamespace.value.trim(),
                oauthPawUrl: inpOAuthPawUrl.value.trim(),
                oauthClientId: inpOAuthClientId.value.trim(),
                oauthRedirectPort: parseInt(inpOAuthRedirectPort.value.trim(), 10) || 53173,
                oauthDatabase: inpOAuthDatabase.value.trim(),
                timeout: parseInt(inpTimeout.value.trim(), 10) || 15000,
                folder: inpFolder.value.trim(),
                storeFilesLocally: document.getElementById('inpStoreLocally').checked,
                pullOnConnect: document.getElementById('inpPullOnConnect').value,
                scope: document.getElementById('inpScope').value
            };

            // A folder is only required when files are stored locally; browse-only
            // connections default it to the environment name for internal paths.
            if (!formData.storeFilesLocally && !formData.folder) { formData.folder = formData.name; }

            // Field-by-field validation: name each missing field and highlight it.
            clearInvalid();
            const missing = [];
            if (!formData.name) { missing.push({ el: inpName, label: 'Name' }); }
            if (formData.storeFilesLocally && !inpFolder.value.trim()) { missing.push({ el: inpFolder, label: 'Local Workspace Folder' }); }
            if ((formData.connectionType === 'onPremise' || formData.connectionType === 'singleInstance') && formData.authMethod !== 'OAuth') {
                if (!formData.adminHost) { missing.push({ el: inpHost, label: (lblHost ? lblHost.textContent : 'Host') }); }
                if (!inpPort.value.trim()) { missing.push({ el: inpPort, label: (lblPort ? lblPort.textContent : 'Port') }); }
            }
            if ((formData.connectionType === 'customUrl' || formData.connectionType === 'v12Tenant') && !formData.restUrl && formData.authMethod !== 'OAuth') {
                missing.push({ el: inpRestUrl, label: 'Base REST API URL' });
            }
            if (formData.authMethod === 'OAuth') {
                if (!formData.oauthPawUrl) { missing.push({ el: inpOAuthPawUrl, label: 'PAW Base URL' }); }
                if (!formData.oauthClientId) { missing.push({ el: inpOAuthClientId, label: 'OAuth Client ID' }); }
            }
            if (missing.length) {
                missing.forEach(function(m){ if (m.el) { m.el.classList.add('invalid'); } });
                if (missing[0].el) { missing[0].el.scrollIntoView({ block: 'center' }); missing[0].el.focus(); }
                const names = missing.map(function(m){ return m.label; }).join(', ');
                vscode.postMessage({ command: 'showError', message: 'Please fill in the required field' + (missing.length > 1 ? 's' : '') + ': ' + names });
                return;
            }

            // Store the client secret securely (never persisted in tm1-project.json)
            if (formData.authMethod === 'OAuth' && inpOAuthClientSecret.value) {
                vscode.postMessage({ command: 'storeOAuthSecret', envName: formData.name, secret: inpOAuthClientSecret.value });
            }

            const idx = parseInt(editIndex.value, 10);
            if (idx >= 0) {
                currentEnvironments[idx] = formData;
            } else {
                currentEnvironments.push(formData);
            }

            modal.style.display = 'none';
            renderTable();
            vscode.postMessage({ command: 'saveConfig', environments: currentEnvironments });
        });

        function renderTable() {
            const tbody = document.querySelector('#environmentsTable tbody');
            tbody.innerHTML = '';
            
            if (currentEnvironments.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;">No environments configured.</td></tr>';
                return;
            }

            currentEnvironments.forEach((env, index) => {
                const scopeLabel = env.scope === 'global' ? 'Global' : (env.scope === 'file' ? 'Project file' : 'Workspace');
                const tr = document.createElement('tr');
                tr.innerHTML = \`
                    <td><strong>\${escapeHtml(env.name)}</strong><br><small>\${escapeHtml(env.description || '')}</small></td>
                    <td>\${escapeHtml(env.adminHost || (env.connectionType === 'customUrl' ? 'Cloud Configured' : (env.connectionType === 'v12Tenant' ? 'v12 Tenant' : '')))}</td>
                    <td>\${env.port || ((env.connectionType === 'customUrl' || env.connectionType === 'v12Tenant') ? '-' : '')}</td>
                    <td>\${(env.connectionType === 'customUrl' || env.connectionType === 'v12Tenant') ? '✅' : (env.ssl ? '✅' : '❌')}</td>
                    <td>\${escapeHtml(env.folder)}</td>
                    <td>\${env.storeFilesLocally === false ? '❌ Off' : '✅ On'}</td>
                    <td>\${scopeLabel}</td>
                    <td class="actions-cell">
                        <button class="secondary" onclick="editEnvironment(\${index})">Edit</button>
                        <button class="danger" onclick="deleteEnvironment(\${index})">Delete</button>
                    </td>
                \`;
                tbody.appendChild(tr);
            });
        }

        window.editEnvironment = (index) => {
            const env = currentEnvironments[index];
            modalTitle.textContent = "Edit Environment";
            editIndex.value = index;
            inpName.value = env.name || "";
            inpDesc.value = env.description || "";
            inpConnectionType.value = env.connectionType || "onPremise";
            inpHost.value = env.adminHost || "";
            inpPort.value = env.port || 5898;
            inpSsl.checked = env.ssl !== false;
            inpRestUrl.value = env.restUrl || "";
            inpAuthMethod.value = env.authMethod || "Prompt";
            inpCamUrl.value = env.camUrl || "";
            inpNamespace.value = env.namespace || "";
            inpOAuthPawUrl.value = env.oauthPawUrl || "";
            inpOAuthClientId.value = env.oauthClientId || "";
            inpOAuthClientSecret.value = "";
            inpOAuthRedirectPort.value = env.oauthRedirectPort || 53173;
            inpOAuthDatabase.value = env.oauthDatabase || "";
            oauthSecretHint.innerText = "";
            if (env.authMethod === 'OAuth') {
                vscode.postMessage({ command: 'checkOAuthSecret', envName: env.name });
            }
            inpFolder.value = env.folder || "";
            inpTimeout.value = env.timeout || 15000;
            document.getElementById('inpStoreLocally').checked = env.storeFilesLocally !== false;
            document.getElementById('inpPullOnConnect').value = env.pullOnConnect || 'ask';
            syncFolderState();
            document.getElementById('inpScope').value = env.scope || defaultScope;

            if (env.connectionType === 'customUrl' || env.connectionType === 'v12Tenant') {
                onPremiseFields.style.display = 'none';
                cloudFields.style.display = 'block';
            } else if (env.connectionType === 'singleInstance') {
                onPremiseFields.style.display = 'block';
                cloudFields.style.display = 'none';
                lblHost.textContent = "TM1 Host / IP";
                lblPort.textContent = "HTTP Port (REST API)";
            } else {
                onPremiseFields.style.display = 'block';
                cloudFields.style.display = 'none';
                lblHost.textContent = "Admin Host";
                lblPort.textContent = "Port";
            }
            updateAuthHint();
            clearInvalid();
            modal.style.display = 'block';
        };

        window.deleteEnvironment = (index) => {
            const env = currentEnvironments[index];
            if (env) {
                vscode.postMessage({ command: 'confirmDelete', index: index, envName: env.name });
            }
        };

        function escapeHtml(unsafe) {
            return (unsafe||"").toString()
                 .replace(/&/g, "&amp;")
                 .replace(/</g, "&lt;")
                 .replace(/>/g, "&gt;")
                 .replace(/"/g, "&quot;")
                 .replace(/'/g, "&#039;");
        }
    </script>
</body>
</html>`;
    }
}

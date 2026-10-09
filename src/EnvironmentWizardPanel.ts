import * as vscode from 'vscode';
import { ConfigManager, TM1EnvironmentConfig } from './ConfigManager';
import { TM1Service } from './TM1Service';

/**
 * Step-by-step guided wizard for creating a new TM1 environment. Keeps the
 * questions in a sensible order, only asks what the chosen connection type
 * actually needs, and explains each option in plain language so non-technical
 * users can't mis-configure a connection. Saving reuses ConfigManager so the
 * scope routing (workspace / global / file) is identical to the classic editor.
 */
export class EnvironmentWizardPanel {
    public static current: EnvironmentWizardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _context: vscode.ExtensionContext,
        private readonly _onSaved?: () => void
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._html();

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case 'ready': {
                    const defaultScope = vscode.workspace.getConfiguration('pa-code').get<string>('connections.defaultScope', 'workspace');
                    const existingNames = (ConfigManager.getConfig().environments || []).map(e => e.name);
                    this._panel.webview.postMessage({ command: 'init', defaultScope, existingNames });
                    return;
                }
                case 'test': {
                    try {
                        const r = await TM1Service.getInstance().testConnection(msg.data || {});
                        this._panel.webview.postMessage({ command: 'testResult', ok: r.ok, message: r.message });
                    } catch (e: any) {
                        this._panel.webview.postMessage({ command: 'testResult', ok: false, message: e?.message || String(e) });
                    }
                    return;
                }
                case 'create': {
                    try {
                        const env = msg.env as TM1EnvironmentConfig;
                        if (env.authMethod === 'OAuth' && msg.secret) {
                            await this._context.secrets.store(`pa-code.oauth.secret.${env.name}`, msg.secret);
                        }
                        const cfg = ConfigManager.getConfig();
                        cfg.environments = [...(cfg.environments || []), env];
                        ConfigManager.saveConfig(cfg);
                        vscode.window.showInformationMessage(`Environment "${env.name}" created.`);
                        if (this._onSaved) this._onSaved();
                        this.dispose();
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to create environment: ${e?.message || e}`);
                    }
                    return;
                }
                case 'cancel':
                    this.dispose();
                    return;
            }
        }, null, this._disposables);
    }

    public static render(_extensionUri: vscode.Uri, context: vscode.ExtensionContext, onSaved?: () => void) {
        if (EnvironmentWizardPanel.current) {
            EnvironmentWizardPanel.current._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1EnvWizard', 'New TM1 Environment', vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        EnvironmentWizardPanel.current = new EnvironmentWizardPanel(panel, context, onSaved);
    }

    public dispose() {
        EnvironmentWizardPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    private _html(): string {
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  :root { --gap: 14px; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 0; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 20px 24px 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px; }
  .steps { display: flex; gap: 6px; margin-bottom: 20px; flex-wrap: wrap; }
  .steps .s { font-size: 11px; padding: 4px 9px; border-radius: 12px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); opacity: .5; }
  .steps .s.active { opacity: 1; outline: 1px solid var(--vscode-focusBorder); }
  .steps .s.done { opacity: .85; }
  .steps .s.clickable { cursor: pointer; }
  .steps .s.clickable:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .step { display: none; }
  .step.active { display: block; }
  .step h2 { font-size: 15px; margin: 0 0 4px; }
  .step .desc { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 0 0 16px; }
  label { display: block; font-size: 12px; font-weight: 600; margin: 12px 0 4px; }
  label .req { color: var(--vscode-charts-red, #f14c4c); }
  input[type=text], input[type=number], input[type=password], select { width: 100%; box-sizing: border-box; padding: 7px 9px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 4px; font-size: 13px; }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 4px; }
  .cards { display: grid; gap: 10px; }
  .card { border: 1px solid var(--vscode-widget-border, #444); border-radius: 8px; padding: 12px 14px; cursor: pointer; display: flex; gap: 10px; align-items: flex-start; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.sel { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); }
  .card .ic { font-size: 20px; line-height: 1; }
  .card .t { font-weight: 600; font-size: 13px; }
  .card .d { font-size: 11.5px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
  .toggle { display: grid; gap: 10px; }
  .row2 { display: grid; grid-template-columns: 1fr 160px; gap: 12px; }
  .chk { display: flex; align-items: center; gap: 8px; font-weight: 400; }
  .nav { display: flex; justify-content: space-between; margin-top: 24px; gap: 8px; }
  button { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.btn-test { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-focusBorder); font-weight: 600; }
  button.btn-test:hover { background: var(--vscode-list-hoverBackground); }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .err { color: var(--vscode-charts-red, #f14c4c); font-size: 12px; margin-top: 10px; min-height: 16px; }
  .summary { border: 1px solid var(--vscode-widget-border, #444); border-radius: 8px; padding: 12px 14px; font-size: 12.5px; }
  .summary div { display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid var(--vscode-widget-border, #333); }
  .summary div:last-child { border-bottom: none; }
  .summary .k { color: var(--vscode-descriptionForeground); }
  .test-result { margin-top: 12px; font-size: 12px; padding: 8px 10px; border-radius: 4px; display: none; }
  .test-result.ok { background: rgba(35,134,54,.18); } .test-result.err { background: rgba(248,81,73,.18); } .test-result.pending { background: var(--vscode-badge-background); }
  .callout { font-size: 11.5px; background: var(--vscode-textBlockQuote-background, rgba(255,255,255,.04)); border-left: 3px solid var(--vscode-focusBorder); padding: 8px 10px; border-radius: 0 4px 4px 0; margin-top: 6px; }
</style></head>
<body><div class="wrap">
  <h1>Create a new TM1 environment</h1>
  <div class="sub">A guided setup — we only ask for what your connection actually needs.</div>
  <div class="steps" id="steps"></div>

  <!-- STEP 1: connection type -->
  <div class="step active" data-step="type">
    <h2>What kind of TM1 are you connecting to?</h2>
    <p class="desc">This decides which details we need next. Not sure? "On-Premise — Admin Server" is the classic install.</p>
    <div class="cards" id="typeCards">
      <div class="card" data-type="onPremise"><div class="ic">🏢</div><div><div class="t">On-Premise — TM1 Admin Server</div><div class="d">Classic on-prem install. You point at a TM1 <b>Admin Server</b> (host + port) that lists the databases running on it.</div></div></div>
      <div class="card" data-type="singleInstance"><div class="ic">🎯</div><div><div class="t">On-Premise — Single Database (direct)</div><div class="d">Connect straight to one database's host and HTTP port, without going through an Admin Server.</div></div></div>
      <div class="card" data-type="customUrl"><div class="ic">☁️</div><div><div class="t">Cloud / Custom REST URL</div><div class="d">Planning Analytics on Cloud, or any TM1 reachable through a full REST API URL.</div></div></div>
      <div class="card" data-type="v12Tenant"><div class="ic">🚀</div><div><div class="t">Planning Analytics v12 (Tenant)</div><div class="d">PA Engine v12 / PA as a Service — a tenant reached via its REST URL.</div></div></div>
    </div>
  </div>

  <!-- STEP 2: basics -->
  <div class="step" data-step="basics">
    <h2>Name your environment</h2>
    <p class="desc">A short label you'll recognise in the tree, like <b>PROD</b>, <b>DEV</b> or <b>Finance Test</b>.</p>
    <label>Name <span class="req">*</span></label>
    <input type="text" id="name" placeholder="e.g. PROD">
    <div class="hint" id="nameHint"></div>
    <label>Description (optional)</label>
    <input type="text" id="desc" placeholder="e.g. Production planning database">
  </div>

  <!-- STEP 3: connection details -->
  <div class="step" data-step="conn">
    <h2>Connection details</h2>
    <p class="desc" id="connDesc"></p>
    <div id="fieldsAdmin">
      <div class="row2">
        <div><label id="lblHost">Admin Host <span class="req">*</span></label><input type="text" id="host" placeholder="e.g. tm1server.company.com"></div>
        <div><label id="lblPort">Port <span class="req">*</span></label><input type="number" id="port" value="5898"></div>
      </div>
      <label class="chk" style="margin-top:12px"><input type="checkbox" id="ssl" checked> Use SSL (https)</label>
      <div class="hint" id="hostHint"></div>
    </div>
    <div id="fieldsUrl" style="display:none">
      <label id="lblRestUrl">Base REST API URL <span class="req">*</span></label>
      <input type="text" id="restUrl" placeholder="https://host:port or PA Cloud URL">
      <div class="callout" id="urlHint"></div>
    </div>
    <div class="callout" id="connExamples" style="margin-top:14px"></div>
  </div>

  <!-- STEP 4: authentication -->
  <div class="step" data-step="auth">
    <h2>How do you sign in?</h2>
    <p class="desc">Only the methods that fit your connection type are shown.</p>
    <label>Authentication method</label>
    <select id="auth"></select>
    <div class="callout" id="authHint"></div>

    <div id="camBlock" style="display:none">
      <label>CAM Gateway URL (optional)</label>
      <input type="text" id="camUrl" placeholder="Leave blank to auto-detect">
      <label>CAM Namespace (optional)</label>
      <input type="text" id="namespace" placeholder="e.g. LDAP">
    </div>
    <div id="oauthBlock" style="display:none">
      <label>PAW Base URL <span class="req">*</span></label>
      <input type="text" id="pawUrl" placeholder="https://paw-host">
      <label>OAuth Client ID <span class="req">*</span></label>
      <input type="text" id="clientId" placeholder="your PAW OAuth client id">
      <label>OAuth Client Secret</label>
      <input type="password" id="clientSecret" placeholder="stored securely, never in the project file">
      <div class="row2">
        <div><label>Callback (redirect) port</label><input type="number" id="redirectPort" value="53173"></div>
        <div><label>Database (optional)</label><input type="text" id="oauthDb" placeholder="blank = discover"></div>
      </div>
      <div class="hint" id="callbackHint"></div>
    </div>
  </div>

  <!-- STEP 5: local files -->
  <div class="step" data-step="files">
    <h2>Keep local copies of your TI &amp; rules?</h2>
    <p class="desc">This controls whether PA Code writes process/rule files to disk for this environment.</p>
    <div class="cards">
      <div class="card" data-files="yes"><div class="ic">💾</div><div><div class="t">Yes — store files locally (recommended for DEV)</div><div class="d">Processes and rules are written as <b>.ti</b>/<b>.rux</b> files you can edit, diff and put under <b>Git</b>. Best for development and version control.</div></div></div>
      <div class="card" data-files="no"><div class="ic">👁️</div><div><div class="t">No — browse only (good for TEST/PROD)</div><div class="d">Nothing is written to disk. You can open, run and analyse objects, but edits are pushed straight to the server. Keeps a Dev repo clean.</div></div></div>
    </div>
    <div id="filesDetail" style="display:none; margin-top:16px">
      <label>Local folder name</label>
      <input type="text" id="folder" placeholder="e.g. PROD">
      <div class="hint">The subfolder in your workspace that holds this environment's files. In 99% of cases this is the same as the environment name — we've prefilled it for you.</div>
      <label style="margin-top:14px">After connecting…</label>
      <select id="pull">
        <option value="ask">Ask me whether to pull everything (default)</option>
        <option value="auto">Pull everything automatically</option>
        <option value="never">Never pull (I get files from Git)</option>
      </select>
      <div class="hint">"Pull" downloads all processes/rules from the server into your local folder.</div>
    </div>
    <div id="filesNoneNote" class="callout" style="display:none; margin-top:14px">No local folder or pull settings are needed — this connection never writes files.</div>
  </div>

  <!-- STEP 6: review -->
  <div class="step" data-step="review">
    <h2>Review &amp; create</h2>
    <p class="desc">Check the summary, optionally test the connection, then create.</p>
    <div class="summary" id="summary"></div>
    <label style="margin-top:14px">Where to store this connection</label>
    <select id="scope">
      <option value="workspace">This workspace only (recommended)</option>
      <option value="global">All my workspaces (global)</option>
    </select>
    <div class="hint">Workspace keeps the connection with this project; Global makes it available everywhere on your machine.</div>
    <button class="btn-test" id="testBtn" style="margin-top:16px">🔌 Test connection</button>
    <div class="test-result" id="testResult"></div>
  </div>

  <div class="err" id="err"></div>
  <div class="nav">
    <button class="secondary" id="backBtn">Back</button>
    <div style="display:flex; gap:8px">
      <button class="secondary" id="cancelBtn">Cancel</button>
      <button id="nextBtn">Next</button>
    </div>
  </div>
</div>

<script>
  var vscode = acquireVsCodeApi();
  var AUTH = {
    onPremise: [
      { v:'Prompt', t:'Auto-detect (recommended)', d:'PA Code checks the server security mode and asks for credentials or opens a browser login as needed.' },
      { v:'Basic', t:'Username & password', d:'You enter a TM1 user and password on connect. Add a CAM namespace below if your server uses one.' },
      { v:'CAM Browser SSO', t:'CAM / SSO (browser)', d:'Opens a browser window to log in via your SSO/MFA provider. Best for CAM-secured servers.' },
      { v:'Integrated Login', t:'Windows Integrated Login', d:'Kerberos SSO from your current Windows session (TM1 Security Mode 2/3) — no username/password, like Architect.' }
    ],
    singleInstance: [
      { v:'Prompt', t:'Auto-detect (recommended)', d:'PA Code checks the server security mode and asks for credentials or opens a browser login as needed.' },
      { v:'Basic', t:'Username & password', d:'You enter a TM1 user and password on connect.' },
      { v:'CAM Browser SSO', t:'CAM / SSO (browser)', d:'Opens a browser window to log in via your SSO/MFA provider.' },
      { v:'Integrated Login', t:'Windows Integrated Login', d:'Kerberos SSO from your current Windows session (no username/password).' }
    ],
    customUrl: [
      { v:'Basic', t:'Username & password', d:'You enter a user and password on connect.' },
      { v:'API Key', t:'API key', d:'The username is set to "apikey" automatically; you paste your API key as the password on connect. For PA as a Service the REST URL ends with /v0/tm1/<database>.' },
      { v:'IBM Cloud', t:'IBM Cloud (non-interactive)', d:'Fixed LDAP namespace and credentials for non-interactive cloud access.' },
      { v:'OAuth', t:'PAW OAuth 2.0', d:'Signs in to PAW via OAuth and connects to a PAW-routed TM1 database.' },
      { v:'CAM Browser SSO', t:'CAM / SSO (browser)', d:'Opens a browser window to log in via your SSO/MFA provider.' }
    ],
    v12Tenant: [
      { v:'OAuth', t:'PAW OAuth 2.0 (recommended)', d:'Signs in via OAuth and connects to the v12 tenant.' },
      { v:'API Key', t:'API key', d:'Paste your API key as the password on connect.' }
    ]
  };

  var state = { step: 0, maxReached: 0, type: '', files: '', defaultScope: 'workspace', existingNames: [] };
  var ORDER = ['type','basics','conn','auth','files','review'];
  var STEP_LABELS = { type:'Type', basics:'Name', conn:'Details', auth:'Sign in', files:'Files', review:'Review' };
  var $ = function(id){ return document.getElementById(id); };

  function renderSteps(){
    var el = $('steps'); el.innerHTML = '';
    ORDER.forEach(function(k, i){
      var s = document.createElement('span');
      var reachable = i <= state.maxReached;
      s.className = 's' + (i === state.step ? ' active' : (i < state.step ? ' done' : '')) + (reachable ? ' clickable' : '');
      s.textContent = (i+1) + '. ' + STEP_LABELS[k];
      if (reachable) s.addEventListener('click', function(){ if (i !== state.step) { state.step = i; showStep(); } });
      el.appendChild(s);
    });
  }
  function showStep(){
    if (state.step > state.maxReached) state.maxReached = state.step;
    var key = ORDER[state.step];
    document.querySelectorAll('.step').forEach(function(d){ d.classList.toggle('active', d.getAttribute('data-step') === key); });
    $('backBtn').style.visibility = state.step === 0 ? 'hidden' : 'visible';
    $('nextBtn').textContent = state.step === ORDER.length - 1 ? 'Create environment' : 'Next';
    $('err').textContent = '';
    renderSteps();
    if (key === 'conn') prepConn();
    if (key === 'auth') prepAuth();
    if (key === 'review') prepReview();
  }

  // ---- Step 1: type cards ----
  document.querySelectorAll('#typeCards .card').forEach(function(c){
    c.addEventListener('click', function(){
      state.type = c.getAttribute('data-type');
      document.querySelectorAll('#typeCards .card').forEach(function(x){ x.classList.toggle('sel', x === c); });
    });
  });

  // ---- Step 2: name -> folder suggestion ----
  $('name').addEventListener('input', function(){
    var n = $('name').value.trim();
    var taken = state.existingNames.map(function(s){ return s.toLowerCase(); }).indexOf(n.toLowerCase()) >= 0;
    $('nameHint').textContent = taken ? '⚠ A connection with this name already exists.' : '';
    $('nameHint').style.color = taken ? 'var(--vscode-charts-red,#f14c4c)' : '';
    if (!$('folder').dataset.touched) $('folder').value = n;
  });
  $('folder') && $('folder').addEventListener('input', function(){ $('folder').dataset.touched = '1'; });

  // ---- Step 3: connection ----
  function prepConn(){
    var isUrl = (state.type === 'customUrl' || state.type === 'v12Tenant');
    $('fieldsAdmin').style.display = isUrl ? 'none' : 'block';
    $('fieldsUrl').style.display = isUrl ? 'block' : 'none';
    if (state.type === 'onPremise') {
      $('connDesc').textContent = 'Point at your TM1 Admin Server. PA Code lists the databases it manages.';
      $('lblHost').innerHTML = 'Admin Host <span class="req">*</span>';
      $('lblPort').innerHTML = 'Port <span class="req">*</span>';
      $('hostHint').textContent = 'The Admin Server host and its port (default 5898).';
      if (!$('port').dataset.touched) $('port').value = '5898';
    } else if (state.type === 'singleInstance') {
      $('connDesc').textContent = 'Connect directly to one database using its host and HTTP (REST) port.';
      $('lblHost').innerHTML = 'TM1 Host / IP <span class="req">*</span>';
      $('lblPort').innerHTML = 'HTTP Port (REST API) <span class="req">*</span>';
      $('hostHint').textContent = 'Use the database\\'s HTTP port from its tm1s.cfg (HTTPPortNumber).';
    } else if (state.type === 'customUrl') {
      $('urlHint').innerHTML = 'The full REST base URL. For PA as a Service it typically ends with <b>/api/v1</b> (or /v0/tm1/&lt;database&gt; for API-key access).';
    } else {
      $('urlHint').innerHTML = 'The v12 tenant REST URL provided by IBM for your Planning Analytics environment.';
    }
    var ex = {
      onPremise: '<b>Example</b><br>Admin Host: <code>tm1.company.com</code> · Port: <code>5898</code> · SSL: on',
      singleInstance: '<b>Example</b><br>Host: <code>tm1.company.com</code> · HTTP Port: <code>8010</code> (the database\\'s <code>HTTPPortNumber</code> from tm1s.cfg)',
      customUrl: '<b>Examples</b><br>On-prem via URL: <code>https://tm1.company.com:8010/api/v1</code><br>PA as a Service (API key): <code>https://&lt;region&gt;.planninganalytics.saas.ibm.com/api/&lt;tenant&gt;/v0/tm1/&lt;database&gt;</code>',
      v12Tenant: '<b>Example</b><br><code>https://&lt;tenant&gt;.&lt;region&gt;.planninganalytics.ibm.com/api/v1</code>'
    };
    $('connExamples').innerHTML = ex[state.type] || '';
  }
  $('port').addEventListener('input', function(){ $('port').dataset.touched = '1'; });

  // ---- Step 4: auth ----
  function prepAuth(){
    var list = AUTH[state.type] || [];
    var sel = $('auth');
    var prev = sel.value;
    sel.innerHTML = '';
    list.forEach(function(a){ var o = document.createElement('option'); o.value = a.v; o.textContent = a.t; sel.appendChild(o); });
    if (list.map(function(a){return a.v;}).indexOf(prev) >= 0) sel.value = prev;
    authChanged();
  }
  function authChanged(){
    var list = AUTH[state.type] || [];
    var cur = list.filter(function(a){ return a.v === $('auth').value; })[0];
    $('authHint').textContent = cur ? cur.d : '';
    var v = $('auth').value;
    $('camBlock').style.display = (v === 'CAM Browser SSO') ? 'block' : 'none';
    $('oauthBlock').style.display = (v === 'OAuth') ? 'block' : 'none';
    if (v === 'OAuth') updateCallback();
  }
  $('auth').addEventListener('change', authChanged);
  function updateCallback(){ $('callbackHint').textContent = 'Register this callback URL in your PAW OAuth client: http://127.0.0.1:' + (($('redirectPort').value||'53173').trim()) + '/callback'; }
  $('redirectPort').addEventListener('input', updateCallback);

  // ---- Step 5: files ----
  document.querySelectorAll('[data-files]').forEach(function(c){
    c.addEventListener('click', function(){
      state.files = c.getAttribute('data-files');
      document.querySelectorAll('[data-files]').forEach(function(x){ x.classList.toggle('sel', x === c); });
      var yes = state.files === 'yes';
      $('filesDetail').style.display = yes ? 'block' : 'none';
      $('filesNoneNote').style.display = yes ? 'none' : 'block';
      if (yes && !$('folder').dataset.touched) $('folder').value = $('name').value.trim();
    });
  });

  // ---- Step 6: review ----
  function prepReview(){
    $('scope').value = state.defaultScope === 'global' ? 'global' : 'workspace';
    var rows = [];
    var typeLabel = { onPremise:'On-Premise (Admin Server)', singleInstance:'On-Premise (Single Database)', customUrl:'Cloud / Custom URL', v12Tenant:'PA v12 Tenant' }[state.type] || state.type;
    rows.push(['Name', $('name').value.trim()]);
    rows.push(['Type', typeLabel]);
    if (state.type === 'customUrl' || state.type === 'v12Tenant') rows.push(['REST URL', $('restUrl').value.trim()]);
    else { rows.push(['Host', $('host').value.trim()]); rows.push(['Port', $('port').value.trim()]); rows.push(['SSL', $('ssl').checked ? 'Yes' : 'No']); }
    rows.push(['Sign in', $('auth').value]);
    rows.push(['Store files locally', state.files === 'yes' ? 'Yes' : 'No']);
    if (state.files === 'yes') { rows.push(['Folder', $('folder').value.trim()]); rows.push(['On connect', $('pull').value]); }
    $('summary').innerHTML = rows.map(function(r){ return '<div><span class="k">' + r[0] + '</span><span>' + escapeHtml(r[1]||'') + '</span></div>'; }).join('');
  }

  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }

  // ---- validation per step ----
  function validate(){
    var k = ORDER[state.step];
    if (k === 'type') { if (!state.type) return 'Please choose a connection type.'; }
    if (k === 'basics') {
      var n = $('name').value.trim();
      if (!n) return 'Please enter a name.';
      if (state.existingNames.map(function(s){return s.toLowerCase();}).indexOf(n.toLowerCase()) >= 0) return 'A connection with this name already exists.';
    }
    if (k === 'conn') {
      if (state.type === 'customUrl' || state.type === 'v12Tenant') { if (!$('restUrl').value.trim()) return 'Please enter the REST API URL.'; }
      else { if (!$('host').value.trim()) return 'Please enter the host.'; if (!$('port').value.trim()) return 'Please enter the port.'; }
    }
    if (k === 'auth') {
      if ($('auth').value === 'OAuth') { if (!$('pawUrl').value.trim()) return 'Please enter the PAW Base URL.'; if (!$('clientId').value.trim()) return 'Please enter the OAuth Client ID.'; }
    }
    if (k === 'files') { if (!state.files) return 'Please choose whether to store files locally.'; if (state.files === 'yes' && !$('folder').value.trim()) return 'Please enter a folder name.'; }
    return '';
  }

  function buildEnv(){
    var isUrl = (state.type === 'customUrl' || state.type === 'v12Tenant');
    var storeLocally = state.files === 'yes';
    var env = {
      name: $('name').value.trim(),
      description: $('desc').value.trim(),
      connectionType: state.type,
      authMethod: $('auth').value,
      storeFilesLocally: storeLocally,
      folder: storeLocally ? $('folder').value.trim() : $('name').value.trim(),
      scope: $('scope').value,
      timeout: 15000
    };
    if (isUrl) { env.restUrl = $('restUrl').value.trim(); }
    else { env.adminHost = $('host').value.trim(); env.port = parseInt($('port').value.trim(), 10) || 5898; env.ssl = $('ssl').checked; }
    if (storeLocally) env.pullOnConnect = $('pull').value;
    if ($('auth').value === 'CAM Browser SSO') { env.camUrl = $('camUrl').value.trim(); env.namespace = $('namespace').value.trim(); }
    if ($('auth').value === 'OAuth') {
      env.oauthPawUrl = $('pawUrl').value.trim();
      env.oauthClientId = $('clientId').value.trim();
      env.oauthRedirectPort = parseInt($('redirectPort').value.trim(), 10) || 53173;
      env.oauthDatabase = $('oauthDb').value.trim();
    }
    return env;
  }

  $('nextBtn').addEventListener('click', function(){
    var e = validate();
    if (e) { $('err').textContent = e; return; }
    if (state.step === ORDER.length - 1) {
      var env = buildEnv();
      var secret = ($('auth').value === 'OAuth') ? $('clientSecret').value : '';
      vscode.postMessage({ command: 'create', env: env, secret: secret });
      return;
    }
    state.step++; showStep();
  });
  $('backBtn').addEventListener('click', function(){ if (state.step > 0) { state.step--; showStep(); } });
  $('cancelBtn').addEventListener('click', function(){ vscode.postMessage({ command: 'cancel' }); });

  $('testBtn').addEventListener('click', function(){
    var data = {
      connectionType: state.type, authMethod: $('auth').value,
      host: $('host').value.trim(), port: parseInt($('port').value.trim(), 10) || undefined, ssl: $('ssl').checked,
      restUrl: $('restUrl').value.trim(), oauthPawUrl: $('pawUrl').value.trim(), timeoutMs: 15000
    };
    var el = $('testResult'); el.style.display = 'block'; el.className = 'test-result pending'; el.textContent = '⏳ Testing connection…';
    vscode.postMessage({ command: 'test', data: data });
  });

  window.addEventListener('message', function(ev){
    var m = ev.data;
    if (m.command === 'init') { state.defaultScope = m.defaultScope || 'workspace'; state.existingNames = m.existingNames || []; }
    else if (m.command === 'testResult') {
      var el = $('testResult'); el.style.display = 'block'; el.className = 'test-result ' + (m.ok ? 'ok' : 'err'); el.textContent = (m.ok ? '✅ ' : '❌ ') + m.message;
    }
  });

  renderSteps(); showStep();
  vscode.postMessage({ command: 'ready' });
</script>
</body></html>`;
    }
}

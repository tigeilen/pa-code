import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';
import { TM1_FUNCTION_DATABASE } from './TM1FunctionDatabase';

/**
 * TI Console — an Arc-style one-liner console. Type a TurboIntegrator statement
 * (e.g. `CubeProcessFeeders('Balancesheet');`), Run it, and the extension
 * creates a temporary process behind the scenes, executes it and deletes it —
 * so you never have to create a throwaway TI yourself.
 */
export class TIConsolePanel {
    private static panels: Map<string, TIConsolePanel> = new Map();
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

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command !== 'run') { return; }
            const code = String(msg.code || '').trim();
            if (!code) { return; }
            try {
                const r = await TM1Service.getInstance().executeTiCode(this._instanceName, code);
                const ok = r.status === 'CompletedSuccessfully';
                this._panel.webview.postMessage({ command: 'result', id: msg.id, ok, status: r.status, errorLog: r.errorLog || '' });
            } catch (e: any) {
                // Compile/syntax errors surface here (updateProcessCode throws).
                this._panel.webview.postMessage({ command: 'result', id: msg.id, ok: false, status: 'Error', errorLog: e?.message || String(e) });
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string, serverRealName: string): void {
        const existing = TIConsolePanel.panels.get(instanceName);
        if (existing) { existing._panel.reveal(vscode.ViewColumn.One); return; }
        const panel = vscode.window.createWebviewPanel(
            'tm1TIConsole', `TI Console: ${serverRealName}`, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        TIConsolePanel.panels.set(instanceName, new TIConsolePanel(panel, instanceName, serverRealName));
    }

    /** Closes any TI Console bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string): void {
        const p = TIConsolePanel.panels.get(instanceName);
        if (p) { p._panel.dispose(); }
    }

    private dispose(): void {
        TIConsolePanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) { d.dispose(); } }
    }

    private _getWebviewContent(): string {
        // TI-relevant functions for the console autocomplete (name + syntax + description).
        const seen = new Set<string>();
        const fnList = TM1_FUNCTION_DATABASE
            .flatMap(c => c.functions)
            .filter(f => (f.context === 'ti' || f.context === 'both') && !seen.has(f.name) && seen.add(f.name))
            .map(f => ({ n: f.name, s: f.syntax, d: f.description }));
        const fnJson = JSON.stringify(fnList);
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; display: flex; flex-direction: column; height: 100vh; }
  .bar { padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border, #333); font-size: 12px; color: var(--vscode-descriptionForeground); }
  .out { flex: 1; overflow: auto; padding: 8px 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
  .entry { border-bottom: 1px solid rgba(127,127,127,0.12); padding: 6px 0; white-space: pre-wrap; word-break: break-word; }
  .cmd { color: var(--vscode-charts-blue, #4aa8ff); }
  .cmd::before { content: '> '; opacity: .6; }
  .ok { color: var(--vscode-charts-green, #4ec9b0); }
  .err { color: var(--vscode-errorForeground, #f14c4c); }
  .composer { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border, #333); align-items: flex-end; position: relative; }
  textarea { flex: 1; resize: none; height: 56px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #333); border-radius: 4px; padding: 8px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 4px; padding: 8px 14px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
  .hint { padding: 3px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
  .hint:empty { display: none; }
  .ac { position: absolute; left: 12px; right: 120px; bottom: 100%; margin-bottom: 4px; max-height: 260px; overflow: auto; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--vscode-panel-border, #333); border-radius: 6px; box-shadow: 0 -2px 10px rgba(0,0,0,0.4); display: none; z-index: 10; }
  .ac.open { display: block; }
  .ac-item { padding: 4px 8px; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ac-item.sel { background: var(--vscode-list-activeSelectionBackground, #094771); color: var(--vscode-list-activeSelectionForeground, #fff); }
  .ac-name { font-weight: 600; }
  .ac-syn { opacity: .7; margin-left: 6px; }
</style></head>
<body>
  <div class="bar">One-liner TI console — type a TurboIntegrator statement and Run (Ctrl+Enter). Autocomplete: start typing a function name, use ↑/↓ and Enter/Tab. A temporary process is created, executed and deleted automatically. Example: <code>CubeProcessFeeders('Balancesheet');</code></div>
  <div class="hint" id="hint"></div>
  <div class="out" id="out"></div>
  <div class="composer">
    <div class="ac" id="ac"></div>
    <textarea id="inp" placeholder="e.g. CubeProcessFeeders('Balancesheet');" spellcheck="false"></textarea>
    <button class="secondary" id="clear" title="Clear output">Clear</button>
    <button id="run">Run</button>
  </div>
<script>
const vscode = acquireVsCodeApi();
const out = document.getElementById('out'), inp = document.getElementById('inp'), runBtn = document.getElementById('run');
const ac = document.getElementById('ac'), hint = document.getElementById('hint');
const FUNCS = ${fnJson};
let acItems = [], acSel = -1;
let seq = 0; const pending = {};
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function add(html){ const d = document.createElement('div'); d.className = 'entry'; d.innerHTML = html; out.appendChild(d); out.scrollTop = out.scrollHeight; return d; }
function currentWord(){
  const pos = inp.selectionStart;
  const before = inp.value.slice(0, pos);
  const m = before.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  return m ? { word: m[0], start: pos - m[0].length, end: pos } : null;
}
function updateHint(){ const f = acItems[acSel]; hint.textContent = f ? (f.s + '  — ' + f.d) : ''; }
function renderAc(){
  ac.innerHTML = acItems.map(function(f,i){ return '<div class="ac-item'+(i===acSel?' sel':'')+'" data-i="'+i+'"><span class="ac-name">'+esc(f.n)+'</span><span class="ac-syn">'+esc(f.s)+'</span></div>'; }).join('');
  updateHint();
  const sel = ac.querySelector('.ac-item.sel'); if(sel){ sel.scrollIntoView({block:'nearest'}); }
}
function showAc(){
  const cw = currentWord();
  if(!cw || cw.word.length < 1){ hideAc(); return; }
  const q = cw.word.toLowerCase();
  const starts = FUNCS.filter(function(f){ return f.n.toLowerCase().indexOf(q) === 0; });
  const contains = FUNCS.filter(function(f){ return f.n.toLowerCase().indexOf(q) > 0; });
  acItems = starts.concat(contains).slice(0, 50);
  if(acItems.length === 0){ hideAc(); return; }
  acSel = 0; renderAc(); ac.classList.add('open');
}
function hideAc(){ ac.classList.remove('open'); acItems = []; acSel = -1; hint.textContent = ''; }
function acceptAc(){
  const f = acItems[acSel]; if(!f){ return; }
  const cw = currentWord(); if(!cw){ return; }
  const hasParams = /\\([^)]*[A-Za-z]/.test(f.s);
  const insert = f.n + (hasParams ? '(' : (/\\(\\s*\\)/.test(f.s) ? '()' : ''));
  const before = inp.value.slice(0, cw.start);
  const after = inp.value.slice(cw.end);
  inp.value = before + insert + after;
  const caret = (before + insert).length;
  inp.setSelectionRange(caret, caret);
  hideAc(); inp.focus();
}
function run(){
  const code = inp.value.trim(); if(!code){ return; }
  hideAc();
  const id = ++seq;
  const el = add('<div class="cmd">' + esc(code) + '</div><div class="pending" style="opacity:.6;">running…</div>');
  pending[id] = el;
  runBtn.disabled = true;
  vscode.postMessage({ command: 'run', id: id, code: code });
  inp.value = '';
}
runBtn.addEventListener('click', run);
document.getElementById('clear').addEventListener('click', () => { out.innerHTML = ''; });
inp.addEventListener('input', showAc);
inp.addEventListener('blur', () => setTimeout(hideAc, 120));
ac.addEventListener('mousedown', e => { const it = e.target.closest('.ac-item'); if(it){ e.preventDefault(); acSel = parseInt(it.getAttribute('data-i'),10); acceptAc(); } });
inp.addEventListener('keydown', e => {
  if(ac.classList.contains('open')){
    if(e.key === 'ArrowDown'){ e.preventDefault(); acSel = (acSel + 1) % acItems.length; renderAc(); return; }
    if(e.key === 'ArrowUp'){ e.preventDefault(); acSel = (acSel - 1 + acItems.length) % acItems.length; renderAc(); return; }
    if(e.key === 'Tab'){ e.preventDefault(); acceptAc(); return; }
    if(e.key === 'Enter' && !e.ctrlKey && !e.metaKey){ e.preventDefault(); acceptAc(); return; }
    if(e.key === 'Escape'){ e.preventDefault(); hideAc(); return; }
  }
  if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); run(); }
});
window.addEventListener('message', ev => {
  const m = ev.data; if(m.command !== 'result'){ return; }
  runBtn.disabled = false;
  const el = pending[m.id]; if(!el){ return; } delete pending[m.id];
  const p = el.querySelector('.pending'); if(p){ p.remove(); }
  if(m.ok){ el.innerHTML += '<div class="ok">✓ ' + esc(m.status) + '</div>'; }
  else { el.innerHTML += '<div class="err">✗ ' + esc(m.status) + (m.errorLog ? ('\\n' + esc(m.errorLog)) : '') + '</div>'; }
  out.scrollTop = out.scrollHeight;
});
inp.focus();
</script>
</body></html>`;
    }
}

import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

/**
 * Rich TM1 message-log viewer: full-text search, Level & Logger filters,
 * a time range, live tail and export of the filtered result. Reads the same
 * `MessageLogEntries` REST feed that PAW's message log uses, but with the
 * searching/filtering PAW lacks.
 */
export class LogViewerPanel {
    private static panels: Map<string, LogViewerPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private _pollTimer?: NodeJS.Timeout;

    private constructor(panel: vscode.WebviewPanel, instanceName: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtml();

        this._panel.webview.onDidReceiveMessage(async msg => {
            const tm1 = TM1Service.getInstance();
            try {
                switch (msg.command) {
                    case 'load': {
                        // msg.sinceIso optional; otherwise latest N
                        const entries = msg.sinceIso
                            ? await tm1.getMessageLogEntriesWindow(this._instanceName, msg.sinceIso, msg.top || 20000)
                            : (await tm1.getMessageLogEntries(this._instanceName, msg.top || 2000));
                        this._post('entries', { entries, mode: 'replace' });
                        break;
                    }
                    case 'older': {
                        if (!msg.before) { break; }
                        const entries = await tm1.getMessageLogEntriesBefore(this._instanceName, msg.before, msg.top || 1000);
                        this._post('entries', { entries, mode: 'prepend' });
                        break;
                    }
                    case 'since': {
                        if (!msg.after) { break; }
                        const entries = await tm1.getMessageLogEntriesSince(this._instanceName, msg.after);
                        if (entries.length) { this._post('entries', { entries, mode: 'append' }); }
                        break;
                    }
                    case 'export': {
                        const now = new Date();
                        const pad = (n: number) => String(n).padStart(2, '0');
                        const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
                        const safe = (s: string) => String(s).replace(/[^\w.-]+/g, '_');
                        const loggers: string[] = Array.isArray(msg.loggers) ? msg.loggers : [];
                        const loggerPart = loggers.length ? '_' + loggers.slice(0, 3).map(safe).join('-') + (loggers.length > 3 ? '-etc' : '') : '';
                        const fileName = `${safe(this._instanceName)}_messagelog_${ts}${loggerPart}.log`;
                        const uri = await vscode.window.showSaveDialog({
                            filters: { 'Log file': ['log', 'txt'] },
                            saveLabel: 'Export filtered log',
                            defaultUri: vscode.Uri.file(fileName)
                        });
                        if (uri) {
                            await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.text || '', 'utf8'));
                            vscode.window.showInformationMessage(`Exported ${msg.count || 0} log lines to ${uri.fsPath}`);
                        }
                        break;
                    }
                }
            } catch (err: any) {
                this._post('error', { message: err.message });
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string, title?: string) {
        const existing = LogViewerPanel.panels.get(instanceName);
        if (existing) { existing._panel.reveal(vscode.ViewColumn.One); return; }
        const panel = vscode.window.createWebviewPanel(
            'tm1LogViewer', `Server Log — ${title || instanceName}`, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        LogViewerPanel.panels.set(instanceName, new LogViewerPanel(panel, instanceName));
    }

    /** Closes the log viewer bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string) {
        const p = LogViewerPanel.panels.get(instanceName);
        if (p) { p._panel.dispose(); }
    }

    private dispose() {
        if (this._pollTimer) { clearInterval(this._pollTimer); }
        LogViewerPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) { d.dispose(); } }
    }

    private _post(command: string, data: any) { this._panel.webview.postMessage({ command, ...data }); }

    private _getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';"><style>
:root {
    --bg: var(--vscode-editor-background); --fg: var(--vscode-foreground);
    --input-bg: var(--vscode-input-background); --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #444); --border: var(--vscode-panel-border, #333);
    --accent: var(--vscode-focusBorder, #007acc); --desc: var(--vscode-descriptionForeground, #999);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
}
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); margin: 0; height: 100vh; overflow: hidden; }
.app { display: flex; flex-direction: column; height: 100vh; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.toolbar input[type=text], .toolbar select { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 3px; padding: 4px 8px; font-size: 13px; }
#search { min-width: 240px; flex: 1; }
.levels { display: inline-flex; gap: 8px; align-items: center; }
.levels label { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; cursor: pointer; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #ccc); }
button.active { outline: 2px solid var(--accent); }
.count { color: var(--desc); font-size: 12px; }
.ms { position: relative; display: inline-block; }
.ms-menu { position: absolute; top: 100%; left: 0; z-index: 20; display: none; background: var(--vscode-editorWidget-background, #252526); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; min-width: 120px; box-shadow: 0 2px 8px rgba(0,0,0,0.4); }
.ms-menu.open { display: block; }
.ms-menu label { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 2px; cursor: pointer; }
.livechk { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
.log { flex: 1; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.log-head { flex-shrink: 0; font-weight: 600; color: var(--desc); border-bottom: 1px solid var(--border); }
.row { display: grid; grid-template-columns: 150px 66px 64px 150px 1fr; gap: 8px; padding: 2px 12px; border-bottom: 1px solid rgba(127,127,127,0.08); white-space: pre-wrap; word-break: break-word; }
.row:hover { background: var(--hover); }
.row .ts { color: var(--desc); }
.row .thread { color: var(--vscode-charts-purple, #b180d7); }
.lvl-FATAL .lvl, .lvl-FATAL .msg { color: #ff3b3b; font-weight: 600; }
.lvl-ERROR .lvl, .lvl-ERROR .msg { color: #f14c4c; }
.lvl-WARNING .lvl, .lvl-WARNING .msg { color: #cca700; }
.lvl-INFO .lvl { color: #3794ff; }
.lvl-DEBUG .lvl, .lvl-DEBUG .msg { color: var(--desc); }
.logger { color: #4ec9b0; }
mark { background: var(--vscode-editor-findMatchHighlightBackground, #ea5c0055); color: inherit; }
.status { padding: 4px 12px; font-size: 11px; color: var(--desc); border-top: 1px solid var(--border); flex-shrink: 0; }
</style></head><body>
<div class="app">
    <div class="toolbar">
        <input type="text" id="search" placeholder="Search message…">
        <div class="ms" id="levelMs">
            <button type="button" class="secondary" id="levelBtn" title="Filter by log level">Levels (4) ▾</button>
            <div class="ms-menu" id="levelMenu">
                <label><input type="checkbox" class="lv" value="FATAL" checked> Fatal</label>
                <label><input type="checkbox" class="lv" value="ERROR" checked> Error</label>
                <label><input type="checkbox" class="lv" value="WARNING" checked> Warn</label>
                <label><input type="checkbox" class="lv" value="INFO" checked> Info</label>
                <label><input type="checkbox" class="lv" value="DEBUG"> Debug</label>
            </div>
        </div>
        <div class="ms" id="loggerMs">
            <button type="button" class="secondary" id="loggerBtn" title="Filter by logger">All loggers ▾</button>
            <div class="ms-menu" id="loggerMenu" style="max-height:320px; overflow:auto; min-width:240px;">
                <input type="text" id="loggerFilter" placeholder="Filter loggers…" style="width:100%; background:var(--input-bg); color:var(--input-fg); border:1px solid var(--input-border); border-radius:3px; padding:3px 6px; font-size:12px;">
                <div style="display:flex; gap:6px; margin:6px 0;">
                    <button type="button" class="secondary" id="loggerSelShown" style="font-size:11px; padding:2px 6px;">Select shown</button>
                    <button type="button" class="secondary" id="loggerClear" style="font-size:11px; padding:2px 6px;">Clear</button>
                </div>
                <div id="loggerList"></div>
            </div>
        </div>
        <select id="range" title="Time range">
            <option value="0">Latest 2000</option>
            <option value="0.0104">Last 15 min</option>
            <option value="0.0417">Last 1 hour</option>
            <option value="0.25">Last 6 hours</option>
            <option value="1">Last 24 hours</option>
            <option value="3">Last 3 days</option>
            <option value="7">Last 7 days</option>
        </select>
        <button class="secondary" id="olderBtn" title="Load 1000 older entries">↑ Older</button>
        <label class="livechk" title="Auto-refresh every 5 seconds"><input type="checkbox" id="liveChk" checked> Live</label>
        <button class="secondary" id="refreshBtn">Refresh</button>
        <button id="exportBtn" title="Export the filtered lines">Export</button>
        <span class="count" id="count"></span>
    </div>
    <div class="log-head row"><span>Timestamp</span><span>Thread</span><span>Level</span><span>Logger</span><span>Message</span></div>
    <div class="log" id="log"></div>
    <div class="status" id="status">Loading…</div>
</div>
<script>
${this._script()}
</script>
</body></html>`;
    }

    private _script(): string {
        return /* js */ `
const vscode = acquireVsCodeApi();
let ALL = [];           // all loaded entries (ascending by time)
let live = true, liveTimer = null;
let selectedLoggers = new Set();   // empty = all loggers
const $ = id => document.getElementById(id);
function norm(l){ return String(l||'').toUpperCase(); }
function esc(s){ return String(s==null?'':s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function fmtTs(t){ t = String(t==null?'':t); const dot = t.indexOf('.'); if(dot>0){ t = t.slice(0,dot); } return t.replace('T',' ').replace('Z',''); }
function threadOf(e){ const v = (e.Thread!=null) ? e.Thread : ((e.ThreadID!=null) ? e.ThreadID : (e.ThreadId!=null ? e.ThreadId : '')); return v===''?'':String(v); }
function keyOf(e){ return (e.TimeStamp||'')+'|'+(e.Logger||'')+'|'+(e.Message||''); }

function mergeEntries(entries, mode){
    if(mode==='replace'){ ALL = entries.slice(); }
    else if(mode==='prepend'){ const seen=new Set(ALL.map(keyOf)); ALL = entries.filter(e=>!seen.has(keyOf(e))).concat(ALL); }
    else if(mode==='append'){ const seen=new Set(ALL.map(keyOf)); ALL = ALL.concat(entries.filter(e=>!seen.has(keyOf(e)))); }
    ALL.sort((a,b)=> String(a.TimeStamp).localeCompare(String(b.TimeStamp)));
    refreshLoggers();
    render();
}
function renderLoggerList(){
    const listEl = $('loggerList'); if(!listEl){ return; }
    const filterVal = ($('loggerFilter').value||'').toLowerCase();
    const set = new Set(); for(const e of ALL){ if(e.Logger){ set.add(e.Logger); } }
    for(const n of Array.from(selectedLoggers)){ if(!set.has(n)){ selectedLoggers.delete(n); } }
    const names = Array.from(set).sort().filter(n=>n.toLowerCase().indexOf(filterVal)>=0);
    listEl.innerHTML = names.length ? names.map(n=>'<label><input type="checkbox" class="lg" value="'+esc(n)+'"'+(selectedLoggers.has(n)?' checked':'')+'> '+esc(n)+'</label>').join('') : '<div style="opacity:.6; font-size:12px; padding:4px;">No loggers.</div>';
}
function refreshLoggers(){ renderLoggerList(); updateLoggerBtn(); }
function updateLoggerBtn(){ const b=$('loggerBtn'); if(b){ b.textContent = (selectedLoggers.size ? ('Loggers ('+selectedLoggers.size+')') : 'All loggers') + ' \u25be'; } }
function activeLevels(){ const s=new Set(); document.querySelectorAll('.lv:checked').forEach(c=>s.add(c.value)); return s; }
function filtered(){
    const q = $('search').value.trim().toLowerCase();
    const levels = activeLevels();
    return ALL.filter(e=>{
        if(levels.size && !levels.has(norm(e.Level))){ return false; }
        if(selectedLoggers.size && !selectedLoggers.has(e.Logger)){ return false; }
        if(q && String(e.Message||'').toLowerCase().indexOf(q)<0 && String(e.Logger||'').toLowerCase().indexOf(q)<0 && threadOf(e).toLowerCase().indexOf(q)<0){ return false; }
        return true;
    });
}
function highlight(text, q){ const s=esc(text); if(!q){ return s; } const i=s.toLowerCase().indexOf(q); if(i<0){ return s; } return s.slice(0,i)+'<mark>'+s.slice(i,i+q.length)+'</mark>'+s.slice(i+q.length); }
function render(){
    const q = $('search').value.trim().toLowerCase();
    const rows = filtered();
    const log = $('log');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 40;
    log.innerHTML = rows.map(e=>{
        const lvl = norm(e.Level);
        return '<div class="row lvl-'+esc(lvl)+'"><span class="ts">'+esc(fmtTs(e.TimeStamp))+'</span>'
            + '<span class="thread">'+esc(threadOf(e))+'</span>'
            + '<span class="lvl">'+esc(e.Level||'')+'</span>'
            + '<span class="logger">'+esc(e.Logger||'')+'</span>'
            + '<span class="msg">'+highlight(e.Message||'', q)+'</span></div>';
    }).join('');
    $('count').textContent = rows.length + ' / ' + ALL.length + ' lines';
    if(atBottom){ log.scrollTop = log.scrollHeight; }
}
function exportText(){
    const rows = filtered();
    const text = rows.map(e=>'['+fmtTs(e.TimeStamp)+'] '+(threadOf(e)?('['+threadOf(e)+'] '):'')+(e.Level||'')+' '+(e.Logger||'')+' '+(e.Message||'')).join('\\n');
    vscode.postMessage({ command:'export', text, count: rows.length, loggers: Array.from(selectedLoggers) });
}
function doLoad(){
    const days = parseFloat($('range').value)||0;
    $('status').textContent = 'Loading…';
    if(days>0){ const since = new Date(Date.now()-days*86400000).toISOString(); vscode.postMessage({ command:'load', sinceIso: since }); }
    else { vscode.postMessage({ command:'load', top: 2000 }); }
}
function toggleLive(){
    live = !live;
    if(live){ startLive(); } else { stopLive(); }
}
function startLive(){ if(liveTimer){ return; } liveTimer = setInterval(()=>{ if(ALL.length){ vscode.postMessage({ command:'since', after: ALL[ALL.length-1].TimeStamp }); } }, 5000); }
function stopLive(){ if(liveTimer){ clearInterval(liveTimer); liveTimer=null; } }
function updateLevelBtn(){ const n = document.querySelectorAll('.lv:checked').length; const b=$('levelBtn'); if(b){ b.textContent = (n===5?'All levels':'Levels ('+n+')')+' \u25be'; } }
$('search').addEventListener('input', render);
document.querySelectorAll('.lv').forEach(c=>c.addEventListener('change', ()=>{ render(); updateLevelBtn(); }));
$('levelBtn').addEventListener('click', e=>{ e.stopPropagation(); $('levelMenu').classList.toggle('open'); });
document.addEventListener('click', e=>{ if(!e.target.closest('#levelMs')){ $('levelMenu').classList.remove('open'); } });
$('loggerBtn').addEventListener('click', e=>{ e.stopPropagation(); $('loggerMenu').classList.toggle('open'); });
$('loggerFilter').addEventListener('input', renderLoggerList);
$('loggerFilter').addEventListener('click', e=>e.stopPropagation());
$('loggerList').addEventListener('change', e=>{ if(e.target && e.target.classList.contains('lg')){ if(e.target.checked){ selectedLoggers.add(e.target.value); } else { selectedLoggers.delete(e.target.value); } render(); updateLoggerBtn(); } });
$('loggerSelShown').addEventListener('click', ()=>{ document.querySelectorAll('#loggerList .lg').forEach(c=>{ c.checked=true; selectedLoggers.add(c.value); }); render(); updateLoggerBtn(); });
$('loggerClear').addEventListener('click', ()=>{ selectedLoggers.clear(); renderLoggerList(); render(); updateLoggerBtn(); });
document.addEventListener('click', e=>{ if(!e.target.closest('#loggerMs')){ $('loggerMenu').classList.remove('open'); } });
$('range').addEventListener('change', doLoad);
$('refreshBtn').addEventListener('click', doLoad);
$('olderBtn').addEventListener('click', ()=>{ if(ALL.length){ $('status').textContent='Loading older…'; vscode.postMessage({ command:'older', before: ALL[0].TimeStamp, top: 1000 }); } });
$('liveChk').addEventListener('change', e=>{ live = e.target.checked; if(live){ startLive(); } else { stopLive(); } });
$('exportBtn').addEventListener('click', exportText);
window.addEventListener('message', ev=>{
    const m = ev.data;
    if(m.command==='entries'){ mergeEntries(m.entries||[], m.mode); $('status').textContent = ALL.length + ' entries loaded' + (live?' · live':''); }
    else if(m.command==='error'){ $('status').textContent = 'Error: ' + m.message; }
});
updateLevelBtn();
doLoad();
if(live){ startLive(); }
`;
    }
}

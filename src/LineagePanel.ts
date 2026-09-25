import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

type LNode = { id: string; label: string; color: string; layer: number; kind: string; clickable: boolean };
type LEdge = { from: string; to: string; label?: string };
type Graph = { mode: 'process' | 'rule'; title: string; subtitle: string; legend: { color: string; label: string }[]; nodes: LNode[]; edges: LEdge[] };
type RunEvent = { ts: number; proc: string; error: boolean; durMs?: number; parent?: string };

const COL = {
    self: '#f5f5f5',
    proc: '#cfe2ff',
    missing: '#ffd0d0',
    ref: '#cfe2ff',    // DB / CellValueN/S
    attr: '#ffe0b3',   // ATTRS / ATTRN dims
    feedIn: '#c7e9c0', // cubes feeding INTO this cube
    fedOut: '#e6ccff'  // cubes THIS cube feeds
};

/** Process call-tree and cube rule lineage, rendered as an interactive diagram. */
export class LineagePanel {
    // Session cache of every cube's rules per instance — the "which cubes feed
    // into this cube" scan needs all rules, which is slow on big models; caching
    // makes the first rule lineage pay the cost once and later ones instant.
    private static rulesCache = new Map<string, { Name: string; rules: string }[]>();
    private static async allRules(instance: string): Promise<{ Name: string; rules: string }[]> {
        const cached = LineagePanel.rulesCache.get(instance);
        if (cached) return cached;
        const r = await TM1Service.getInstance().getAllCubeRules(instance);
        LineagePanel.rulesCache.set(instance, r);
        return r;
    }
    static clearCache(instance?: string) {
        if (instance) LineagePanel.rulesCache.delete(instance); else LineagePanel.rulesCache.clear();
    }

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _mode: 'process' | 'rule' = 'process';
    private _root = '';
    private _procNames = new Map<string, string>(); // lower -> original
    private _events: RunEvent[] = [];               // parsed from the message log
    private _runs: RunEvent[] = [];                 // root-process executions
    private _nav: { mode: 'process' | 'rule'; target: string }[] = [];
    private _navPos = -1;

    private constructor(panel: vscode.WebviewPanel, private instance: string) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._html();
        this._panel.webview.onDidReceiveMessage(async msg => {
            if (msg.command === 'reroot' && msg.kind && msg.id) {
                await this._navTo(msg.kind === 'cube' ? 'rule' : 'process', msg.id);
            } else if (msg.command === 'nav') {
                await this._navGo(Number(msg.dir));
            } else if (msg.command === 'analyzeLog') {
                await this._analyzeLog(Number(msg.days) || 1);
            } else if (msg.command === 'selectRun') {
                this._overlayRun(Number(msg.index));
            }
        }, null, this._disposables);
    }

    static async showProcess(instance: string, process: string) {
        const panel = LineagePanel._create(instance);
        await panel._navTo('process', process);
    }
    static async showRule(instance: string, cube: string) {
        const panel = LineagePanel._create(instance);
        await panel._navTo('rule', cube);
    }

    // Navigate to a lineage, pushing onto history (unless replaying history).
    private async _navTo(mode: 'process' | 'rule', target: string, push = true) {
        if (push) {
            this._nav = this._nav.slice(0, this._navPos + 1);
            this._nav.push({ mode, target });
            this._navPos = this._nav.length - 1;
        }
        this._sendNav();
        if (mode === 'process') { await this._loadProcess(target); } else { await this._loadRule(target); }
    }
    private async _navGo(dir: number) {
        const p = this._navPos + dir;
        if (p < 0 || p >= this._nav.length) return;
        this._navPos = p;
        await this._navTo(this._nav[p].mode, this._nav[p].target, false);
    }
    private _sendNav() {
        this._panel.webview.postMessage({
            command: 'nav',
            canBack: this._navPos > 0,
            canForward: this._navPos < this._nav.length - 1,
            trail: this._nav.map(n => n.target),
            pos: this._navPos
        });
    }

    // A fresh panel per invocation so several lineages can be open side by side;
    // clicking a node re-roots the tab it was clicked in (handled per instance).
    private static _create(instance: string): LineagePanel {
        const panel = vscode.window.createWebviewPanel('tm1Lineage', 'TM1 Lineage', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
        return new LineagePanel(panel, instance);
    }

    private _post(g: Graph) { this._panel.webview.postMessage({ command: 'graph', graph: g }); }
    private _status(text: string) { this._panel.webview.postMessage({ command: 'status', text }); }

    // ── Process lineage ──────────────────────────────────────────────────
    private async _loadProcess(root: string) {
        this._panel.title = `Lineage: ${root}`;
        this._mode = 'process';
        this._root = root;
        this._events = []; this._runs = [];
        this._status(`Loading processes…`);
        try {
            const all = await TM1Service.getInstance().getAllProcessCode(this.instance);
            const byName = new Map<string, string>();
            this._procNames = new Map<string, string>();
            for (const p of all) { byName.set(p.Name.toLowerCase(), p.code); this._procNames.set(p.Name.toLowerCase(), p.Name); }

            const nodes = new Map<string, LNode>();
            const edges: LEdge[] = [];
            const add = (name: string, layer: number, kind: string) => {
                const id = name;
                const existing = nodes.get(id.toLowerCase());
                if (existing) { existing.layer = Math.min(existing.layer, layer); return existing; }
                const exists = byName.has(name.toLowerCase());
                const n: LNode = {
                    id, label: name, layer,
                    color: kind === 'root' ? COL.self : (exists ? COL.proc : COL.missing),
                    kind: exists ? 'process' : 'missing', clickable: exists
                };
                nodes.set(id.toLowerCase(), n);
                return n;
            };
            add(root, 0, 'root');
            const seen = new Set<string>([root.toLowerCase()]);
            const queue: { name: string; layer: number }[] = [{ name: root, layer: 0 }];
            const edgeSeen = new Set<string>();
            while (queue.length) {
                const { name, layer } = queue.shift()!;
                const code = byName.get(name.toLowerCase());
                if (code == null) continue;
                for (const child of LineagePanel._findExecutedProcesses(code)) {
                    if (child.toLowerCase() === name.toLowerCase()) continue; // self-call guard
                    add(child, layer + 1, 'process');
                    const ek = name.toLowerCase() + '\u0000' + child.toLowerCase();
                    if (!edgeSeen.has(ek)) { edgeSeen.add(ek); edges.push({ from: name, to: child }); }
                    if (byName.has(child.toLowerCase()) && !seen.has(child.toLowerCase())) {
                        seen.add(child.toLowerCase());
                        queue.push({ name: child, layer: layer + 1 });
                    }
                }
            }
            this._post({
                mode: 'process',
                title: `Process call tree — ${root}`,
                subtitle: edges.length ? `${nodes.size} processes · ${edges.length} calls · click a box to re-root` : 'This process does not call any other processes.',
                legend: [
                    { color: COL.self, label: 'Selected process' },
                    { color: COL.proc, label: 'Called process' },
                    { color: COL.missing, label: 'Missing on server' }
                ],
                nodes: [...nodes.values()], edges
            });
        } catch (e: any) {
            this._status(`Failed: ${e.message}`);
            vscode.window.showErrorMessage(`Lineage: ${e.message}`);
        }
    }

    // ── Rule / cube lineage ──────────────────────────────────────────────
    private async _loadRule(cube: string) {
        this._panel.title = `Lineage: ${cube}`;
        this._mode = 'rule';
        this._status(`Loading cube rules…`);
        try {
            // Phase 1 — only the selected cube's own rules (fast): references,
            // attribute dims and the cubes it feeds.
            const selfRules = await TM1Service.getInstance().getRuleContent(this.instance, cube);
            const { calc, feeder } = LineagePanel._splitCalcFeeders(selfRules);
            const refs = LineagePanel._refCubes(calc, cube);
            const attrs = LineagePanel._attrDims(calc);
            const fedOut = LineagePanel._feederTargets(feeder, cube);

            const legend = [
                { color: COL.self, label: 'Selected cube' },
                { color: COL.ref, label: 'DB / CellValueN/S reference' },
                { color: COL.attr, label: 'ATTRS / ATTRN dimension' },
                { color: COL.feedIn, label: 'Feeds this cube' },
                { color: COL.fedOut, label: 'This cube feeds' }
            ];
            const build = (feedIn: string[], scanning: boolean): Graph => {
                const nodes: LNode[] = [];
                const edges: LEdge[] = [];
                const pushNode = (id: string, label: string, color: string, layer: number, kind: string, clickable: boolean) => {
                    if (nodes.some(n => n.id === id)) return;
                    nodes.push({ id, label, color, layer, kind, clickable });
                };
                pushNode(cube, cube, COL.self, 1, 'cube', false);
                for (const f of feedIn) { pushNode('in::' + f, f, COL.feedIn, 0, 'cube', true); edges.push({ from: 'in::' + f, to: cube }); }
                for (const r of refs) { pushNode('ref::' + r, r, COL.ref, 2, 'cube', true); edges.push({ from: 'ref::' + r, to: cube }); }
                for (const a of attrs) { pushNode('attr::' + a, a, COL.attr, 2, 'dim', false); edges.push({ from: 'attr::' + a, to: cube }); }
                for (const fo of fedOut) { pushNode('out::' + fo, fo, COL.fedOut, 2, 'cube', true); edges.push({ from: cube, to: 'out::' + fo }); }
                const total = feedIn.length + refs.length + attrs.length + fedOut.length;
                const subtitle = !selfRules.trim() ? 'This cube has no rules.'
                    : (scanning
                        ? `${refs.length} refs · ${attrs.length} attr dims · ${fedOut.length} fed · scanning other cubes for feeders…`
                        : (total ? `${feedIn.length} feed in · ${refs.length} refs · ${attrs.length} attr dims · ${fedOut.length} fed · click a cube to re-root`
                            : 'No cube references or feeders found in this cube\u2019s rules.'));
                return { mode: 'rule', title: `Cube rule lineage — ${cube}`, subtitle, legend, nodes, edges };
            };

            // Show the fast part immediately.
            this._post(build([], true));

            // Phase 2 — scan all cubes' feeders to find who feeds THIS cube
            // (cached per instance so it's only slow once).
            const all = await LineagePanel.allRules(this.instance);
            const feedIn: string[] = [];
            for (const c of all) {
                if (c.Name.toLowerCase() === cube.toLowerCase()) continue;
                const f = LineagePanel._splitCalcFeeders(c.rules || '').feeder;
                if (LineagePanel._feederTargets(f, c.Name).some(t => t.toLowerCase() === cube.toLowerCase())) feedIn.push(c.Name);
            }
            this._post(build(feedIn, false));
        } catch (e: any) {
            this._status(`Failed: ${e.message}`);
            vscode.window.showErrorMessage(`Lineage: ${e.message}`);
        }
    }

    // ── tm1server.log run analysis (process mode) ────────────────────────
    private async _analyzeLog(days: number) {
        if (this._mode !== 'process' || !this._root) return;
        this._panel.webview.postMessage({ command: 'logStatus', text: `Reading tm1server.log (last ${days} day${days > 1 ? 's' : ''})…` });
        try {
            const since = new Date(Date.now() - days * 86400000).toISOString();
            const entries = await TM1Service.getInstance().getMessageLogEntriesWindow(this.instance, since);
            this._events = this._parseEvents(entries);
            const rootLower = this._root.toLowerCase();
            // Top-level runs of the root = executions not triggered by another process.
            this._runs = this._events.filter(e => e.proc === rootLower && !e.parent);
            if (!this._runs.length) this._runs = this._events.filter(e => e.proc === rootLower);
            const runs = this._runs.map((r, i) => ({ index: i, label: new Date(r.ts).toLocaleString() + (r.error ? '  \u26a0' : '') }));
            this._panel.webview.postMessage({ command: 'runs', runs });
            this._panel.webview.postMessage({
                command: 'logStatus',
                text: this._runs.length
                    ? `${this._runs.length} run(s) of "${this._root}" found · ${this._events.length} process events in window · pick a run`
                    : `No executions of "${this._root}" found in the last ${days} day(s). (Requires process logging in tm1server.log.)`
            });
        } catch (e: any) {
            this._panel.webview.postMessage({ command: 'logStatus', text: `Log analysis failed: ${e.message}` });
        }
    }

    private _overlayRun(index: number) {
        if (index < 0 || index >= this._runs.length) return;
        const run = this._runs[index];
        const start = run.ts;
        // Prefer the root run's own end (start + duration); else next run start.
        const end = run.durMs != null ? start + run.durMs + 100
            : (index + 1 < this._runs.length ? this._runs[index + 1].ts : start + 6 * 3600 * 1000);
        const stats: Record<string, { count: number; errors: number; totalMs: number; durCount: number }> = {};
        for (const e of this._events) {
            if (e.ts < start - 1000 || e.ts > end) continue;
            const s = stats[e.proc] || (stats[e.proc] = { count: 0, errors: 0, totalMs: 0, durCount: 0 });
            s.count++;
            if (e.error) s.errors++;
            if (e.durMs != null) { s.totalMs += e.durMs; s.durCount++; }
        }
        const anyError = Object.values(stats).some(s => s.errors > 0);
        this._panel.webview.postMessage({
            command: 'overlay', stats, run: new Date(start).toLocaleString(),
            summary: `${Object.keys(stats).length} processes ran · ${anyError ? '\u26a0 chain had errors' : 'all succeeded'}`
        });
    }

    // Extract per-process runs from the message log by pairing execution start
    // lines ("executed by …" / "run from process …") with the matching finish
    // line ("Process/Prozess \"X\": … finished/aborted …"). Handles English and
    // German logs and prefers the logged elapsed time for duration.
    private _parseEvents(entries: any[]): RunEvent[] {
        const open = new Map<string, { startTs: number; parent?: string }[]>();
        const pushOpen = (p: string, v: { startTs: number; parent?: string }) => {
            const s = open.get(p) || []; s.push(v); open.set(p, s);
        };
        const done: RunEvent[] = [];
        for (const en of entries) {
            const msg = String(en.Message ?? en.message ?? '');
            const ts = Date.parse(en.TimeStamp ?? en.Timestamp ?? en.timeStamp ?? '');
            if (isNaN(ts) || !msg) continue;

            // Child start: "… run from process "Parent" …"
            let m = /Pro[cz]ess\s+"([^"]+)"\s+run from process\s+"([^"]+)"/i.exec(msg);
            if (m && this._procNames.has(m[1].toLowerCase())) { pushOpen(m[1].toLowerCase(), { startTs: ts, parent: m[2] }); continue; }

            // Top-level start: "… executed by user/chore …"
            m = /Pro[cz]ess\s+"([^"]+)"\s+executed by/i.exec(msg);
            if (m && this._procNames.has(m[1].toLowerCase())) { pushOpen(m[1].toLowerCase(), { startTs: ts }); continue; }

            // Finish/abort line: "Process/Prozess "X": …"
            m = /Pro[cz]ess\s+"([^"]+)"\s*:\s*(.*)$/i.exec(msg);
            if (m && this._procNames.has(m[1].toLowerCase())) {
                const p = m[1].toLowerCase();
                const tail = m[2] || '';
                const error = String(en.Level ?? en.level ?? '').toUpperCase() === 'ERROR'
                    || /abort|error|with errors|fail|rolled\s*back|not complete|abgebrochen|fehler|fehlgeschlagen/i.test(tail);
                const stack = open.get(p);
                const st = (stack && stack.length) ? stack.pop() : undefined;
                const el = /(?:elapsed time|verstrichene Zeit)\s+([0-9.,]+)/i.exec(tail);
                const durMs = el ? Math.round(parseFloat(el[1].replace(',', '.')) * 1000)
                    : (st ? Math.max(0, ts - st.startTs) : undefined);
                done.push({ ts: st ? st.startTs : ts, proc: p, error, durMs, parent: st?.parent });
            }
        }
        // Starts that never got a finish line — still count as runs, no duration.
        for (const [p, stack] of open) for (const st of stack) done.push({ ts: st.startTs, proc: p, error: false, parent: st.parent });
        done.sort((a, b) => a.ts - b.ts);
        return done;
    }

    // ── Parsing helpers (mirror the reference Python) ─────────────────────
    private static _stripComments(text: string): string {
        return text.split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
    }
    private static _splitCalcFeeders(rules: string): { calc: string; feeder: string } {
        const m = /^\s*FEEDERS\s*;/im.exec(rules);
        if (m) return { calc: rules.slice(0, m.index), feeder: rules.slice(m.index + m[0].length) };
        return { calc: rules, feeder: '' };
    }
    private static _refCubes(calc: string, self: string): string[] {
        const text = LineagePanel._stripComments(calc);
        const out = new Set<string>();
        const rxs = [/\bDB\s*\(\s*(['"])(.+?)\1/gi, /\bCellValue[NS]\s*\(\s*(['"])(.+?)\1/gi];
        for (const rx of rxs) { let m; while ((m = rx.exec(text))) { if (m[2].toLowerCase() !== self.toLowerCase()) out.add(m[2]); } }
        return [...out];
    }
    private static _attrDims(calc: string): string[] {
        const text = LineagePanel._stripComments(calc);
        const out = new Set<string>();
        const rx = /\bATTR[SN]\s*\(\s*(['"])(.+?)\1/gi;
        let m; while ((m = rx.exec(text))) out.add(m[2]);
        return [...out];
    }
    // Cube targets referenced by feeder statements (=> DB('Target', ...)).
    private static _feederTargets(feeder: string, self: string): string[] {
        const text = LineagePanel._stripComments(feeder);
        const out = new Set<string>();
        const rx = /=>\s*DB\s*\(\s*(['"])(.+?)\1/gi;
        let m; while ((m = rx.exec(text))) { if (m[2].toLowerCase() !== self.toLowerCase()) out.add(m[2]); }
        return [...out];
    }
    // ExecuteProcess/RunProcess targets; resolves literal names and simple
    // variables assigned earlier in the code (var = 'Name';).
    private static _findExecutedProcesses(code: string): string[] {
        const lines = code.split('\n');
        const rx = /\b(?:ExecuteProcess|RunProcess)\s*\(\s*([^,)]+?)\s*[,)]/gi;
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            let m;
            rx.lastIndex = 0;
            while ((m = rx.exec(lines[i]))) {
                const resolved = LineagePanel._resolveArg(m[1].trim(), lines, i);
                if (resolved) out.push(resolved);
            }
        }
        return out;
    }
    private static _resolveArg(arg: string, lines: string[], idx: number): string | null {
        const q = arg.match(/^['"](.+?)['"]$/);
        if (q) return q[1];
        if (!/^[A-Za-z_]\w*$/.test(arg)) return null; // not a plain variable
        const assign = new RegExp('\\b' + arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\s*=\\s*(['\"])(.+?)\\1", 'i');
        for (let i = idx; i >= 0; i--) {
            const a = assign.exec(lines[i]);
            if (a) return a[2];
        }
        return null;
    }

    private _html(): string {
        return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<style>
  body { margin:0; padding:0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  #bar { padding:10px 14px; border-bottom:1px solid var(--vscode-panel-border); position:sticky; top:0; background:var(--vscode-editor-background); z-index:2; }
  #title { font-size:14px; font-weight:600; }
  #subtitle { font-size:12px; color: var(--vscode-descriptionForeground); margin-top:2px; }
  #legend { display:flex; flex-wrap:wrap; gap:12px; margin-top:8px; font-size:11px; color: var(--vscode-descriptionForeground); }
  #legend span { display:inline-flex; align-items:center; gap:5px; }
  .chip { width:12px; height:12px; border-radius:3px; border:1px solid rgba(0,0,0,0.25); display:inline-block; }
  #wrap { overflow:auto; padding:16px; }
  .node rect { stroke: rgba(0,0,0,0.35); stroke-width:1; rx:6; ry:6; cursor:default; }
  .node.clickable rect { cursor:pointer; }
  .node.clickable:hover rect { stroke: var(--vscode-focusBorder); stroke-width:2; }
  .node text { font-size:12px; fill:#1e1e1e; pointer-events:none; }
  .node text.stat { font-size:10px; fill:#333; }
  .node.err rect { stroke:#d33; stroke-width:2; }
  .node.notrun { opacity:0.38; }
  .edge { fill:none; stroke: var(--vscode-descriptionForeground); stroke-width:1.3; opacity:0.75; }
  #empty { padding:24px; color: var(--vscode-descriptionForeground); }
  #logbar { display:none; margin-top:10px; gap:8px; align-items:center; flex-wrap:wrap; font-size:12px; }
  #logbar.show { display:flex; }
  #logbar select, #logbar button { font-size:12px; padding:2px 6px; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#555); border-radius:4px; }
  #logbar button { cursor:pointer; background:var(--vscode-button-background); color:var(--vscode-button-foreground); border:none; }
  #logStatus { color: var(--vscode-descriptionForeground); }
  #nav { display:flex; align-items:center; gap:6px; margin-bottom:6px; }
  #nav button { font-size:12px; line-height:1; padding:2px 8px; cursor:pointer; background:var(--vscode-button-secondaryBackground,#3a3d41); color:var(--vscode-button-secondaryForeground,#fff); border:none; border-radius:4px; }
  #nav button:disabled { opacity:0.4; cursor:default; }
  #crumb { font-size:11px; color:var(--vscode-descriptionForeground); }
</style></head><body>
  <div id="bar">
    <div id="nav"><button id="backBtn" title="Back" disabled>\u25c0 Back</button><button id="fwdBtn" title="Forward" disabled>Forward \u25b6</button><span id="crumb"></span></div>
    <div id="title">TM1 Lineage</div>
    <div id="subtitle">Right-click a process or cube in the tree → Show Lineage.</div>
    <div id="legend"></div>
    <div id="logbar">
      <span>tm1server.log:</span>
      <select id="logDays"><option value="1">last 1 day</option><option value="2">last 2 days</option><option value="3">last 3 days</option><option value="7">last 7 days</option><option value="14">last 14 days</option><option value="30">last 30 days</option></select>
      <button id="analyzeBtn">Analyze runs</button>
      <select id="runSel" style="display:none"></select>
      <label id="statModeWrap" style="display:none">show <select id="statMode"><option value="avg">avg time</option><option value="total">total time</option></select></label>
      <span id="logStatus"></span>
    </div>
  </div>
  <div id="wrap"><div id="empty"></div><svg id="svg" xmlns="http://www.w3.org/2000/svg"></svg></div>
<script>
const vscode = acquireVsCodeApi();
const NODE_W = 168, NODE_H = 30, GAP_X = 90, GAP_Y = 14, PAD = 16;
let current = null;
let overlay = null;      // { procNameLower: {count, errors, totalMs, durCount} }
let statMode = 'avg';

window.addEventListener('message', e => {
  const m = e.data;
  if (m.command === 'status') { document.getElementById('subtitle').textContent = m.text; }
  if (m.command === 'graph') { current = m.graph; overlay = null; resetLogBar(); render(m.graph); }
  if (m.command === 'nav') {
    document.getElementById('backBtn').disabled = !m.canBack;
    document.getElementById('fwdBtn').disabled = !m.canForward;
    const crumb = document.getElementById('crumb');
    if (m.trail && m.trail.length) {
      crumb.textContent = '\u2022 ' + m.trail.map(function(t, i){ return i === m.pos ? ('[' + t + ']') : t; }).join('  \u203a  ');
    } else { crumb.textContent = ''; }
  }
  if (m.command === 'logStatus') { document.getElementById('logStatus').textContent = m.text; }
  if (m.command === 'runs') { populateRuns(m.runs); }
  if (m.command === 'overlay') {
    overlay = m.stats || {};
    document.getElementById('logStatus').textContent = 'Run ' + m.run + ' · ' + m.summary;
    render(current);
  }
});

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function truncate(s, n){ s = String(s); return s.length > n ? s.slice(0, n-1) + '\u2026' : s; }
function fmtMs(ms){
  if (ms == null) return '';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const s = ms/1000;
  if (s < 60) return (s < 10 ? s.toFixed(1) : Math.round(s)) + 's';
  const mn = Math.floor(s/60), rest = Math.round(s%60);
  return mn + 'm' + (rest ? rest + 's' : '');
}
function statText(node){
  if (!overlay) return null;
  const s = overlay[String(node.label).toLowerCase()];
  if (!s) return { ran:false, text:'not run' };
  let t = '\u00d7' + s.count;
  if (s.durCount > 0) { const ms = statMode === 'total' ? s.totalMs : s.totalMs / s.durCount; t += '  \u23f1' + fmtMs(ms); }
  if (s.errors > 0) t += '  \u26a0' + s.errors;
  return { ran:true, err: s.errors > 0, text: t };
}

function resetLogBar(){
  const runSel = document.getElementById('runSel');
  runSel.style.display = 'none'; runSel.innerHTML = '';
  document.getElementById('statModeWrap').style.display = 'none';
  document.getElementById('logStatus').textContent = '';
}
function populateRuns(runs){
  const runSel = document.getElementById('runSel');
  if (!runs || !runs.length) { runSel.style.display = 'none'; return; }
  runSel.innerHTML = '<option value="">— pick a run —</option>' + runs.map(r => '<option value="'+r.index+'">'+esc(r.label)+'</option>').join('');
  runSel.style.display = '';
  document.getElementById('statModeWrap').style.display = '';
}

function render(g){
  if (!g) return;
  document.getElementById('title').textContent = g.title;
  if (!overlay) document.getElementById('subtitle').textContent = g.subtitle;
  const leg = document.getElementById('legend');
  leg.innerHTML = (g.legend||[]).map(l => '<span><i class="chip" style="background:'+l.color+'"></i>'+esc(l.label)+'</span>').join('');
  document.getElementById('logbar').className = (g.mode === 'process') ? 'show' : '';

  const svg = document.getElementById('svg');
  const empty = document.getElementById('empty');
  if (!g.nodes || !g.nodes.length) { svg.innerHTML=''; svg.setAttribute('width','0'); svg.setAttribute('height','0'); empty.textContent = g.subtitle || 'Nothing to show.'; return; }
  empty.textContent = '';

  const layers = [...new Set(g.nodes.map(n => n.layer))].sort((a,b)=>a-b);
  const byLayer = new Map(layers.map(l => [l, g.nodes.filter(n => n.layer===l)]));
  const pos = new Map();
  let maxRows = 0;
  byLayer.forEach(list => { maxRows = Math.max(maxRows, list.length); });
  const totalH = PAD*2 + maxRows*NODE_H + (maxRows-1)*GAP_Y;

  layers.forEach((l, li) => {
    const list = byLayer.get(l);
    const colH = list.length*NODE_H + (list.length-1)*GAP_Y;
    const y0 = PAD + (totalH - PAD*2 - colH)/2;
    const x = PAD + li*(NODE_W + GAP_X);
    list.forEach((n, ri) => { pos.set(n.id, { x, y: y0 + ri*(NODE_H+GAP_Y) }); });
  });

  const width = PAD*2 + layers.length*NODE_W + (layers.length-1)*GAP_X;
  svg.setAttribute('width', width); svg.setAttribute('height', totalH);
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + totalH);

  const layerOf = {}; g.nodes.forEach(n => layerOf[n.id] = n.layer);
  let paths = '<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3 L0,6 Z" fill="var(--vscode-descriptionForeground)"/></marker></defs>';

  for (const e of g.edges) {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) continue;
    const fromRight = (layerOf[e.from] <= layerOf[e.to]);
    const sx = fromRight ? a.x + NODE_W : a.x;
    const sy = a.y + NODE_H/2;
    const toLeft = (layerOf[e.to] >= layerOf[e.from]);
    const tx = toLeft ? b.x : b.x + NODE_W;
    const ty = b.y + NODE_H/2;
    const dx = Math.max(30, Math.abs(tx - sx) * 0.5);
    const c1x = sx + (fromRight ? dx : -dx);
    const c2x = tx + (toLeft ? -dx : dx);
    paths += '<path class="edge" marker-end="url(#arrow)" d="M'+sx+','+sy+' C'+c1x+','+sy+' '+c2x+','+ty+' '+tx+','+ty+'"/>';
  }

  let boxes = '';
  for (const n of g.nodes) {
    const p = pos.get(n.id);
    const st = statText(n);
    let cls = 'node' + (n.clickable ? ' clickable' : '');
    if (st) { if (!st.ran) cls += ' notrun'; if (st.err) cls += ' err'; }
    const handler = n.clickable ? ' data-kind="'+(n.kind==='cube'?'cube':'process')+'" data-label="'+esc(n.label)+'"' : '';
    let inner = '<rect x="'+p.x+'" y="'+p.y+'" width="'+NODE_W+'" height="'+NODE_H+'" fill="'+n.color+'"/>';
    if (st && st.ran) {
      inner += '<text x="'+(p.x+NODE_W/2)+'" y="'+(p.y+12)+'" text-anchor="middle">'+esc(truncate(n.label, 24))+'</text>';
      inner += '<text class="stat" x="'+(p.x+NODE_W/2)+'" y="'+(p.y+24)+'" text-anchor="middle">'+esc(st.text)+'</text>';
    } else {
      inner += '<text x="'+(p.x+NODE_W/2)+'" y="'+(p.y+NODE_H/2+4)+'" text-anchor="middle">'+esc(truncate(n.label, 24))+'</text>';
    }
    boxes += '<g class="'+cls+'"'+handler+'>' + inner + '<title>'+esc(n.label)+(st&&st.ran?('  ('+st.text+')'):'')+'</title></g>';
  }
  svg.innerHTML = paths + boxes;

  svg.querySelectorAll('.node.clickable').forEach(el => {
    el.addEventListener('click', () => {
      vscode.postMessage({ command: 'reroot', kind: el.getAttribute('data-kind'), id: el.getAttribute('data-label') });
    });
  });
}

document.getElementById('analyzeBtn').addEventListener('click', () => {
  overlay = null;
  const days = document.getElementById('logDays').value;
  document.getElementById('logStatus').textContent = 'Analyzing…';
  vscode.postMessage({ command: 'analyzeLog', days });
});
document.getElementById('runSel').addEventListener('change', e => {
  const v = e.target.value;
  if (v === '') { overlay = null; render(current); return; }
  vscode.postMessage({ command: 'selectRun', index: v });
});
document.getElementById('statMode').addEventListener('change', e => { statMode = e.target.value; if (overlay) render(current); });
document.getElementById('backBtn').addEventListener('click', () => vscode.postMessage({ command: 'nav', dir: -1 }));
document.getElementById('fwdBtn').addEventListener('click', () => vscode.postMessage({ command: 'nav', dir: 1 }));
document.addEventListener('keydown', e => {
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); vscode.postMessage({ command: 'nav', dir: -1 }); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); vscode.postMessage({ command: 'nav', dir: 1 }); }
});
</script></body></html>`;
    }

    dispose() {
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) d.dispose(); }
    }
}

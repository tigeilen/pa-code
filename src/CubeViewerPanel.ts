import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';
import { SubsetEditorPanel } from './SubsetEditorPanel';
import { MDXWizardPanel, mdxBuilderStyles, mdxBuilderHtml, mdxBuilderScript } from './MDXWizardPanel';
import { MDX_FUNCTIONS, MDX_SNIPPETS } from './MDXFunctions';
import { handleMdxBuilderBackend } from './MDXBuilder';

/**
 * PAW-style Cube Viewer / pivot grid webview.
 * Title dimensions on top, nested row/column headers, editable data cells,
 * drag & drop pivoting, zero suppression and MDX inspection.
 */
export class CubeViewerPanel {
    private static panels: Map<string, CubeViewerPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private readonly _cubeName: string;
    private readonly _viewName?: string;
    private _key: string = '';

    private constructor(panel: vscode.WebviewPanel, instanceName: string, cubeName: string, viewName?: string) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._cubeName = cubeName;
        this._viewName = viewName;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(async msg => {
            const tm1 = TM1Service.getInstance();
            try {
                // Embedded MDX Builder (shared with the MDX Wizard): its Insert
                // routes into the dock editor; all other builder data/generate
                // commands are served by the shared backend.
                if (msg.command === 'insertMDX') {
                    this._post('mdxFromWizard', { mdx: msg.mdx, mode: msg.mode });
                    return;
                }
                const builderReply = await handleMdxBuilderBackend(this._instanceName, msg);
                if (builderReply !== undefined) {
                    if (builderReply) { this._post(builderReply.command, builderReply.data); }
                    return;
                }
                switch (msg.command) {
                    case 'init': {
                        const dims = await tm1.getCubeDimensions(this._instanceName, this._cubeName);
                        this._post('cubeMeta', {
                            cube: this._cubeName,
                            view: this._viewName || '',
                            isAdmin: tm1.getAdminStatus(this._instanceName),
                            dimensions: dims.map(d => ({
                                name: d.Name,
                                hierarchy: (d.Hierarchies && d.Hierarchies[0] && d.Hierarchies[0].Name) || d.Name
                            }))
                        });
                        this._post('builderCube', { cube: this._cubeName });
                        break;
                    }
                    case 'getInitialMembers': {
                        const members = await tm1.getInitialMembers(this._instanceName, msg.dimension, msg.hierarchy);
                        this._post('initialMembers', { dimension: msg.dimension, hierarchy: msg.hierarchy, members });
                        break;
                    }
                    case 'executeView': {
                        if (!this._viewName) { this._post('viewCellset', { data: null }); break; }
                        // Prefer the native view definition (correct axis layout &
                        // subsets even when the cellset is empty from zero-suppression).
                        const structure = await tm1.getViewStructure(this._instanceName, this._cubeName, this._viewName).catch(() => null);
                        if (structure && (structure.rows.length || structure.columns.length || structure.titles.length)) {
                            this._post('viewStructure', { structure });
                        } else {
                            const data = await tm1.executeView(this._instanceName, this._cubeName, this._viewName);
                            this._post('viewCellset', { data });
                        }
                        break;
                    }
                    case 'getChildren': {
                        const children = await tm1.getElementChildren(this._instanceName, msg.dimension, msg.hierarchy, msg.element);
                        this._post('children', { dimension: msg.dimension, element: msg.element, children, requestId: msg.requestId });
                        break;
                    }
                    case 'execute': {
                        const data = await tm1.executeMDXCube(this._instanceName, msg.mdx);
                        this._post('cellset', { data, requestId: msg.requestId });
                        break;
                    }
                    case 'writeCell': {
                        if (msg.consolidated) {
                            // TM1 does not accept direct input on consolidated cells
                            // (data spreading is not supported here). Inform clearly
                            // instead of silently "succeeding" with a no-op.
                            vscode.window.showWarningMessage('This is a consolidated cell — TM1 does not store direct input on consolidations. Enter values on leaf (N-element) cells instead.');
                            this._post('error', { message: 'Consolidated cell — value not written.' });
                            break;
                        }
                        try {
                            await tm1.writeCellByTuple(this._instanceName, this._cubeName, msg.tuple || [], msg.value);
                            this._post('cellWritten', { ok: true });
                        } catch (werr: any) {
                            const message = werr.message || 'Write failed';
                            vscode.window.showErrorMessage(`Cube write failed: ${message}`);
                            this._post('error', { message });
                        }
                        break;
                    }
                    case 'editSelection': {
                        // Open the Subset Editor and register a return channel: when the
                        // user clicks "Use in Cube View", the chosen members (and the
                        // selected alias) are pushed back onto this dimension's axis.
                        const dim = msg.dimension, hier = msg.hierarchy;
                        SubsetEditorPanel.render(this._instanceName, { dimension: dim, hierarchy: hier, members: msg.members || [] }, (payload: { members: any[]; alias?: string }) => {
                            this._post('setDimensionMembers', { dimension: dim, members: payload.members, alias: payload.alias || '' });
                            this._panel.reveal(vscode.ViewColumn.One);
                        });
                        break;
                    }
                    case 'getAliasValues': {
                        const map = await tm1.getElementAliasMap(this._instanceName, msg.dimension, msg.hierarchy, msg.alias);
                        this._post('aliasValues', { dimension: msg.dimension, alias: msg.alias, map });
                        break;
                    }
                    case 'getElementTypes': {
                        const map = await tm1.getElementTypeMap(this._instanceName, msg.dimension, msg.hierarchy);
                        this._post('elementTypes', { dimension: msg.dimension, map });
                        break;
                    }
                    case 'copyMdx': {
                        await vscode.env.clipboard.writeText(msg.mdx || '');
                        vscode.window.showInformationMessage('MDX copied to clipboard.');
                        break;
                    }
                    case 'exportCsv': {
                        const csv = String(msg.csv || '');
                        if (!csv) { break; }
                        const pad = (n: number) => String(n).padStart(2, '0');
                        const d = new Date();
                        const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
                        const safe = (s: string) => String(s || 'cube').replace(/[^\w.-]+/g, '_');
                        const base = safe(this._viewName ? `${this._cubeName}_${this._viewName}` : this._cubeName);
                        const uri = await vscode.window.showSaveDialog({
                            filters: { 'CSV': ['csv'] },
                            saveLabel: 'Export grid to CSV',
                            defaultUri: vscode.Uri.file(`${base}_${ts}.csv`)
                        });
                        if (uri) {
                            // Prepend a UTF-8 BOM so Excel opens special characters correctly.
                            await vscode.workspace.fs.writeFile(uri, Buffer.from('\uFEFF' + csv, 'utf8'));
                            vscode.window.showInformationMessage(`Exported the grid to ${uri.fsPath}`);
                        }
                        break;
                    }
                    case 'saveView': {
                        const name = await vscode.window.showInputBox({
                            prompt: `Save view in cube '${this._cubeName}'`,
                            value: this._viewName || `${this._cubeName}_View`,
                            validateInput: v => v && v.trim().length > 0 ? undefined : 'Enter a view name'
                        });
                        if (!name) break;
                        const trimmed = name.trim();
                        // Existence check → offer overwrite before writing.
                        let exists = false;
                        try {
                            const views = await tm1.getViews(this._instanceName, this._cubeName);
                            exists = views.some(v => v.Name.toLowerCase() === trimmed.toLowerCase());
                        } catch { /* if the check fails, fall through to a normal save */ }
                        if (exists) {
                            const ans = await vscode.window.showWarningMessage(
                                `A view named '${trimmed}' already exists in '${this._cubeName}'. Overwrite it?`,
                                { modal: true }, 'Overwrite');
                            if (ans !== 'Overwrite') break;
                        }
                        const vis = await vscode.window.showQuickPick(['Public', 'Private'], { placeHolder: 'Save as' });
                        if (!vis) break;
                        await tm1.saveView(this._instanceName, this._cubeName, trimmed, msg.mdx || '', vis === 'Private');
                        vscode.window.showInformationMessage(`View '${trimmed}' saved (${vis}).`);
                        this._post('viewSaved', { name: trimmed });
                        break;
                    }
                    case 'pickView': {
                        const views = await tm1.getViews(this._instanceName, this._cubeName);
                        if (!views.length) { vscode.window.showInformationMessage(`Cube '${this._cubeName}' has no saved views.`); break; }
                        const picked = await vscode.window.showQuickPick(
                            views.map(v => v.Name),
                            { placeHolder: `Search views of ${this._cubeName}…` });
                        if (!picked) break;
                        CubeViewerPanel.render(this._instanceName, this._cubeName, picked);
                        break;
                    }
                    case 'openWizard': {
                        MDXWizardPanel.render(this._instanceName, {
                            mode: 'view',
                            cube: this._cubeName,
                            onInsert: (mdx: string, wmode?: string) => {
                                this._panel.reveal(vscode.ViewColumn.One, true);
                                this._post('mdxFromWizard', { mdx, mode: wmode });
                            }
                        });
                        break;
                    }
                }
            } catch (err: any) {
                this._post('error', { message: err.message, requestId: msg.requestId });
                vscode.window.showErrorMessage(`Cube Viewer: ${err.message}`);
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string, cubeName: string, viewName?: string) {
        const key = `${instanceName}|${cubeName}|${viewName || ''}`;
        const existing = CubeViewerPanel.panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            return;
        }
        const title = viewName ? `View: ${cubeName} · ${viewName}` : `Cube: ${cubeName}`;
        const panel = vscode.window.createWebviewPanel(
            'tm1CubeViewer', title, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const p = new CubeViewerPanel(panel, instanceName, cubeName, viewName);
        p._key = key;
        CubeViewerPanel.panels.set(key, p);
    }

    /** Closes all Cube Viewer tabs bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string) {
        for (const p of Array.from(CubeViewerPanel.panels.values())) {
            if (p._instanceName === instanceName) { p._panel.dispose(); }
        }
    }

    private dispose() {
        CubeViewerPanel.panels.delete(this._key);
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) d.dispose(); }
    }

    private _post(command: string, data: any) {
        this._panel.webview.postMessage({ command, ...data });
    }

    private _getWebviewContent(): string {
        return CUBE_VIEWER_HTML;
    }
}

const CUBE_VIEWER_HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #444);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-sec-fg: var(--vscode-button-secondaryForeground, #ccc);
    --border: var(--vscode-panel-border, #333);
    --accent: var(--vscode-focusBorder, #007acc);
    --list-hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --header-bg: var(--vscode-editorWidget-background, #252526);
    --desc: var(--vscode-descriptionForeground, #999);
    --grid-line: var(--vscode-panel-border, #3a3a3a);
}
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px); color: var(--fg); background: var(--bg); margin: 0; height: 100vh; overflow: hidden; }
.app { display: flex; flex-direction: column; height: 100vh; }

/* Toolbar */
.toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.toolbar .title { font-weight: 600; margin-right: 8px; }
.toolbar .spacer { flex: 1; }
button { background: var(--btn-bg); color: var(--btn-fg); border: none; border-radius: 2px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
button:hover { background: var(--btn-hover); }
button.secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
button.toggle.active { outline: 2px solid var(--accent); }

/* Title dimensions bar */
.titles { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; min-height: 44px; flex-shrink: 0; }
.titles .zone-label { color: var(--desc); font-size: 11px; margin-right: 4px; }
.dim-card {
    display: inline-flex; flex-direction: column; gap: 2px; padding: 4px 10px;
    background: var(--header-bg); border: 1px solid var(--border); border-radius: 4px;
    cursor: grab; user-select: none; min-width: 110px;
}
.dim-card .dim-name { font-size: 10px; color: var(--desc); }
.dim-card .dim-sel { font-size: 12px; font-weight: 600; }
.dim-card .dim-row { display: flex; align-items: center; gap: 6px; }
.dim-card .type-glyph { color: #4ec9b0; font-size: 12px; }
.dim-card .title-select { background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 2px; font-size: 12px; max-width: 160px; }
.dim-card .chip-menu { cursor: pointer; opacity: 0.6; padding: 0 2px; }
.dim-card .chip-menu:hover { opacity: 1; }
.dim-card.dragging { opacity: 0.4; }

/* Drop zones */
.dropzone { min-height: 34px; min-width: 140px; border: 1px dashed var(--border); border-radius: 4px; padding: 3px 6px; display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; flex: 1; }
.dropzone.over { border-color: var(--accent); background: rgba(0,122,204,0.10); }
.dropzone:empty::before, .dropzone.is-empty::before { content: 'Drop dimension here'; color: var(--desc); font-style: italic; font-size: 11px; }
.dim-card.drop-before { box-shadow: -3px 0 0 var(--accent); }
.dim-card.drop-after { box-shadow: 3px 0 0 var(--accent); }

/* Grid */
.grid-wrap { flex: 1; overflow: auto; position: relative; }
table.pivot { border-collapse: collapse; font-size: 12px; }
table.pivot th, table.pivot td { border: 1px solid var(--grid-line); padding: 2px 8px; white-space: nowrap; }
table.pivot th { background: var(--header-bg); font-weight: 600; position: sticky; }
table.pivot thead th { top: 0; z-index: 2; }
table.pivot .corner { position: sticky; left: 0; top: 0; z-index: 3; background: var(--header-bg); }
table.pivot .rowhead { position: sticky; left: 0; z-index: 1; text-align: left; }
table.pivot td.cell { text-align: right; cursor: cell; min-width: 90px; }
table.pivot td.cell.updateable:hover { background: var(--list-hover); }
table.pivot td.cell.readonly { color: var(--desc); cursor: default; }
table.pivot td.cell.rule { color: var(--vscode-charts-blue, #4aa8ff); font-style: italic; background: rgba(74,168,255,0.08); cursor: not-allowed; }
table.pivot td.cell.consolidated { font-weight: 600; }
.twisty { display: inline-block; width: 14px; text-align: center; cursor: pointer; opacity: 0.8; }
.twisty.expanded { transform: rotate(90deg); }
.twisty.leaf { visibility: hidden; }
.title-expand { display: inline-block; width: 16px; text-align: center; cursor: pointer; opacity: 0.75; font-size: 10px; user-select: none; }
.title-expand:hover { opacity: 1; }
.cell-input { width: 100%; border: 1px solid var(--accent); background: var(--input-bg); color: var(--input-fg); text-align: right; font-size: 12px; padding: 1px 4px; }
/* Row/column header context menu */
table.pivot th.rowhead, table.pivot thead th[data-name] { cursor: context-menu; }
.ctx-menu { position: fixed; display: none; z-index: 1000; min-width: 200px; background: var(--vscode-menu-background, #252526); color: var(--vscode-menu-foreground, #ccc); border: 1px solid var(--vscode-menu-border, #454545); border-radius: 5px; padding: 4px 0; box-shadow: 0 2px 8px rgba(0,0,0,0.4); font-size: 13px; }
.ctx-menu.open { display: block; }
.ctx-menu .ctx-item { padding: 5px 14px; cursor: pointer; white-space: nowrap; }
.ctx-menu .ctx-item:hover { background: var(--vscode-menu-selectionBackground, #094771); color: var(--vscode-menu-selectionForeground, #fff); }
.ctx-menu .ctx-item.disabled { opacity: 0.4; pointer-events: none; }
.ctx-menu .ctx-sep { height: 1px; background: var(--vscode-menu-separatorBackground, #454545); margin: 4px 0; }

/* MDX split-view dock */
.split { display: flex; height: 100vh; }
.split .app { flex: 1; min-width: 0; }
.mdx-dock { display: none; position: relative; flex-direction: column; width: 560px; min-width: 340px; max-width: 80vw; border-left: 1px solid var(--border); background: var(--bg); }
.split.mdx-open .mdx-dock { display: flex; }
.mdx-resizer { position: absolute; left: 0; top: 0; width: 6px; height: 100%; cursor: ew-resize; z-index: 3; }
.mdx-resizer:hover, .mdx-resizer.dragging { background: var(--vscode-focusBorder, #3794ff); opacity: 0.5; }
.mdx-dock-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid var(--border); font-weight: 600; flex-shrink: 0; }
.mdx-x { background: none; border: none; color: var(--fg); cursor: pointer; font-size: 13px; opacity: 0.7; }
.mdx-x:hover { opacity: 1; }
.mdx-tools { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--border); align-items: center; flex-shrink: 0; }
.mdx-tools .mdx-auto { font-size: 11px; color: var(--desc); display: inline-flex; align-items: center; gap: 3px; margin-left: auto; cursor: pointer; }
.mdx-dock textarea#mdxText { flex: 1 1 auto; margin: 8px 10px 0; min-height: 220px; resize: none; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 4px; padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.5; tab-size: 2; }
.mdx-hint { padding: 5px 10px 8px; font-size: 11px; color: var(--desc); flex-shrink: 0; }
.mdx-panes { flex: 0 1 auto; max-height: 42%; overflow: auto; border-top: 1px solid var(--border); }
.mdx-section { border-bottom: 1px solid var(--border); }
.mdx-sec-head { padding: 6px 10px; cursor: pointer; font-weight: 600; font-size: 12px; user-select: none; position: sticky; top: 0; background: var(--bg); z-index: 1; }
.mdx-sec-head:hover { background: var(--list-hover); }
.mdx-caret { display: inline-block; width: 12px; }
.mdx-sec-body { padding: 4px 10px 8px; }
#fnSearch { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 5px 8px; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 4px; font-size: 12px; }
.fn-cat { border-bottom: 1px solid var(--input-border); }
.fn-cat-head { font-size: 12px; font-weight: 600; color: var(--fg); padding: 5px 4px; cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
.fn-cat-head:hover { background: var(--list-hover); }
.fn-cat-caret { display: inline-block; width: 10px; color: var(--desc); }
.fn-cat-count { margin-left: auto; color: var(--desc); font-size: 10px; font-weight: normal; }
.fn-cat-items { padding-left: 4px; }
.fn-item { padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.fn-item:hover { background: var(--list-hover); }
.fn-item .fn-name { color: var(--vscode-symbolIcon-functionForeground, #b180d7); font-weight: 600; }
.fn-item .fn-syn { color: var(--desc); font-size: 10px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sn-item { padding: 5px 8px; border-radius: 4px; cursor: pointer; }
.sn-item:hover { background: var(--list-hover); }
.sn-item .sn-name { font-weight: 600; font-size: 12px; }
.sn-item .sn-desc { color: var(--desc); font-size: 11px; }
.status { padding: 4px 12px; font-size: 11px; color: var(--desc); border-top: 1px solid var(--border); flex-shrink: 0; }
.legend { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--desc); margin-right: 4px; }
.legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 2px; background: rgba(74,168,255,0.25); border: 1px solid var(--vscode-charts-blue, #4aa8ff); }

/* MDX dock: embedded View Builder (writes into the editor) */
#mdxBuildPane { display: none; flex: 0 1 auto; max-height: 50%; overflow: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
#mdxBuildPane.open { display: block; }
#mdxBuildPane .mdxb { height: auto; display: block; }
#mdxBuildPane .mode-tabs { display: none; }
#mdxBuildPane .main { display: block; overflow: visible; }
#mdxBuildPane .config-panel { border-right: none; overflow: visible; padding: 10px; min-width: 0; }
#mdxBuildPane .preview-panel { display: none; }
#mdxBuildToggle.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

/* Embedded MDX Builder (shared with the MDX Wizard) */
${mdxBuilderStyles()}
</style>
</head>
<body>
<div class="split" id="split">
<div class="app">
    <div class="toolbar">
        <span class="title" id="cubeTitle">Cube</span>
        <button class="secondary" id="swapBtn" title="Swap rows and columns">⇄ Swap</button>
        <button class="toggle" id="suppressRowsBtn" title="Suppress empty rows">Ø Rows</button>
        <button class="toggle" id="suppressColsBtn" title="Suppress empty columns">Ø Columns</button>
        <button class="secondary" id="refreshBtn">↻ Refresh</button>
        <button class="secondary" id="openViewBtn" title="Open a saved view of this cube">📂 Views</button>
        <button class="secondary" id="exportBtn" title="Export the current grid to CSV">⭳ Export</button>
        <div class="spacer"></div>
        <span class="legend"><span class="legend-swatch"></span>Rule-calculated</span>
        <button id="saveViewBtn" title="Save this layout as a view on the server">💾 Save View</button>
        <button class="secondary" id="mdxBtn">MDX</button>
    </div>

    <div class="titles">
        <span class="zone-label">Context</span>
        <div class="dropzone" id="titleZone" data-zone="title"></div>
    </div>

    <div class="titles">
        <span class="zone-label">Rows</span>
        <div class="dropzone" id="rowZone" data-zone="row"></div>
        <span class="zone-label" style="margin-left:16px">Columns</span>
        <div class="dropzone" id="colZone" data-zone="col"></div>
    </div>

    <div class="grid-wrap" id="gridWrap">
        <table class="pivot" id="pivot">
            <thead id="pivotHead"></thead>
            <tbody id="pivotBody"></tbody>
        </table>
    </div>

    <div class="status" id="status">Loading…</div>
</div>

<div class="ctx-menu" id="ctxMenu"></div>

<aside class="mdx-dock" id="mdxDock">
    <div class="mdx-resizer" id="mdxResizer" title="Drag to resize"></div>
    <div class="mdx-dock-head">
        <span>MDX Editor</span>
        <button class="mdx-x" id="mdxDockClose" title="Close editor">✕</button>
    </div>
    <div class="mdx-tools">
        <button id="mdxApplyBtn" title="Run the MDX and update the grid">▶ Apply</button>
        <button class="secondary" id="mdxUndoBtn" title="Undo the last change (Ctrl+Z)" disabled>↶ Undo</button>
        <button class="secondary" id="mdxRedoBtn" title="Redo (Ctrl+Y)" disabled>↷ Redo</button>
        <button class="secondary" id="mdxFormatBtn" title="Pretty-print the MDX across multiple lines">Format</button>
        <button class="secondary" id="mdxMinifyBtn" title="Collapse the MDX back onto a single line">Minify</button>
        <button class="secondary" id="mdxCopyBtn" title="Copy MDX to clipboard">Copy</button>
        <button class="secondary" id="mdxSaveBtn" title="Save the current layout as a view">Save as View</button>
        <button class="secondary" id="mdxBuildToggle" title="Show the visual View Builder — it writes into this editor">🔧 Wizard</button>
        <label class="mdx-auto" title="Apply automatically as you type"><input type="checkbox" id="mdxAuto"> Live</label>
    </div>
    <textarea id="mdxText" spellcheck="false"></textarea>
    <div class="mdx-hint" id="mdxHint">Edit the MDX and click <b>Apply</b> — the grid updates in place. Toggle <b>🔧 Wizard</b> to build the view visually; it writes into this editor.</div>
    <div id="mdxBuildPane">
${mdxBuilderHtml()}
    </div>
    <div class="mdx-panes">
        <div class="mdx-section">
            <div class="mdx-sec-head" data-sec="fn"><span class="mdx-caret">▾</span> Functions</div>
            <div class="mdx-sec-body" id="fnBody">
                <input type="text" id="fnSearch" placeholder="Search functions…">
                <div id="fnList"></div>
            </div>
        </div>
        <div class="mdx-section">
            <div class="mdx-sec-head" data-sec="sn"><span class="mdx-caret">▸</span> Examples</div>
            <div class="mdx-sec-body" id="snBody" style="display:none;">
                <div id="snList"></div>
            </div>
        </div>
    </div>
</aside>
</div>

<script>
window.MDX_FUNCTIONS = ${JSON.stringify(MDX_FUNCTIONS)};
window.MDX_SNIPPETS = ${JSON.stringify(MDX_SNIPPETS)};
</script>
<script>
${CUBE_VIEWER_SCRIPT()}
</script>
<script>
${mdxBuilderScript()}
</script>
</body>
</html>`;

function CUBE_VIEWER_SCRIPT(): string {
    return /* js */ `
const vscode = acquireVsCodeApi();

// ---- State ----
let S = {
    cube: '', view: '',
    // Each dimension: { name, hierarchy, members:[{name,type,level,depth,expanded,parent}], selIndex }
    dims: new Map(),
    titles: [],   // dimension names
    rows: [],     // dimension names (nested)
    cols: [],     // dimension names (nested)
    suppressRows: false,
    suppressCols: false,
    isAdmin: false,
    lastCellset: null,
    execSeq: 0,
    childSeq: 0
};

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function post(command,data){vscode.postMessage(Object.assign({command},data||{}));}
function setStatus(t){document.getElementById('status').textContent=t;}
function normType(t){ if(typeof t==='string'){const s=t.toLowerCase(); if(s==='consolidated')return 3; if(s==='string')return 2; return 1;} return t; }
function q(dimName){ const d=S.dims.get(dimName); return '[' + d.name + '].[' + d.hierarchy + ']'; }
function member(dimName,name){ return q(dimName) + '.[' + name + ']'; }
// Display label for a member: use the dimension's alias value when available, else the name.
function disp(dimName,name){ const d=S.dims.get(dimName); return (d && d.aliasMap && d.aliasMap[name]) || name; }
// Parse a member UniqueName "[Dim].[Hier].[Elem]" into its parts.
function parseUnique(u){
    if(!u)return null;
    const parts=u.split('].[').map(s=>s.replace(/^\[/,'').replace(/\]$/,''));
    if(parts.length>=3)return {dim:parts[0],hier:parts[1],elem:parts.slice(2).join('].[')};
    if(parts.length===2)return {dim:parts[0],hier:parts[0],elem:parts[1]};
    return null;
}
// Rebuild the layout (rows/columns/context + per-dimension members) from an
// executed view's cellset so the actual saved view is shown, not a default.
function reconstructFromView(data){
    const axes=data.Axes||[];
    S.cols=[]; S.rows=[]; S.titles=[];
    for(const [,d] of S.dims){ d.members=[]; d.selIndex=0; d.alias=''; d.aliasMap=null; }
    function applyAxis(ax, targetArr){
        if(!ax || !ax.Tuples || !ax.Tuples.length)return;
        const depth=(ax.Tuples[0].Members||[]).length;
        // Prefer the axis Hierarchies (reliable dim mapping); fall back to UniqueName parsing
        const hiers = ax.Hierarchies || [];
        for(let pos=0;pos<depth;pos++){
            let dimName='', hierName='';
            if(hiers[pos]){ hierName=hiers[pos].Name; dimName=(hiers[pos].Dimension&&hiers[pos].Dimension.Name)||hiers[pos].Name; }
            if(!dimName || !S.dims.has(dimName)){
                const first=ax.Tuples[0].Members[pos];
                const pu=parseUnique(first&&first.UniqueName);
                if(pu){ dimName=pu.dim; hierName=pu.hier; }
                else if(first){ dimName=first.Name; }
            }
            if(!S.dims.has(dimName))continue;
            const d=S.dims.get(dimName);
            if(hierName)d.hierarchy=hierName;
            targetArr.push(dimName);
            const seen=new Set(); const members=[];
            for(const t of ax.Tuples){
                const mem=(t.Members||[])[pos];
                if(!mem||seen.has(mem.Name))continue;
                seen.add(mem.Name);
                members.push({name:mem.Name,type:normType(mem.Type),level:mem.Level||0,depth:0,expanded:false});
            }
            d.members=members; d.selIndex=0;
        }
    }
    // TM1 appends a slicer (context) axis after the query axes. When a query
    // axis is empty (e.g. edited MDX with only ON COLUMNS) that slicer would
    // otherwise land in the rows slot, emptying the context — so map only the
    // real query axes to cols/rows and route any trailing axis to titles.
    const qac = S.queryAxisCount || 2;
    S.queryAxisCount = 0;
    if (qac >= 1) { applyAxis(axes[0], S.cols); }
    if (qac >= 2) { applyAxis(axes[1], S.rows); }
    for (let ai = qac; ai < axes.length; ai++) { applyAxis(axes[ai], S.titles); }
    // Any dimension not placed on an axis becomes a context (title) dim; load a default member
    for(const [name,d] of S.dims){
        const placed=S.cols.includes(name)||S.rows.includes(name)||S.titles.includes(name);
        if(!placed)S.titles.push(name);
        if(!d.members||!d.members.length)post('getInitialMembers',{dimension:d.name,hierarchy:d.hierarchy});
    }
    // View-execution cellsets don't reliably return element types, so fetch a
    // Name->Type map per row/column dimension to detect consolidations (twisties).
    const axisDims=new Set([...S.rows,...S.cols]);
    for(const dn of axisDims){ const d=S.dims.get(dn); if(d)post('getElementTypes',{dimension:d.name,hierarchy:d.hierarchy}); }
    renderTitles();
    renderGrid(data);
    setStatus('View '+(S.view||'')+' loaded.');
}

// Lay the view out from its native definition (Rows/Columns/Titles + subsets),
// which is reliable even when the executed cellset is empty (zero suppression).
function buildLayoutFromStructure(st){
    S.cols=[]; S.rows=[]; S.titles=[];
    for(const [,d] of S.dims){ d.members=[]; d.selIndex=0; d.alias=''; d.aliasMap=null; d.subsetMdx=''; }
    function place(sel, arr){
        const dn=sel.dimension;
        if(!dn || !S.dims.has(dn)){ return null; }
        const d=S.dims.get(dn);
        if(sel.hierarchy){ d.hierarchy=sel.hierarchy; }
        d.subsetMdx=sel.subsetMdx||'';
        d.members=(sel.elements||[]).map(e=>({name:e.name,type:normType(e.type),level:e.level||0,depth:0,expanded:false}));
        arr.push(dn);
        return d;
    }
    for(const sel of (st.columns||[])){ place(sel, S.cols); }
    for(const sel of (st.rows||[])){ place(sel, S.rows); }
    for(const sel of (st.titles||[])){
        const d=place(sel, S.titles);
        if(d){
            let idx=d.members.findIndex(mm=>mm.name===sel.selected);
            if(idx<0 && sel.selected){ d.members.unshift({name:sel.selected,type:1,level:0,depth:0,expanded:false}); idx=0; }
            d.selIndex=idx<0?0:idx;
            if(!d.members.length){ post('getInitialMembers',{dimension:d.name,hierarchy:d.hierarchy}); }
        }
    }
    // Cube dimensions the view doesn't mention become context.
    for(const [name,d] of S.dims){
        const placed=S.cols.includes(name)||S.rows.includes(name)||S.titles.includes(name);
        if(!placed){ S.titles.push(name); if(!d.members||!d.members.length){ post('getInitialMembers',{dimension:d.name,hierarchy:d.hierarchy}); } }
    }
    S.suppressCols=!!st.suppressCols; S.suppressRows=!!st.suppressRows;
    const srb=document.getElementById('suppressRowsBtn'); if(srb){ srb.classList.toggle('active',S.suppressRows); }
    const scb=document.getElementById('suppressColsBtn'); if(scb){ scb.classList.toggle('active',S.suppressCols); }
    renderTitles();
    ensureMembersLoaded(()=>reload());
}

// ---- Number formatting ----
function formatNumber(v){
    if(v==null||v==='')return '';
    const n=typeof v==='number'?v:parseFloat(v);
    if(isNaN(n))return String(v);
    return n.toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2});
}
function parseNumber(str){
    if(str==null)return '';
    let s=String(str).trim();
    if(s==='')return '';
    // Remove thousand separators (both , and .) heuristically: keep last separator as decimal
    const lastComma=s.lastIndexOf(','), lastDot=s.lastIndexOf('.');
    if(lastComma>-1&&lastDot>-1){
        if(lastComma>lastDot){ s=s.replace(/\\./g,'').replace(',', '.'); }
        else { s=s.replace(/,/g,''); }
    } else if(lastComma>-1){
        // Only commas -> treat comma as decimal if it looks like one
        const parts=s.split(',');
        if(parts.length===2 && parts[1].length<=2){ s=s.replace(',', '.'); }
        else { s=s.replace(/,/g,''); }
    }
    const n=parseFloat(s);
    return isNaN(n)?str:n;
}

// ---- MDX generation ----
function axisSet(dimNames){
    // Build a (possibly crossjoined) set from the given dimensions' member lists
    const sets=dimNames.map(dn=>{
        const d=S.dims.get(dn);
        if((!d.members||!d.members.length) && d.subsetMdx){ const x=String(d.subsetMdx).trim(); return x.charAt(0)==='{'?x:('{'+x+'}'); }
        const list=d.members.map(m=>member(dn,m.name)).join(', ');
        return '{' + (list||('TM1SUBSETALL(' + q(dn) + ')')) + '}';
    });
    if(sets.length===0)return '';
    let expr=sets[0];
    for(let i=1;i<sets.length;i++) expr='CROSSJOIN(' + expr + ', ' + sets[i] + ')';
    return expr;
}
// Collapse any pretty-printed MDX back onto a single, whitespace-normalised line.
function minifyMDX(mdx){
    return String(mdx||'')
        .replace(/\\s+/g,' ')
        .replace(/\\s*\\(\\s*/g,'(')
        .replace(/\\s*\\)/g,')')
        .replace(/\\s*,\\s*/g,', ')
        .trim();
}
// Pretty-print MDX: top-level clauses on their own lines and nested function
// parentheses indented by depth. Purely cosmetic; Minify reverses it exactly.
function formatMDX(mdx){
    let s=minifyMDX(mdx);
    if(!s) return s;
    let out='', depth=0, indent='  ';
    const pad=()=>indent.repeat(depth+1);
    for(let i=0;i<s.length;i++){
        const ch=s[i], rest=s.slice(i);
        const clause=rest.match(/^(SELECT|FROM|WHERE)\\b/i);
        if(clause && depth===0){
            out=out.replace(/\\s+$/,'');
            out+=(out?'\\n':'')+clause[1].toUpperCase();
            out+=/^SELECT$/i.test(clause[1]) ? '\\n'+indent : ' ';
            i+=clause[1].length-1;
            continue;
        }
        if(ch==='('){ depth++; out+='(\\n'+pad(); }
        else if(ch===')'){ out=out.replace(/\\s+$/,''); depth=Math.max(0,depth-1); out+='\\n'+indent.repeat(depth+1)+')'; }
        else if(ch===',' && depth>0){ out+=',\\n'+pad(); }
        else if(ch===' ' && /\\s$/.test(out)){ /* squeeze */ }
        else out+=ch;
    }
    return out.replace(/[ \\t]+\\n/g,'\\n').replace(/\\n{2,}/g,'\\n').trim();
}
function getMDXStatement(){
    const colSet=(S.cols.length)?axisSet(S.cols):'';
    const rowSet=(S.rows.length)?axisSet(S.rows):'';
    // Assign axes contiguously (ON 0, ON 1) so an empty columns axis never leaves
    // a "sequence gap". If only rows exist, they go on axis 0.
    const axisExprs=[];
    if(colSet) axisExprs.push((S.suppressCols?'NON EMPTY ':'') + colSet);
    if(rowSet) axisExprs.push((S.suppressRows?'NON EMPTY ':'') + rowSet);
    const parts=axisExprs.map((e,i)=> e + ' ON ' + i);
    let mdx='SELECT ' + parts.join(', ') + ' FROM [' + S.cube + ']';
    if(S.titles.length){
        const where=S.titles.map(dn=>{ const d=S.dims.get(dn); const m=d.members[d.selIndex]||d.members[0]; return m?member(dn,m.name):null; }).filter(Boolean);
        if(where.length) mdx += ' WHERE (' + where.join(', ') + ')';
    }
    return mdx;
}

function reload(){
    if(S.rows.length===0 && S.cols.length===0){ setStatus('Add a dimension to rows or columns.'); return; }
    S.reconstructNext=false;
    const mdx=getMDXStatement();
    S.execSeq++;
    setStatus('Executing…');
    post('execute',{mdx,requestId:S.execSeq});
}

// ---- Rendering: dimension chips in the three zones ----
function typeGlyph(t){ const n=normType(t); return n===3?'∑':(n===2?'S':'◉'); }
function renderChip(dn, zone){
    const d=S.dims.get(dn);
    const card=document.createElement('div');
    card.className='dim-card'; card.draggable=true; card.dataset.dim=dn; card.dataset.zone=zone;
    if(zone==='title'){
        const cur=d.members[d.selIndex]||d.members[0]||{};
        const opts=(d.members||[]).map((m,i)=>'<option value="'+i+'"'+(i===d.selIndex?' selected':'')+'>'+'\u00A0\u00A0'.repeat(m.depth||0)+esc(disp(dn,m.name))+'</option>').join('');
        const expandBtn=(normType(cur.type)===3)
            ? '<span class="title-expand" title="'+(cur.expanded?'Collapse this consolidation':'Expand \u2013 list its children')+'" data-expand-title="'+esc(dn)+'">'+(cur.expanded?'\u25BC':'\u25B6')+'</span>'
            : '';
        card.innerHTML='<span class="dim-name">'+esc(dn)+'</span>'
            +'<span class="dim-row"><span class="type-glyph">'+typeGlyph(cur.type)+'</span>'
            +expandBtn
            +'<select class="title-select" data-dim="'+esc(dn)+'">'+opts+'</select>'
            +'<span class="chip-menu" title="Edit selection\u2026" data-edit="'+esc(dn)+'">\u22ee</span></span>';
    } else {
        card.innerHTML='<span class="dim-name">'+(zone==='row'?'Row':'Column')+'</span>'
            +'<span class="dim-row"><span class="type-glyph">\u25f0</span><span class="dim-sel">'+esc(dn)+'</span>'
            +'<span class="chip-menu" title="Edit selection\u2026" data-edit="'+esc(dn)+'">\u22ee</span></span>';
    }
    card.addEventListener('dblclick',()=>editDim(d));
    return card;
}
function editDim(d){ post('editSelection',{dimension:d.name,hierarchy:d.hierarchy,members:(d.members||[]).map(m=>m.name)}); }
function renderTitles(){
    const tz=document.getElementById('titleZone'); tz.innerHTML='';
    for(const dn of S.titles) tz.appendChild(renderChip(dn,'title'));
    const rz=document.getElementById('rowZone'); if(rz){ rz.innerHTML=''; for(const dn of S.rows) rz.appendChild(renderChip(dn,'row')); }
    const cz=document.getElementById('colZone'); if(cz){ cz.innerHTML=''; for(const dn of S.cols) cz.appendChild(renderChip(dn,'col')); }
}

// ---- Rendering: pivot grid ----
function renderGrid(data){
    S.lastCellset=data;
    const axes=data.Axes||[];
    // Axis 0 = columns, Axis 1 = rows, Axis 2 = context
    const colTuples=(axes[0]||{Tuples:[]}).Tuples||[];
    const rowTuples=(axes[1]||{Tuples:[]}).Tuples||[];
    const numCols=colTuples.length||1;
    const numRows=rowTuples.length;
    const cells=data.Cells||[];
    const colDepth=S.cols.length||1;
    const rowDepth=S.rows.length||1;

    const rowMaps=S.rows.map(dn=>{ const map=new Map(); (S.dims.get(dn).members||[]).forEach(m=>map.set(m.name,m)); return map; });
    const colMaps=S.cols.map(dn=>{ const map=new Map(); (S.dims.get(dn).members||[]).forEach(m=>map.set(m.name,m)); return map; });

    const rowPaths=rowTuples.map(t=>(t.Members||[]).map(m=>m.Name));
    const colPaths=colTuples.map(t=>(t.Members||[]).map(m=>m.Name));
    const samePath=(a,b,upto)=>{ if(!a||!b)return false; for(let i=0;i<=upto;i++){ if((a[i]||'')!==(b[i]||''))return false; } return true; };

    // ---- Column header with colspan merging ----
    const head=document.getElementById('pivotHead');
    let thead='';
    for(let level=0; level<colDepth; level++){
        thead+='<tr>';
        if(level===0){ thead+='<th class="corner" rowspan="'+colDepth+'" colspan="'+rowDepth+'"></th>'; }
        for(let c=0;c<colTuples.length;c++){
            const isStart = c===0 || !samePath(colPaths[c], colPaths[c-1], level);
            if(!isStart) continue;
            let span=1; while(c+span<numCols && samePath(colPaths[c+span], colPaths[c], level)) span++;
            const mem=(colTuples[c].Members||[])[level];
            const name=mem?mem.Name:'';
            const dimName=S.cols[level];
            const cm=(colMaps[level]&&colMaps[level].get(name))||null;
            const t=cm?cm.type:(mem?normType(mem.Type):1);
            const twisty=(t===3)
                ? '<span class="twisty '+((cm&&cm.expanded)?'expanded':'')+'" data-expand="'+esc(name)+'" data-dim="'+esc(dimName)+'">▶</span>'
                : '';
            thead+='<th colspan="'+span+'" data-col="'+c+'" data-dim="'+esc(dimName)+'" data-name="'+esc(name)+'" data-axis="col" data-cons="'+(t===3?'1':'0')+'">'+twisty+esc(disp(dimName,name))+'</th>';
        }
        thead+='</tr>';
    }
    head.innerHTML=thead;

    // ---- Body with rowspan merging ----
    const body=document.getElementById('pivotBody');
    let html='';
    for(let r=0;r<numRows;r++){
        html+='<tr>';
        const members=rowTuples[r].Members||[];
        for(let rd=0; rd<rowDepth; rd++){
            const isStart = r===0 || !samePath(rowPaths[r], rowPaths[r-1], rd);
            if(!isStart) continue; // covered by a rowspan from an earlier row
            let span=1; while(r+span<numRows && samePath(rowPaths[r+span], rowPaths[r], rd)) span++;
            const mem=members[rd];
            const name=mem?mem.Name:'';
            const dimName=S.rows[rd];
            const rm=(rowMaps[rd]&&rowMaps[rd].get(name))||null;
            const t=rm?rm.type:(mem?normType(mem.Type):1);
            const depth=rm?rm.depth:0;
            const twisty=(t===3)
                ? '<span class="twisty '+((rm&&rm.expanded)?'expanded':'')+'" data-expand="'+esc(name)+'" data-dim="'+esc(dimName)+'">▶</span>'
                : '<span class="twisty leaf"></span>';
            html+='<th class="rowhead" rowspan="'+span+'" data-dim="'+esc(dimName)+'" data-name="'+esc(name)+'" data-axis="row" data-cons="'+(t===3?'1':'0')+'" style="padding-left:'+(6+depth*16)+'px">'+twisty+esc(disp(dimName,name))+'</th>';
        }
        for(let c=0;c<numCols;c++){
            const ordinal=r*numCols+c;
            const cell=cells[ordinal]||{};
            const val=cell.FormattedValue!=null?cell.FormattedValue:(cell.Value!=null?formatNumber(cell.Value):'');
            const consolidated=!!cell.Consolidated;
            const ruleDerived=!!cell.RuleDerived;
            // Rule-derived cells are never editable and are visually flagged. Leaf
            // cells are editable for everyone; consolidated only for admins.
            const editable = !ruleDerived && (!consolidated || S.isAdmin);
            let cls='cell '+(editable?'updateable':'readonly');
            if(ruleDerived)cls+=' rule';
            else if(consolidated)cls+=' consolidated';
            const title=ruleDerived?' title="Rule-calculated (read-only)"':'';
            html+='<td class="'+cls+'"'+title+' data-r="'+r+'" data-c="'+c+'" data-raw="'+esc(cell.Value==null?'':cell.Value)+'">'+esc(val)+'</td>';
        }
        html+='</tr>';
    }
    body.innerHTML=html;
    setStatus(numRows+' rows × '+numCols+' cols.');
}

// ---- Expand / collapse (lazy children into the row dimension member list) ----
function toggleExpand(dimName,elementName){
    const d=S.dims.get(dimName);
    const idx=d.members.findIndex(m=>m.name===elementName);
    if(idx<0)return;
    const node=d.members[idx];
    if(node.expanded){
        // collapse: remove contiguous descendants (depth greater than node.depth)
        let end=idx+1;
        while(end<d.members.length && d.members[end].depth>node.depth) end++;
        d.members.splice(idx+1, end-(idx+1));
        node.expanded=false;
        renderTitles();
        reload();
    } else {
        S.childSeq++;
        node._pendingReq=S.childSeq;
        post('getChildren',{dimension:d.name,hierarchy:d.hierarchy,element:elementName,requestId:S.childSeq});
        setStatus('Loading children…');
    }
}

// ---- Keep / Hide an element directly from the grid (PAW-style) ----
function findMember(dimName,name){ const d=S.dims.get(dimName); return d?(d.members||[]).find(m=>m.name===name):null; }
function keepOnly(dimName,name){
    const d=S.dims.get(dimName); if(!d){ return; }
    const m=findMember(dimName,name)||{name:name,type:1,level:0};
    d.members=[{name:m.name,type:m.type||1,level:m.level||0,depth:0,expanded:false}];
    d.subsetMdx='';
    reload();
    setStatus("Kept only '"+name+"' on "+dimName+".");
}
function hideMember(dimName,name){
    const d=S.dims.get(dimName); if(!d){ return; }
    if((d.members||[]).length<=1){ setStatus('Cannot hide the last remaining member of '+dimName+'.'); return; }
    const idx=(d.members||[]).findIndex(m=>m.name===name);
    if(idx>=0){
        const node=d.members[idx];
        let end=idx+1;
        while(end<d.members.length && d.members[end].depth>node.depth){ end++; }
        d.members.splice(idx, end-idx);
    } else {
        d.members=(d.members||[]).filter(m=>m.name!==name);
    }
    d.subsetMdx='';
    if(!d.members.length){ setStatus('Cannot hide the last remaining member.'); return; }
    reload();
    setStatus("Hid '"+name+"' on "+dimName+".");
}
function showCtxMenu(x,y,dimName,name,isCons){
    const menu=document.getElementById('ctxMenu');
    const m=findMember(dimName,name);
    const items=[];
    items.push({label:"Keep only \\u201c"+name+"\\u201d", act:()=>keepOnly(dimName,name)});
    items.push({label:"Hide \\u201c"+name+"\\u201d", act:()=>hideMember(dimName,name)});
    if(isCons){
        items.push({sep:true});
        if(m&&m.expanded){ items.push({label:'Drill up (collapse)', act:()=>toggleExpand(dimName,name)}); }
        else { items.push({label:'Drill down (expand)', act:()=>toggleExpand(dimName,name)}); }
    }
    items.push({sep:true});
    items.push({label:'Edit subset in Subset Editor\\u2026', act:()=>{ const d=S.dims.get(dimName); if(d){ editDim(d); } }});
    menu.innerHTML=items.map((it,i)=> it.sep?'<div class="ctx-sep"></div>':('<div class="ctx-item" data-i="'+i+'">'+esc(it.label)+'</div>')).join('');
    menu.style.left=x+'px'; menu.style.top=y+'px'; menu.classList.add('open');
    const r=menu.getBoundingClientRect();
    if(r.right>window.innerWidth){ menu.style.left=Math.max(0,x-r.width)+'px'; }
    if(r.bottom>window.innerHeight){ menu.style.top=Math.max(0,y-r.height)+'px'; }
    menu._items=items;
}
function hideCtxMenu(){ const m=document.getElementById('ctxMenu'); if(m){ m.classList.remove('open'); } }

// ---- Cell editing ----
function beginEdit(td){
    if(td.classList.contains('readonly'))return;
    const raw=td.getAttribute('data-raw');
    const consolidated=td.classList.contains('consolidated');
    const r=+td.dataset.r, c=+td.dataset.c;
    const input=document.createElement('input');
    input.className='cell-input'; input.value=raw;
    td.textContent=''; td.appendChild(input); input.focus(); input.select();
    let done=false;
    const commit=()=>{
        if(done)return; done=true;
        // Skip the write when the value was not changed (avoids clearing on blur)
        if(String(input.value).trim()===String(raw==null?'':raw).trim()){ renderGrid(S.lastCellset); return; }
        const parsed=parseNumber(input.value);
        const tuple=buildCellTuple(r,c);
        if(tuple){ post('writeCell',{tuple,value:parsed,consolidated}); setStatus('Writing…'); }
        else { renderGrid(S.lastCellset); }
    };
    input.addEventListener('keydown',e=>{ if(e.key==='Enter'){e.preventDefault(); input.blur();} else if(e.key==='Escape'){ done=true; renderGrid(S.lastCellset); } });
    input.addEventListener('blur',commit,{once:true});
}
function buildCellTuple(r,c){
    const data=S.lastCellset; if(!data)return null;
    const axes=data.Axes||[];
    const colMembers=(((axes[0]||{}).Tuples||[])[c]||{}).Members||[];
    const rowMembers=(((axes[1]||{}).Tuples||[])[r]||{}).Members||[];
    const tuple=[];
    S.rows.forEach((dn,i)=>{ const d=S.dims.get(dn); const mem=rowMembers[i]; if(d&&mem)tuple.push({dimension:d.name,hierarchy:d.hierarchy,element:mem.Name}); });
    S.cols.forEach((dn,i)=>{ const d=S.dims.get(dn); const mem=colMembers[i]; if(d&&mem)tuple.push({dimension:d.name,hierarchy:d.hierarchy,element:mem.Name}); });
    S.titles.forEach(dn=>{ const d=S.dims.get(dn); const m=d.members[d.selIndex]||d.members[0]; if(d&&m)tuple.push({dimension:d.name,hierarchy:d.hierarchy,element:m.name}); });
    return tuple;
}
function buildCellMdx(r,c){
    const data=S.lastCellset; if(!data)return '';
    const axes=data.Axes||[];
    const colTuples=(axes[0]||{}).Tuples||[];
    const rowTuples=(axes[1]||{}).Tuples||[];
    const colMembers=(colTuples[c]||{}).Members||[];
    const rowMembers=(rowTuples[r]||{}).Members||[];
    const colTuple=colMembers.map(m=>m.UniqueName||('['+m.Name+']')).join(', ');
    const rowTuple=rowMembers.map(m=>m.UniqueName||('['+m.Name+']')).join(', ');
    let mdx='SELECT {('+colTuple+')} ON 0, {('+rowTuple+')} ON 1 FROM [' + S.cube + ']';
    if(S.titles.length){
        const where=S.titles.map(dn=>{ const d=S.dims.get(dn); const m=d.members[d.selIndex]||d.members[0]; return member(dn,m.name); });
        mdx += ' WHERE (' + where.join(', ') + ')';
    }
    return mdx;
}

// ---- Drag & drop for dimensions (pivot between zones + reorder within a zone) ----
let drag=null;
function setupDnd(){
    document.addEventListener('dragstart',e=>{
        const card=e.target.closest('.dim-card'); if(!card)return;
        drag={dim:card.dataset.dim, from:card.dataset.zone};
        try{ e.dataTransfer.setData('text/plain', card.dataset.dim); e.dataTransfer.effectAllowed='move'; }catch(_){}
        card.classList.add('dragging');
    });
    document.addEventListener('dragend',()=>{
        document.querySelectorAll('.dim-card').forEach(c=>c.classList.remove('dragging','drop-before','drop-after'));
        document.querySelectorAll('.dropzone').forEach(z=>z.classList.remove('over'));
        drag=null;
    });
    ['titleZone','rowZone','colZone'].forEach(id=>attachZone(document.getElementById(id)));
}
function zoneArray(zone){ return zone==='title'?S.titles:(zone==='row'?S.rows:S.cols); }
function attachZone(zone){
    if(!zone)return;
    zone.addEventListener('dragover',e=>{
        e.preventDefault(); if(e.dataTransfer)e.dataTransfer.dropEffect='move';
        zone.classList.add('over');
        // Highlight insertion point
        zone.querySelectorAll('.dim-card').forEach(c=>c.classList.remove('drop-before','drop-after'));
        const over=e.target.closest('.dim-card');
        if(over){ const rect=over.getBoundingClientRect(); const after=e.clientX>rect.left+rect.width/2; over.classList.add(after?'drop-after':'drop-before'); }
    });
    zone.addEventListener('dragleave',e=>{ if(e.target===zone)zone.classList.remove('over'); });
    zone.addEventListener('drop',e=>{
        e.preventDefault(); zone.classList.remove('over');
        if(!drag)return;
        const targetZone=zone.dataset.zone;
        // Compute insertion index within the target zone
        const over=e.target.closest('.dim-card');
        let index=zoneArray(targetZone).length;
        if(over){
            const overDim=over.dataset.dim;
            const rect=over.getBoundingClientRect();
            const after=e.clientX>rect.left+rect.width/2;
            const arr=zoneArray(targetZone).filter(d=>d!==drag.dim);
            const pos=arr.indexOf(overDim);
            index=after?pos+1:pos;
        }
        moveDim(drag.dim, targetZone, index);
    });
}
function moveDim(dimName,toZone,index){
    S.titles=S.titles.filter(d=>d!==dimName);
    S.rows=S.rows.filter(d=>d!==dimName);
    S.cols=S.cols.filter(d=>d!==dimName);
    const arr=zoneArray(toZone);
    if(index==null||index<0||index>arr.length)index=arr.length;
    arr.splice(index,0,dimName);
    renderTitles();
    ensureMembersLoaded(()=>reload());
}
function ensureMembersLoaded(done){
    const needed=[...S.rows,...S.cols,...S.titles].filter(dn=>{ const d=S.dims.get(dn); return !d.members||d.members.length===0; });
    if(needed.length===0){ done&&done(); return; }
    S._pendingLoads=needed.length; S._afterLoad=done;
    for(const dn of needed){ const d=S.dims.get(dn); post('getInitialMembers',{dimension:d.name,hierarchy:d.hierarchy}); }
}

// ---- Column/row zone drop targets: pivot via the Context / Rows / Columns zones ----

function init(){
    post('init');
    document.getElementById('gridWrap').addEventListener('click',e=>{
        const tw=e.target.closest('.twisty');
        if(tw&&tw.dataset.expand){ toggleExpand(tw.dataset.dim, tw.dataset.expand); return; }
    });
    document.getElementById('gridWrap').addEventListener('dblclick',e=>{
        if(e.target.closest('.twisty')){ return; }
        const th=e.target.closest('th[data-name]');
        if(th&&th.dataset.name){ keepOnly(th.dataset.dim, th.dataset.name); return; }
        const td=e.target.closest('td.cell'); if(td)beginEdit(td);
    });
    document.getElementById('gridWrap').addEventListener('contextmenu',e=>{
        const th=e.target.closest('th[data-name]');
        if(!th||!th.dataset.name){ return; }
        e.preventDefault();
        showCtxMenu(e.clientX, e.clientY, th.dataset.dim, th.dataset.name, th.dataset.cons==='1');
    });
    document.getElementById('ctxMenu').addEventListener('click',e=>{
        const it=e.target.closest('.ctx-item'); if(!it){ return; }
        const menu=document.getElementById('ctxMenu');
        const item=menu._items&&menu._items[+it.dataset.i];
        hideCtxMenu();
        if(item&&item.act){ item.act(); }
    });
    window.addEventListener('click',e=>{ if(!e.target.closest('#ctxMenu')){ hideCtxMenu(); } });
    window.addEventListener('blur',hideCtxMenu);
    document.getElementById('gridWrap').addEventListener('scroll',hideCtxMenu,true);
    // Title member selection + chip edit menus (event delegation on the zones)
    document.querySelector('.app').addEventListener('change',e=>{
        const sel=e.target.closest('.title-select');
        if(sel){ const d=S.dims.get(sel.dataset.dim); if(d){ d.selIndex=+sel.value; reload(); } }
    });
    document.querySelector('.app').addEventListener('click',e=>{
        const exp=e.target.closest('.title-expand');
        if(exp&&exp.dataset.expandTitle){ const d=S.dims.get(exp.dataset.expandTitle); if(d){ const cur=d.members[d.selIndex]||d.members[0]; if(cur)toggleExpand(d.name,cur.name); } return; }
        const menu=e.target.closest('.chip-menu');
        if(menu&&menu.dataset.edit){ const d=S.dims.get(menu.dataset.edit); if(d)editDim(d); }
    });
    document.getElementById('swapBtn').addEventListener('click',()=>{ const tmp=S.rows; S.rows=S.cols; S.cols=tmp; renderTitles(); ensureMembersLoaded(()=>reload()); });
    document.getElementById('suppressRowsBtn').addEventListener('click',()=>{ S.suppressRows=!S.suppressRows; document.getElementById('suppressRowsBtn').classList.toggle('active',S.suppressRows); reload(); });
    document.getElementById('suppressColsBtn').addEventListener('click',()=>{ S.suppressCols=!S.suppressCols; document.getElementById('suppressColsBtn').classList.toggle('active',S.suppressCols); reload(); });
    document.getElementById('refreshBtn').addEventListener('click',reload);
    document.getElementById('exportBtn').addEventListener('click',exportCsv);
    function csvCell(v){ v=(v==null?'':String(v)); return /[",\\n]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v; }
    function cleanCell(v){
        v = (v==null?'':String(v)).replace(/[\\r\\n\\t]+/g,' ');
        // Drop the expand/collapse triangle glyphs shown on consolidated members.
        v = v.replace(/[\\u25B6\\u25BC\\u25B8\\u25BE\\u25BA\\u25BD\\u25C0\\u25C2\\u25B4\\u25B5\\u25B2\\u25BC]/g,' ').replace(/\\s+/g,' ').trim();
        // Accounting negatives shown as (1,234) become -1,234.
        const m = v.match(/^\\((.+)\\)$/);
        if(m && /\\d/.test(m[1])){ v = '-' + m[1].trim(); }
        // Strip thousands separators from grouped numbers (e.g. 660,104,426 -> 660104426).
        if(/^-?[\\$\\u20AC\\u00A3]?\\d{1,3}(,\\d{3})+(\\.\\d+)?%?$/.test(v)){ v = v.replace(/,/g,''); }
        return v;
    }
    function tableToCsv(table){
        if(!table){ return ''; }
        const rows = Array.from(table.rows);
        const out = []; const carry = [];
        for(let r=0;r<rows.length;r++){
            const line = []; let c = 0; const cells = Array.from(rows[r].cells); let ci = 0;
            while(true){
                if(carry[c] && carry[c].rem>0){ line[c]=carry[c].text; carry[c].rem--; c++; continue; }
                if(ci>=cells.length){ break; }
                const cell = cells[ci++];
                const text = cleanCell(cell.textContent);
                const cs = cell.colSpan||1, rs = cell.rowSpan||1;
                for(let k=0;k<cs;k++){ line[c]=text; if(rs>1){ carry[c]={text:text,rem:rs-1}; } c++; }
            }
            out.push(line);
        }
        const width = out.reduce(function(m,l){ return Math.max(m,l.length); },0);
        return out.map(function(l){ const row=[]; for(let i=0;i<width;i++){ row.push(csvCell(l[i]==null?'':l[i])); } return row.join(','); }).join('\\n');
    }
    function exportCsv(){
        const csv = tableToCsv(document.getElementById('pivot'));
        if(!csv){ setStatus('Nothing to export yet.'); return; }
        const t = document.getElementById('cubeTitle');
        post('exportCsv', { csv: csv, name: (t ? t.textContent : 'cube') });
    }
    document.getElementById('saveViewBtn').addEventListener('click',()=>{ if(S.rows.length===0&&S.cols.length===0){setStatus('Add dimensions to rows/columns before saving.');return;} post('saveView',{mdx:getMDXStatement()}); });
    document.getElementById('openViewBtn').addEventListener('click',()=>post('pickView',{}));
    document.getElementById('mdxBtn').addEventListener('click',()=>toggleMdxDock());
    document.getElementById('mdxDockClose').addEventListener('click',()=>closeMdxDock());
    document.getElementById('mdxUndoBtn').addEventListener('click',()=>undoMdx());
    document.getElementById('mdxRedoBtn').addEventListener('click',()=>redoMdx());
    document.getElementById('mdxFormatBtn').addEventListener('click',()=>{ const t=document.getElementById('mdxText'); t.value=formatMDX(t.value); histRecord(); });
    document.getElementById('mdxMinifyBtn').addEventListener('click',()=>{ const t=document.getElementById('mdxText'); t.value=minifyMDX(t.value); histRecord(); });
    document.getElementById('mdxCopyBtn').addEventListener('click',()=>post('copyMdx',{mdx:document.getElementById('mdxText').value}));
    document.getElementById('mdxApplyBtn').addEventListener('click',()=>applyMdx());
    document.getElementById('mdxSaveBtn').addEventListener('click',()=>{ const mdx=document.getElementById('mdxText').value.trim(); if(!mdx){return;} post('saveView',{mdx}); });
    document.getElementById('mdxBuildToggle').addEventListener('click',()=>toggleBuild());
    setupMdxEditor();
    setupDnd();
}
var _mbStarted=false;
var _mbUserTouched=false;
function buildLayoutHint(){
    const hint={ cols:S.cols.slice(), rows:S.rows.slice(), titles:S.titles.slice(), members:{}, titleMembers:{}, hierarchies:{} };
    const axisDims=[...S.cols, ...S.rows];
    for(const dn of axisDims){ const d=S.dims.get(dn); if(!d){ continue; } if(d.hierarchy){ hint.hierarchies[dn]=d.hierarchy; } if(d.members&&d.members.length){ hint.members[dn]=d.members.map(m=>m.name); } }
    for(const dn of S.titles){ const d=S.dims.get(dn); if(!d){ continue; } if(d.hierarchy){ hint.hierarchies[dn]=d.hierarchy; } const m=d.members&&(d.members[d.selIndex]||d.members[0]); if(m){ hint.titleMembers[dn]=m.name; } }
    return hint;
}
function toggleBuild(){
    const pane=document.getElementById('mdxBuildPane');
    const btn=document.getElementById('mdxBuildToggle');
    const open=pane.classList.toggle('open');
    btn.classList.toggle('active',open);
    if(open && !_mbStarted && typeof mbInit==='function'){
        _mbStarted=true;
        window.__mbLayoutHint=buildLayoutHint();
        mbInit({ mode:'view', cube: window.__builderCube || '' });
    }
}
let _mbApplyTimer=null;
function scheduleBuilderApply(){
    if(_mbApplyTimer){ clearTimeout(_mbApplyTimer); }
    _mbApplyTimer=setTimeout(()=>{ applyMdx(); }, 600);
}

function toggleMdxDock(){
    const split=document.getElementById('split');
    if(split.classList.contains('mdx-open')){ closeMdxDock(); return; }
    document.getElementById('mdxText').value=formatMDX(getMDXStatement());
    histReset(document.getElementById('mdxText').value);
    split.classList.add('mdx-open');
    renderFnList();
    renderSnList();
}
function closeMdxDock(){ document.getElementById('split').classList.remove('mdx-open'); }
function applyMdx(){
    const mdx=document.getElementById('mdxText').value.trim();
    if(!mdx){ return; }
    S.reconstructNext=true; S.queryAxisCount=countQueryAxes(mdx)||1; S.execSeq++; setStatus('Executing edited MDX…');
    post('execute',{mdx,requestId:S.execSeq});
}
// Count the ON axes (ON COLUMNS/ROWS or ON <n>) so reconstruct knows how many
// query axes exist vs. TM1's trailing slicer/context axis.
function countQueryAxes(mdx){ const m=String(mdx||'').match(/\\bON\\s+(COLUMNS|ROWS|\\d+)/gi); return m?m.length:0; }
let _mdxAutoTimer=null;
function scheduleAutoApply(){
    const auto=document.getElementById('mdxAuto');
    if(!auto||!auto.checked){ return; }
    if(_mdxAutoTimer){ clearTimeout(_mdxAutoTimer); }
    _mdxAutoTimer=setTimeout(()=>{ applyMdx(); }, 700);
}
function insertAtCursor(tpl){
    const ta=document.getElementById('mdxText');
    let text=String(tpl);
    let caret=text.indexOf('§');
    if(caret>=0){ text=text.replace('§',''); } else { caret=text.length; }
    const start=ta.selectionStart||0, end=ta.selectionEnd||0;
    const before=ta.value.slice(0,start), after=ta.value.slice(end);
    ta.value=before+text+after;
    const pos=start+caret;
    ta.focus(); ta.setSelectionRange(pos,pos);
    histRecord();
    scheduleAutoApply();
}
// ---- Undo/redo history for the MDX editor (native undo breaks on programmatic edits) ----
var _mdxHist={ stack:[], idx:-1, applying:false, timer:null };
function histReset(val){ _mdxHist.stack=[val==null?'':val]; _mdxHist.idx=0; updateUndoButtons(); }
function histRecord(){
    if(_mdxHist.applying){ return; }
    if(_mdxHist.timer){ clearTimeout(_mdxHist.timer); _mdxHist.timer=null; }
    const val=document.getElementById('mdxText').value;
    if(_mdxHist.idx>=0 && _mdxHist.stack[_mdxHist.idx]===val){ return; }
    _mdxHist.stack=_mdxHist.stack.slice(0,_mdxHist.idx+1);
    _mdxHist.stack.push(val);
    if(_mdxHist.stack.length>200){ _mdxHist.stack.shift(); }
    _mdxHist.idx=_mdxHist.stack.length-1;
    updateUndoButtons();
}
function histRecordSoon(){ if(_mdxHist.timer){ clearTimeout(_mdxHist.timer); } _mdxHist.timer=setTimeout(histRecord, 400); }
function histRestore(){
    _mdxHist.applying=true;
    document.getElementById('mdxText').value=_mdxHist.stack[_mdxHist.idx]||'';
    _mdxHist.applying=false;
    updateUndoButtons();
    scheduleAutoApply();
}
function undoMdx(){ histRecord(); if(_mdxHist.idx>0){ _mdxHist.idx--; histRestore(); } }
function redoMdx(){ if(_mdxHist.idx<_mdxHist.stack.length-1){ _mdxHist.idx++; histRestore(); } }
function updateUndoButtons(){
    const u=document.getElementById('mdxUndoBtn'), r=document.getElementById('mdxRedoBtn');
    if(u){ u.disabled=_mdxHist.idx<=0; }
    if(r){ r.disabled=_mdxHist.idx>=_mdxHist.stack.length-1; }
}
function setupMdxEditor(){
    const search=document.getElementById('fnSearch');
    if(search){ search.addEventListener('input',()=>renderFnList(search.value)); }
    const ta=document.getElementById('mdxText');
    if(ta){
        ta.addEventListener('input',()=>{ histRecordSoon(); scheduleAutoApply(); });
        ta.addEventListener('keydown',e=>{
            const ctrl=e.ctrlKey||e.metaKey;
            if(ctrl && !e.shiftKey && (e.key==='z'||e.key==='Z')){ e.preventDefault(); undoMdx(); }
            else if(ctrl && ((e.key==='y'||e.key==='Y') || (e.shiftKey && (e.key==='z'||e.key==='Z')))){ e.preventDefault(); redoMdx(); }
        });
    }
    const bp=document.getElementById('mdxBuildPane');
    if(bp){ ['input','change','click'].forEach(function(ev){ bp.addEventListener(ev,function(){ _mbUserTouched=true; }, true); }); }
    const heads=document.querySelectorAll('.mdx-sec-head');
    for(let i=0;i<heads.length;i++){
        heads[i].addEventListener('click',()=>{
            const sec=heads[i].getAttribute('data-sec');
            const body=document.getElementById(sec==='fn'?'fnBody':'snBody');
            const caret=heads[i].querySelector('.mdx-caret');
            const open=body.style.display!=='none';
            body.style.display=open?'none':'block';
            if(caret){ caret.textContent=open?'▸':'▾'; }
        });
    }
    setupResizer();
}
function setupResizer(){
    const grip=document.getElementById('mdxResizer');
    const dock=document.getElementById('mdxDock');
    if(!grip||!dock){ return; }
    let startX=0, startW=0, dragging=false;
    grip.addEventListener('mousedown',e=>{
        dragging=true; startX=e.clientX; startW=dock.getBoundingClientRect().width;
        grip.classList.add('dragging'); document.body.style.userSelect='none';
        e.preventDefault();
    });
    window.addEventListener('mousemove',e=>{
        if(!dragging){ return; }
        const w=Math.max(340, Math.min(window.innerWidth*0.85, startW+(startX-e.clientX)));
        dock.style.width=w+'px';
    });
    window.addEventListener('mouseup',()=>{
        if(!dragging){ return; }
        dragging=false; grip.classList.remove('dragging'); document.body.style.userSelect='';
    });
}
var _fnCatOpen={};
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function renderFnList(filter){
    const host=document.getElementById('fnList');
    if(!host||!window.MDX_FUNCTIONS){ return; }
    const q=(filter||'').trim().toLowerCase();
    const searching=q.length>0;
    let html='';
    const cats=window.MDX_FUNCTIONS;
    for(let c=0;c<cats.length;c++){
        const cat=cats[c];
        const fns=cat.funcs.filter(f=>!q || f.name.toLowerCase().indexOf(q)>=0 || (f.desc||'').toLowerCase().indexOf(q)>=0);
        if(fns.length===0){ continue; }
        const open=searching || !!_fnCatOpen[c];
        html+='<div class="fn-cat"><div class="fn-cat-head" data-cat="'+c+'"><span class="fn-cat-caret">'+(open?'▾':'▸')+'</span>'+esc(cat.name)+'<span class="fn-cat-count">'+fns.length+'</span></div>';
        html+='<div class="fn-cat-items" data-body="'+c+'"'+(open?'':' style="display:none;"')+'>';
        for(let i=0;i<fns.length;i++){
            const f=fns[i];
            html+='<div class="fn-item" data-c="'+c+'" data-i="'+cat.funcs.indexOf(f)+'" title="'+esc(f.desc||'')+'"><span class="fn-name">'+esc(f.name)+'</span><span class="fn-syn">'+esc(f.syntax||'')+'</span></div>';
        }
        html+='</div></div>';
    }
    host.innerHTML=html||'<div class="mdx-hint">No matching functions.</div>';
    const catHeads=host.querySelectorAll('.fn-cat-head');
    for(let k=0;k<catHeads.length;k++){
        catHeads[k].addEventListener('click',()=>{
            const c=catHeads[k].getAttribute('data-cat');
            const body=host.querySelector('.fn-cat-items[data-body="'+c+'"]');
            const caret=catHeads[k].querySelector('.fn-cat-caret');
            const isOpen=body.style.display!=='none';
            body.style.display=isOpen?'none':'block';
            if(caret){ caret.textContent=isOpen?'▸':'▾'; }
            if(!searching){ _fnCatOpen[c]=!isOpen; }
        });
    }
    const items=host.querySelectorAll('.fn-item');
    for(let k=0;k<items.length;k++){
        items[k].addEventListener('click',()=>{
            const c=+items[k].getAttribute('data-c'), i=+items[k].getAttribute('data-i');
            const f=window.MDX_FUNCTIONS[c].funcs[i];
            insertAtCursor(f.insert||f.name);
        });
    }
}
function renderSnList(){
    const host=document.getElementById('snList');
    if(!host||!window.MDX_SNIPPETS){ return; }
    let html='';
    for(let i=0;i<window.MDX_SNIPPETS.length;i++){
        const s=window.MDX_SNIPPETS[i];
        html+='<div class="sn-item" data-i="'+i+'"><div class="sn-name">'+esc(s.name)+'</div><div class="sn-desc">'+esc(s.desc||'')+'</div></div>';
    }
    host.innerHTML=html;
    const items=host.querySelectorAll('.sn-item');
    for(let k=0;k<items.length;k++){
        items[k].addEventListener('click',()=>{
            const s=window.MDX_SNIPPETS[+items[k].getAttribute('data-i')];
            insertAtCursor(s.mdx);
        });
    }
}

// ---- Messages ----
window.addEventListener('message',ev=>{
    const m=ev.data;
    switch(m.command){
        case 'cubeMeta':{
            S.cube=m.cube; S.view=m.view;
            S.isAdmin=!!m.isAdmin;
            document.getElementById('cubeTitle').textContent=m.cube+(m.view?(' — '+m.view):'');
            S.dims=new Map();
            for(const d of m.dimensions){ S.dims.set(d.name,{name:d.name,hierarchy:d.hierarchy,members:[],selIndex:0,expanded:false,alias:'',aliasMap:null}); }
            if(S.view){
                // Load the actual saved view instead of a default layout
                setStatus('Loading view '+S.view+'…');
                post('executeView');
            } else {
                // Default layout: last dim -> columns, second-to-last -> rows, rest -> titles
                const names=m.dimensions.map(d=>d.name);
                S.cols = names.length>=1?[names[names.length-1]]:[];
                S.rows = names.length>=2?[names[names.length-2]]:[];
                S.titles = names.slice(0, Math.max(0,names.length-2));
                renderTitles();
                ensureMembersLoaded(()=>reload());
            }
            break;
        }
        case 'viewStructure':{
            buildLayoutFromStructure(m.structure||{});
            break;
        }
        case 'viewCellset':{
            if(!m.data){ // fall back to default layout
                const names=Array.from(S.dims.keys());
                S.cols = names.length>=1?[names[names.length-1]]:[];
                S.rows = names.length>=2?[names[names.length-2]]:[];
                S.titles = names.slice(0, Math.max(0,names.length-2));
                renderTitles(); ensureMembersLoaded(()=>reload());
                break;
            }
            reconstructFromView(m.data);
            break;
        }
        case 'initialMembers':{
            const d=S.dims.get(m.dimension);
            if(d){ d.members=(m.members||[]).map(x=>({name:x.Name,type:normType(x.Type),level:x.Level,depth:0,expanded:false})); d.selIndex=0; }
            renderTitles();
            if(S._pendingLoads){ S._pendingLoads--; if(S._pendingLoads===0){ const cb=S._afterLoad; S._afterLoad=null; cb&&cb(); } }
            break;
        }
        case 'children':{
            const d=S.dims.get(m.dimension);
            if(!d)break;
            const idx=d.members.findIndex(x=>x.name===m.element);
            if(idx<0)break;
            const parent=d.members[idx];
            if(parent._pendingReq!==m.requestId)break;
            const kids=(m.children||[]).map(x=>({name:x.Name,type:normType(x.Type),level:x.Level,depth:parent.depth+1,expanded:false}));
            d.members.splice(idx+1,0,...kids);
            parent.expanded=true; parent._pendingReq=null;
            renderTitles();
            reload();
            break;
        }
        case 'cellset':{
            if(m.requestId!==S.execSeq)break;
            if(S.reconstructNext){ S.reconstructNext=false; reconstructFromView(m.data); setStatus('Applied edited MDX.'); }
            else renderGrid(m.data);
            break;
        }
        case 'cellWritten':{
            setStatus('Saved. Refreshing…');
            reload();
            break;
        }
        case 'setDimensionMembers':{
            const d=S.dims.get(m.dimension);
            if(d){
                d.members=(m.members||[]).map(x=>{
                    if(typeof x==='string')return {name:x,type:1,level:0,depth:0,expanded:false};
                    return {name:x.name,type:normType(x.type),level:x.level||0,depth:0,expanded:false};
                });
                d.selIndex=0;
                d.alias=m.alias||'';
                d.aliasMap=null;
                if(d.alias){ post('getAliasValues',{dimension:d.name,hierarchy:d.hierarchy,alias:d.alias}); }
                renderTitles();
                reload();
                setStatus('Applied '+(m.members||[]).length+' members to '+m.dimension+(d.alias?(' (alias '+d.alias+')'):'')+'.');
            }
            break;
        }
        case 'aliasValues':{
            const d=S.dims.get(m.dimension);
            if(d && d.alias===m.alias){
                d.aliasMap=m.map||{};
                renderTitles();
                if(S.lastCellset)renderGrid(S.lastCellset);
            }
            break;
        }
        case 'elementTypes':{
            const d=S.dims.get(m.dimension);
            if(d && d.members){
                const map=m.map||{};
                for(const mem of d.members){ if(map[mem.name]!=null) mem.type=normType(map[mem.name]); }
                if(S.lastCellset)renderGrid(S.lastCellset);
            }
            break;
        }
        case 'error':{ setStatus('Error: '+m.message); if(S.lastCellset)renderGrid(S.lastCellset); break; }
        case 'viewSaved':{ setStatus("View '"+m.name+"' saved."); break; }
        case 'builderCube':{ window.__builderCube=m.cube||''; break; }
        case 'mdxResult':{
            const ta=document.getElementById('mdxText');
            if(ta && typeof m.mdx==='string' && _mbUserTouched){ ta.value=formatMDX(m.mdx); histRecord(); if(/select/i.test(m.mdx)){ scheduleBuilderApply(); } }
            break;
        }
        case 'mdxFromWizard':{
            if(!document.getElementById('split').classList.contains('mdx-open')){ toggleMdxDock(); }
            if(m.mode==='view'){
                const ta=document.getElementById('mdxText');
                ta.value=formatMDX(m.mdx||''); ta.focus();
                histRecord();
                setStatus('Loaded MDX view from Wizard.');
                scheduleAutoApply();
            } else {
                insertAtCursor(m.mdx||'');
                setStatus('Inserted MDX from Wizard.');
            }
            break;
        }
    }
});

init();
`;
}

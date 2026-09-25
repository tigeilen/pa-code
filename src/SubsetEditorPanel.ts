import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';
import { mdxBuilderStyles, mdxBuilderHtml, mdxBuilderScript } from './MDXWizardPanel';
import { handleMdxBuilderBackend } from './MDXBuilder';
import { MDX_FUNCTIONS, MDX_SNIPPETS } from './MDXFunctions';

/**
 * PAW-style Subset / Dimension editor as a webview panel.
 * Two-column layout: "Available members" (tree) on the left, "Current set"
 * on the right. Supports alias switching, attribute columns, filter flyout,
 * MDX generation/editing and saving public/private subsets.
 */
export class SubsetEditorPanel {
    private static panels: Map<string, SubsetEditorPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private _key: string = '';
    private _initial?: { dimension?: string; hierarchy?: string; subset?: string; members?: string[] };
    private _onApply?: (payload: { members: any[]; alias?: string }) => void;

    private constructor(panel: vscode.WebviewPanel, instanceName: string, initial?: { dimension?: string; hierarchy?: string; subset?: string; members?: string[] }, onApply?: (payload: { members: any[]; alias?: string }) => void) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._initial = initial;
        this._onApply = onApply;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(async msg => {
            const tm1 = TM1Service.getInstance();
            try {
                switch (msg.command) {
                    case 'getDimensions': {
                        const dims = await tm1.getDimensions(this._instanceName);
                        this._post('dimensions', { dimensions: dims.map(d => d.Name) });
                        if (this._onApply) {
                            this._post('enablePicker', {});
                        }
                        if (this._initial && this._initial.dimension) {
                            this._post('preselect', {
                                dimension: this._initial.dimension,
                                hierarchy: this._initial.hierarchy || '',
                                subset: this._initial.subset || '',
                                members: this._initial.members || []
                            });
                            this._initial = undefined;
                        }
                        break;
                    }
                    case 'applyToCaller': {
                        if (this._onApply) {
                            this._onApply({ members: msg.members || [], alias: msg.alias || '' });
                            vscode.window.showInformationMessage(`Applied ${(msg.members || []).length} members to the Cube Viewer.`);
                        }
                        this.dispose();
                        break;
                    }
                    case 'getHierarchies': {
                        const hiers = await tm1.getHierarchies(this._instanceName, msg.dimension);
                        this._post('hierarchies', { dimension: msg.dimension, hierarchies: hiers.map(h => h.Name) });
                        break;
                    }
                    case 'getSubsets': {
                        const subsets = await tm1.getHierarchySubsets(this._instanceName, msg.dimension, msg.hierarchy);
                        this._post('subsets', { subsets: subsets.map(s => s.Name) });
                        break;
                    }
                    case 'loadHierarchy': {
                        const data = await tm1.getSubsetEditorData(this._instanceName, msg.dimension, msg.hierarchy);
                        this._post('hierarchyData', {
                            dimension: msg.dimension,
                            hierarchy: msg.hierarchy,
                            ...data
                        });
                        break;
                    }
                    case 'loadSubset': {
                        const content = await tm1.getSubsetContent(this._instanceName, msg.dimension, msg.hierarchy, msg.subset, !!msg.isPrivate);
                        this._post('subsetContent', { subset: msg.subset, ...content });
                        break;
                    }
                    case 'resolveMDX': {
                        try {
                            const members = await tm1.executeMDXSet(this._instanceName, msg.mdx, msg.dimension);
                            this._post('mdxResolved', { members, requestId: msg.requestId });
                        } catch (err: any) {
                            this._post('mdxResolved', { error: err.message, requestId: msg.requestId });
                        }
                        break;
                    }
                    case 'saveSubset': {
                        await tm1.saveSubset(this._instanceName, msg.dimension, msg.hierarchy, msg.name, !!msg.isPublic, {
                            mdx: msg.mdx || undefined,
                            elements: msg.elements || []
                        });
                        vscode.window.showInformationMessage(
                            `Subset '${msg.name}' saved (${msg.isPublic ? 'Public' : 'Private'}).`);
                        this._post('subsetSaved', { name: msg.name });
                        // Refresh subset list
                        const subsets = await tm1.getHierarchySubsets(this._instanceName, msg.dimension, msg.hierarchy);
                        this._post('subsets', { subsets: subsets.map(s => s.Name) });
                        break;
                    }
                    default: {
                        // Embedded MDX Builder (Subset Builder) data/generate commands.
                        const reply = await handleMdxBuilderBackend(this._instanceName, msg);
                        if (reply) { this._post(reply.command, reply.data); }
                        break;
                    }
                }
            } catch (err: any) {
                this._post('error', { message: err.message });
                vscode.window.showErrorMessage(`Subset Editor: ${err.message}`);
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string, initial?: { dimension?: string; hierarchy?: string; subset?: string; members?: string[] }, onApply?: (payload: { members: any[]; alias?: string }) => void) {
        // One panel per (instance, dimension) so multiple dimensions can be open at once.
        const key = instanceName + '|' + ((initial && initial.dimension) || '');
        const existing = SubsetEditorPanel.panels.get(key);
        if (existing) {
            existing._panel.reveal(vscode.ViewColumn.One);
            if (onApply) { existing._onApply = onApply; existing._post('enablePicker', {}); }
            if (initial && initial.dimension) {
                existing._post('preselect', {
                    dimension: initial.dimension,
                    hierarchy: initial.hierarchy || '',
                    subset: initial.subset || '',
                    members: initial.members || []
                });
            }
            return;
        }
        const dimSuffix = (initial && initial.dimension) ? ` — ${initial.dimension}` : '';
        const panel = vscode.window.createWebviewPanel(
            'tm1SubsetEditor', `Subset Editor${dimSuffix} (${instanceName})`, vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        const p = new SubsetEditorPanel(panel, instanceName, initial, onApply);
        p._key = key;
        SubsetEditorPanel.panels.set(key, p);
    }

    /** Closes all Subset Editor tabs bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string) {
        for (const p of Array.from(SubsetEditorPanel.panels.values())) {
            if (p._instanceName === instanceName) { p._panel.dispose(); }
        }
    }

    private dispose() {
        SubsetEditorPanel.panels.delete(this._key);
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) d.dispose(); }
    }

    private _post(command: string, data: any) {
        this._panel.webview.postMessage({ command, ...data });
    }

    private _getWebviewContent(): string {
        return SUBSET_EDITOR_HTML;
    }
}

const SUBSET_EDITOR_HTML = /* html */ `<!DOCTYPE html>
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
    --list-active: var(--vscode-list-activeSelectionBackground, #094771);
    --list-active-fg: var(--vscode-list-activeSelectionForeground, #fff);
    --desc: var(--vscode-descriptionForeground, #999);
}
* { box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    padding: 0;
    height: 100vh;
    overflow: hidden;
}
.app { display: flex; flex-direction: column; height: 100vh; }

/* ---- Top toolbar ---- */
.toolbar { padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.toolbar-row { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 8px; }
.toolbar-row:last-child { margin-bottom: 0; }
.field { display: flex; flex-direction: column; gap: 3px; }
.field label { font-size: 11px; color: var(--desc); }
select, input[type=text] {
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 2px;
    padding: 4px 6px; font-size: 13px; min-width: 150px;
}
input[type=text] { min-width: 120px; }
button {
    background: var(--btn-bg); color: var(--btn-fg); border: none;
    border-radius: 2px; padding: 5px 10px; cursor: pointer; font-size: 12px;
}
button:hover { background: var(--btn-hover); }
button.secondary { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
button.icon-btn {
    background: transparent; color: var(--fg); padding: 4px 6px;
    border: 1px solid transparent; border-radius: 3px; min-width: 0;
}
button.icon-btn:hover { background: var(--list-hover); }
button.icon-btn.active { background: var(--list-active); color: var(--list-active-fg); }
.spacer { flex: 1; }

/* ---- Two-column body ---- */
.body { flex: 1; display: flex; min-height: 0; }
.column { flex: 1; display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--border); }
.column:last-child { border-right: none; }
.col-header {
    display: flex; align-items: center; gap: 6px; padding: 6px 10px;
    border-bottom: 1px solid var(--border); font-weight: 600; flex-shrink: 0;
}
.col-header .count { font-weight: normal; color: var(--desc); font-size: 11px; }
.col-toolbar {
    display: flex; align-items: center; gap: 4px; padding: 4px 8px;
    border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.search-box { position: relative; flex: 1; }
.search-box input { width: 100%; min-width: 0; padding-left: 24px; }
.search-box::before {
    content: '🔍'; position: absolute; left: 6px; top: 50%; transform: translateY(-50%);
    font-size: 11px; opacity: 0.6;
}
.list-wrap { flex: 1; overflow: auto; position: relative; }
.list-inner { position: relative; }

/* ---- Transfer buttons in the middle ---- */
.transfer { display: flex; flex-direction: column; justify-content: center; gap: 6px; padding: 0 6px; flex-shrink: 0; }
.transfer button { min-width: 30px; padding: 6px 4px; }

/* ---- Tree/list rows ---- */
.row {
    display: grid; align-items: center; height: 24px; padding-right: 8px;
    white-space: nowrap; cursor: default; user-select: none;
    grid-template-columns: minmax(0, 1fr);
}
.row:hover { background: var(--list-hover); }
.row.selected { background: var(--list-active); color: var(--list-active-fg); }
.row .name-cell { display: flex; align-items: center; min-width: 0; overflow: hidden; }
.row .twisty {
    width: 16px; text-align: center; cursor: pointer; flex-shrink: 0;
    font-size: 10px; opacity: 0.8; transition: transform 0.1s;
}
.row .twisty.empty { visibility: hidden; }
.row .twisty.expanded { transform: rotate(90deg); }
.row .elem-icon { width: 18px; text-align: center; flex-shrink: 0; font-size: 12px; }
.row .elem-icon.c { color: #4ec9b0; font-weight: bold; }
.row .elem-icon.n { color: #569cd6; }
.row .elem-icon.s { color: #ce9178; }
.row .elem-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.row .attr-cell {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--desc); padding-left: 12px; border-left: 1px solid var(--border);
}
.row .weight-badge {
    flex-shrink: 0; margin-left: 6px; font-size: 10px; line-height: 15px; padding: 0 5px;
    border-radius: 8px; background: var(--vscode-badge-background, #4d4d4d);
    color: var(--vscode-badge-foreground, #fff); font-variant-numeric: tabular-nums;
}
.row .weight-cell {
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right;
    padding: 0 8px; color: var(--desc); border-left: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
}
.row.dragging { opacity: 0.5; }
.list-wrap.drop-target { outline: 2px dashed var(--accent); outline-offset: -2px; }

/* ---- Filter flyout ---- */
.flyout {
    position: absolute; z-index: 50; background: var(--bg);
    border: 1px solid var(--border); border-radius: 4px; padding: 12px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4); min-width: 420px; display: none;
}
.flyout.open { display: block; }
.flyout h4 { margin: 0 0 8px; }
.match-mode { display: flex; gap: 16px; margin-bottom: 10px; }
.match-mode label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.cond-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.cond-row select, .cond-row input { min-width: 0; flex: 1; }
.cond-row .remove { flex: 0; color: var(--desc); cursor: pointer; padding: 0 6px; }
.flyout-actions { display: flex; justify-content: space-between; margin-top: 10px; }
.link-btn { background: none; color: var(--accent); padding: 0; }
.link-btn:hover { background: none; text-decoration: underline; }

/* ---- Modal (MDX / Save) ---- */
.modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    display: none; align-items: center; justify-content: center; z-index: 100;
}
.modal-overlay.open { display: flex; }
.modal {
    background: var(--bg); border: 1px solid var(--border); border-radius: 6px;
    padding: 16px; min-width: 520px; max-width: 80vw;
}
.modal h3 { margin: 0 0 12px; }
.modal textarea {
    width: 100%; height: 220px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 2px; padding: 8px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; resize: vertical;
}
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.toggle-line { display: flex; align-items: center; gap: 8px; margin: 10px 0; }
.status { padding: 4px 12px; font-size: 11px; color: var(--desc); border-top: 1px solid var(--border); flex-shrink: 0; }
.hidden { display: none !important; }

/* ---- MDX split-view dock (shared style with the Cube Viewer) ---- */
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
.mdx-dock textarea#mdxText { flex: 1 1 auto; margin: 8px 10px 0; min-height: 200px; resize: none; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-border); border-radius: 4px; padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; line-height: 1.5; tab-size: 2; }
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
#mdxBuildPane { display: none; flex: 0 1 auto; max-height: 55%; overflow: auto; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
#mdxBuildPane.open { display: block; }
#mdxBuildPane .mdxb { height: auto; display: block; }
#mdxBuildPane .mode-tabs { display: none; }
#mdxBuildPane .main { display: block; overflow: visible; }
#mdxBuildPane .config-panel { border-right: none; overflow: visible; padding: 10px; min-width: 0; }
#mdxBuildPane .preview-panel { display: none; }
#mdxBuildPane .mdxb select, #mdxBuildPane .mdxb input[type="text"] { min-width: 0; }
#mdxBuildToggle.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }

/* Embedded MDX Builder (shared with the MDX Wizard) */
${mdxBuilderStyles()}
</style>
</head>
<body>
<div class="split" id="split">
<div class="app">
    <!-- TOP TOOLBAR -->
    <div class="toolbar">
        <div class="toolbar-row">
            <div class="field">
                <label>Dimension</label>
                <select id="dimSel"></select>
            </div>
            <div class="field">
                <label>Hierarchy</label>
                <select id="hierSel"></select>
            </div>
            <div class="field">
                <label>Subset</label>
                <select id="subsetSel"><option value="">— New —</option></select>
            </div>
            <button class="secondary" id="loadBtn">Load</button>
            <div class="spacer"></div>
            <div class="field">
                <label>Display as</label>
                <select id="aliasSel"><option value="">Member ID</option></select>
            </div>
            <button class="icon-btn" id="attrToggle" title="Show attributes">👁 Show attributes</button>
            <button class="icon-btn" id="attrPickBtn" title="Choose which attributes to show">▾</button>
            <button class="icon-btn" id="weightToggle" title="Show consolidation weight for every child">⚖ Weights</button>
            <button class="secondary" id="mdxBtn" title="View / edit MDX">MDX</button>
            <button id="saveBtn" title="Save subset">Save as…</button>
            <button id="usePickerBtn" class="hidden" title="Send the current set back to the Cube Viewer">Use in Cube View</button>
        </div>
    </div>

    <!-- TWO COLUMNS -->
    <div class="body">
        <!-- AVAILABLE -->
        <div class="column">
            <div class="col-header">Available members <span class="count" id="availCount"></span></div>
            <div class="col-toolbar">
                <div class="search-box"><input type="text" id="availSearch" placeholder="Search available members…"></div>
                <button class="icon-btn" id="availFilterBtn" title="Filter">▽</button>
                <button class="icon-btn" id="expandAllBtn" title="Expand all">⊞</button>
                <button class="icon-btn" id="collapseAllBtn" title="Collapse all">⊟</button>
            </div>
            <div class="list-wrap" id="availWrap">
                <div class="list-inner" id="availInner"></div>
            </div>
        </div>

        <!-- TRANSFER -->
        <div class="transfer">
            <button id="addBtn" title="Insert member only">▶</button>
            <button id="addChildrenBtn" title="Insert with children">⏵⏵</button>
            <button id="addVisibleBtn" title="Add all currently displayed members">⇉</button>
            <button id="addAllBtn" title="Add all available members">⏭</button>
            <button id="removeBtn" title="Remove">◀</button>
            <button id="removeAllBtn" title="Remove all">⏮</button>
        </div>

        <!-- CURRENT SET -->
        <div class="column">
            <div class="col-header">Current set <span class="count" id="setCount"></span></div>
            <div class="col-toolbar">
                <div class="search-box"><input type="text" id="setSearch" placeholder="Search selected members…"></div>
                <button class="icon-btn" id="setKeepBtn" title="Keep only selected">✓</button>
                <button class="icon-btn" id="setRemoveSelBtn" title="Remove selected">⊖</button>
                <button class="icon-btn" id="setUpBtn" title="Move up">▲</button>
                <button class="icon-btn" id="setDownBtn" title="Move down">▼</button>
                <button class="icon-btn" id="setSortBtn" title="Sort ascending">↕</button>
            </div>
            <div class="list-wrap" id="setWrap">
                <div class="list-inner" id="setInner"></div>
            </div>
        </div>
    </div>

    <div class="status" id="status">Select a dimension to begin.</div>
</div>

<aside class="mdx-dock" id="mdxDock">
    <div class="mdx-resizer" id="mdxResizer" title="Drag to resize"></div>
    <div class="mdx-dock-head">
        <span>Subset MDX</span>
        <button class="mdx-x" id="mdxDockClose" title="Close editor">✕</button>
    </div>
    <div class="mdx-tools">
        <button id="mdxApplyBtn" title="Resolve the MDX and load it into the current set">▶ Apply MDX</button>
        <button class="secondary" id="mdxUndoBtn" title="Undo the last change (Ctrl+Z)" disabled>↶ Undo</button>
        <button class="secondary" id="mdxRedoBtn" title="Redo (Ctrl+Y)" disabled>↷ Redo</button>
        <button class="secondary" id="mdxFormatBtn" title="Pretty-print the MDX across multiple lines">Format</button>
        <button class="secondary" id="mdxMinifyBtn" title="Collapse the MDX back onto a single line">Minify</button>
        <button class="secondary" id="mdxCopyBtn" title="Copy MDX to clipboard">Copy</button>
        <button class="secondary" id="mdxBuildToggle" title="Show the visual Subset Builder — it writes into this editor">🔧 Wizard</button>
        <label class="mdx-auto" title="Apply automatically as you type"><input type="checkbox" id="mdxAuto"> Live</label>
    </div>
    <textarea id="mdxText" spellcheck="false"></textarea>
    <div class="mdx-hint" id="mdxHint">Edit the subset MDX and click <b>Apply MDX</b> — the current set updates. Toggle <b>🔧 Wizard</b> to build the subset visually; it writes into this editor.</div>
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

<!-- FILTER FLYOUT -->
<div class="flyout" id="filterFlyout">
    <h4>Filters</h4>
    <div class="match-mode">
        <label><input type="radio" name="matchMode" value="all" checked> Match all of the following</label>
        <label><input type="radio" name="matchMode" value="any"> Match any of the following</label>
    </div>
    <div id="condRows"></div>
    <button class="link-btn" id="addCondBtn">Add +</button>
    <div class="flyout-actions">
        <button class="secondary" id="clearFilterBtn">Clear</button>
        <button id="applyFilterBtn">Apply</button>
    </div>
</div>

<!-- ATTRIBUTE PICKER FLYOUT -->
<div class="flyout" id="attrFlyout" style="min-width:240px;">
    <h4>Show attributes</h4>
    <input type="text" id="attrFilter" placeholder="Filter attributes…" style="width:100%; box-sizing:border-box; margin-bottom:6px; padding:4px 6px; background:var(--input-bg); color:var(--input-fg); border:1px solid var(--input-border); border-radius:3px;">
    <div id="attrList" style="max-height:280px; overflow-y:auto;"></div>
    <div class="flyout-actions">
        <button class="link-btn" id="attrAllBtn">All</button>
        <button class="link-btn" id="attrNoneBtn">None</button>
    </div>
</div>

<!-- SAVE MODAL -->
<div class="modal-overlay" id="saveModal">
    <div class="modal">
        <h3>Save subset as</h3>
        <div class="field">
            <label>Subset name</label>
            <input type="text" id="saveName" style="width:100%">
        </div>
        <div class="toggle-line">
            <input type="checkbox" id="savePublic">
            <label for="savePublic">Public (visible to all users). Unchecked = Private.</label>
        </div>
        <div class="toggle-line">
            <input type="checkbox" id="saveAsMdx">
            <label for="saveAsMdx">Save as dynamic (MDX) subset instead of static element list.</label>
        </div>
        <div class="modal-actions">
            <button class="secondary" id="saveCancelBtn">Cancel</button>
            <button id="saveConfirmBtn">Save</button>
        </div>
    </div>
</div>

<script>
window.MDX_FUNCTIONS = ${JSON.stringify(MDX_FUNCTIONS)};
window.MDX_SNIPPETS = ${JSON.stringify(MDX_SNIPPETS)};
</script>
<script>
${SUBSET_EDITOR_SCRIPT()}
</script>
<script>
${mdxBuilderScript()}
</script>
</body>
</html>`;

function SUBSET_EDITOR_SCRIPT(): string {
    return /* js */ `
const vscode = acquireVsCodeApi();
const ROW_H = 24;

// ---- State ----
let state = {
    dimension: '', hierarchy: '',
    elements: [],          // [{Name, Type, Level, Attributes}]
    elemMap: new Map(),    // Name -> element
    childrenMap: new Map(),// ParentName -> [ComponentName]
    parentMap: new Map(),  // ComponentName -> ParentName (first parent)
    roots: [],             // element names with no parent
    aliasAttributes: [],
    attributes: [],        // [{Name, Type}]
    currentAlias: '',
    showAttrs: false,
    selectedAttrs: null,   // Set of attribute names to show, or null = default (first 3)
    showWeights: false,    // PAW-style column: consolidation weight for every child
    expanded: new Set(),   // expanded consolidations (available tree)
    availFlat: [],         // flattened visible tree rows [{name, depth, hasChildren}]
    availSelected: new Set(),
    availFilter: null,     // resolved filter -> Set of allowed names or null
    availSearch: '',
    setMembers: [],        // ordered element names in current set
    setSelected: new Set(),
    setSearch: '',
    setExpanded: new Set(),// expanded consolidations in the current-set tree
    setDepthMap: new Map(),// name -> depth within the current-set tree
    setFlat: [],           // flattened visible current-set tree rows
    mdxRequestSeq: 0,
    pendingPreselect: null,
    pendingSubset: null,
    pendingMembers: null,
    lastAvailIdx: -1,
    lastSetIdx: -1
};

// ---- Helpers ----
function normType(t) {
    // TM1 returns Type as number (1=N,2=S,3=C) or string enum ("Numeric"/"String"/"Consolidated")
    if (typeof t === 'string') {
        const s = t.toLowerCase();
        if (s === 'consolidated') return 3;
        if (s === 'string') return 2;
        return 1;
    }
    return t;
}
function typeClass(t) { const n = normType(t); return n === 3 ? 'c' : (n === 2 ? 's' : 'n'); }
function typeIcon(t) { const n = normType(t); return n === 3 ? '∑' : (n === 2 ? 'S' : '◉'); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function display(name) {
    if (!state.currentAlias) return name;
    const el = state.elemMap.get(name);
    const v = el && el.Attributes ? el.Attributes[state.currentAlias] : null;
    return (v != null && v !== '') ? v : name;
}
function post(command, data) { vscode.postMessage(Object.assign({ command }, data || {})); }
function setStatus(t) { document.getElementById('status').textContent = t; }

// Consolidation weight of an element relative to its (first) parent, or null.
function weightOf(name) {
    const p = state.parentMap.get(name);
    if (p == null || !state.weightMap) return null;
    const w = state.weightMap.get(p + '\\u0000' + name);
    return (w == null) ? null : w;
}
// Badge markup for a non-default weight (weight !== 1); empty otherwise.
// Suppressed when the dedicated Weights column is shown (avoids duplication).
function weightBadge(name) {
    if (state.showWeights) return '';
    const w = weightOf(name);
    if (w == null || w === 1) return '';
    return '<span class="weight-badge" title="Consolidation weight (relative to parent)">' + esc(String(w)) + '</span>';
}
// Dedicated weight grid cell (PAW-style column); empty string when the column
// is off. Shows the weight for every child; blank for elements without a parent.
function weightCell(name) {
    if (!state.showWeights) return '';
    const w = weightOf(name);
    return '<span class="weight-cell" title="Consolidation weight (relative to parent)">' + (w == null ? '' : esc(String(w))) + '</span>';
}
// Grid template columns for a row: name + optional weight + attribute columns.
function gridTemplate(attrCols) {
    return 'minmax(120px,1.5fr)' + (state.showWeights ? ' 72px' : '') + attrCols.map(() => ' minmax(0,1fr)').join('');
}

// ---- Build tree structures ----
function buildTree(data) {
    state.elements = data.elements;
    state.elemMap = new Map();
    state.childrenMap = new Map();
    state.parentMap = new Map();
    state.weightMap = new Map();
    const hasParent = new Set();
    for (const el of data.elements) state.elemMap.set(el.Name, el);
    for (const edge of data.edges) {
        if (!state.childrenMap.has(edge.ParentName)) state.childrenMap.set(edge.ParentName, []);
        state.childrenMap.get(edge.ParentName).push(edge.ComponentName);
        // First parent wins (dimensions are usually single-parent)
        if (!state.parentMap.has(edge.ComponentName)) state.parentMap.set(edge.ComponentName, edge.ParentName);
        state.weightMap.set(edge.ParentName + '\\u0000' + edge.ComponentName, edge.Weight);
        hasParent.add(edge.ComponentName);
    }
    state.roots = data.elements.filter(el => !hasParent.has(el.Name)).map(el => el.Name);
    state.aliasAttributes = data.aliasAttributes || [];
    state.attributes = data.attributes || [];
}

// ---- Flatten visible available tree (respecting expanded + filter + search) ----
function rebuildAvailFlat() {
    const flat = [];
    const search = state.availSearch.toLowerCase();
    const filterSet = state.availFilter; // Set or null

    function nameMatches(name) {
        if (filterSet && !filterSet.has(name)) return false;
        if (search) {
            const disp = display(name).toLowerCase();
            if (!disp.includes(search) && !name.toLowerCase().includes(search)) return false;
        }
        return true;
    }
    // When filtering/searching we show a flat matched list (like PAW search) for clarity
    const flatMode = !!search || !!filterSet;
    if (flatMode) {
        for (const el of state.elements) {
            if (nameMatches(el.Name)) {
                flat.push({ name: el.Name, depth: 0, hasChildren: false });
            }
        }
        state.availFlat = flat;
        renderAvail();
        return;
    }
    function walk(name, depth) {
        const children = state.childrenMap.get(name);
        const hasChildren = !!(children && children.length);
        flat.push({ name, depth, hasChildren });
        if (hasChildren && state.expanded.has(name)) {
            for (const c of children) walk(c, depth + 1);
        }
    }
    for (const r of state.roots) walk(r, 0);
    state.availFlat = flat;
    renderAvail();
}

// Which attribute columns to display: the user's picked set, or the first 3
// non-alias attributes by default. Empty when "Show attributes" is off.
function visibleAttrCols() {
    if (!state.showAttrs) return [];
    const nonAlias = state.attributes.filter(a => a.Type.toLowerCase() !== 'alias');
    if (state.selectedAttrs) return nonAlias.filter(a => state.selectedAttrs.has(a.Name));
    return nonAlias.slice(0, 3);
}

// Populate the attribute-picker checkbox list from the dimension's attributes,
// filtered by the picker's search box.
function renderAttrPicker() {
    const list = document.getElementById('attrList');
    const filterEl = document.getElementById('attrFilter');
    const filter = (filterEl ? filterEl.value : '').toLowerCase();
    let nonAlias = state.attributes.filter(a => a.Type.toLowerCase() !== 'alias');
    if (!nonAlias.length) { list.innerHTML = '<div style="color:var(--desc);padding:4px;">No attributes on this dimension.</div>'; return; }
    const shown = new Set(visibleAttrCols().map(a => a.Name));
    const visible = filter ? nonAlias.filter(a => a.Name.toLowerCase().includes(filter)) : nonAlias;
    if (!visible.length) { list.innerHTML = '<div style="color:var(--desc);padding:4px;">No attributes match.</div>'; return; }
    list.innerHTML = visible.map(a =>
        '<label style="display:flex;align-items:center;gap:6px;padding:3px 2px;cursor:pointer;">'
        + '<input type="checkbox" value="' + esc(a.Name) + '"' + (shown.has(a.Name) ? ' checked' : '') + '>'
        + '<span>' + esc(a.Name) + '</span></label>').join('');
}

// ---- Virtualized rendering for available tree ----
function renderAvail() {
    const wrap = document.getElementById('availWrap');
    const inner = document.getElementById('availInner');
    const total = state.availFlat.length;
    inner.style.height = (total * ROW_H) + 'px';
    const scrollTop = wrap.scrollTop;
    const viewH = wrap.clientHeight || 500;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
    const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + 5);
    const attrCols = visibleAttrCols();
    let html = '';
    for (let i = start; i < end; i++) {
        const node = state.availFlat[i];
        const el = state.elemMap.get(node.name);
        const t = el ? el.Type : 1;
        const sel = state.availSelected.has(node.name) ? ' selected' : '';
        const twisty = node.hasChildren
            ? '<span class="twisty ' + (state.expanded.has(node.name) ? 'expanded' : '') + '" data-twisty="' + esc(node.name) + '">▶</span>'
            : '<span class="twisty empty"></span>';
        let attrs = '';
        for (const a of attrCols) {
            const v = el && el.Attributes ? el.Attributes[a.Name] : '';
            attrs += '<span class="attr-cell" title="' + esc(a.Name) + '">' + esc(v) + '</span>';
        }
        const gridCols = gridTemplate(attrCols);
        html += '<div class="row' + sel + '" data-name="' + esc(node.name) + '" data-side="avail" draggable="true" '
            + 'style="position:absolute;top:' + (i * ROW_H) + 'px;left:0;right:0;grid-template-columns:' + gridCols + '">'
            + '<div class="name-cell" style="padding-left:' + (8 + node.depth * 16) + 'px">'
            + twisty
            + '<span class="elem-icon ' + typeClass(t) + '">' + typeIcon(t) + '</span>'
            + '<span class="elem-name">' + esc(display(node.name)) + '</span>'
            + weightBadge(node.name)
            + '</div>'
            + weightCell(node.name)
            + attrs
            + '</div>';
    }
    inner.innerHTML = html;
    document.getElementById('availCount').textContent = '(' + total + ')';
}

// ---- Render current set (as a tree, mirroring Available) ----
// Depth is derived from how many of a member's hierarchy ancestors are also in
// the set, so related members auto-nest under their parent.
function inSetAncestorDepth(name, setSet) {
    let d = 0; let p = state.parentMap.get(name);
    const guard = new Set();
    while (p && !guard.has(p)) { guard.add(p); if (setSet.has(p)) d++; p = state.parentMap.get(p); }
    return d;
}
function hasInSetChildren(name, setSet) {
    const kids = state.childrenMap.get(name);
    if (!kids) return false;
    for (const k of kids) if (setSet.has(k)) return true;
    return false;
}
function rebuildSetFlat() {
    const flat = [];
    const search = state.setSearch.toLowerCase();
    const setSet = new Set(state.setMembers);
    if (search) {
        for (const n of state.setMembers) {
            if (display(n).toLowerCase().includes(search) || n.toLowerCase().includes(search)) {
                flat.push({ name: n, depth: 0, hasChildren: false, expanded: false });
            }
        }
        state.setFlat = flat; renderSet(); return;
    }
    for (const n of state.setMembers) {
        const kids = state.childrenMap.get(n);
        const hasChildren = !!(kids && kids.length);
        flat.push({
            name: n,
            depth: inSetAncestorDepth(n, setSet),
            hasChildren,
            expanded: hasInSetChildren(n, setSet)
        });
    }
    state.setFlat = flat; renderSet();
}
// Twisty click on a set consolidation: expand pulls its direct children into the
// set (nesting them); collapse removes its in-set descendants again.
function toggleSetExpand(name) {
    const setSet = new Set(state.setMembers);
    if (hasInSetChildren(name, setSet)) {
        // collapse: remove all in-set descendants of this node
        const isDesc = (m) => {
            let p = state.parentMap.get(m); const guard = new Set();
            while (p && !guard.has(p)) { guard.add(p); if (p === name) return true; p = state.parentMap.get(p); }
            return false;
        };
        const removed = new Set(state.setMembers.filter(isDesc));
        state.setMembers = state.setMembers.filter(n => !removed.has(n));
        for (const r of removed) state.setSelected.delete(r);
    } else {
        // expand: insert direct hierarchy children not already present
        const idx = state.setMembers.indexOf(name);
        if (idx < 0) return;
        const kids = state.childrenMap.get(name) || [];
        const existing = new Set(state.setMembers);
        const toInsert = kids.filter(k => !existing.has(k));
        state.setMembers.splice(idx + 1, 0, ...toInsert);
    }
    rebuildSetFlat();
    setStatus(state.setMembers.length + ' members in set.');
}
function renderSet() {
    const inner = document.getElementById('setInner');
    const wrap = document.getElementById('setWrap');
    const list = state.setFlat;
    inner.style.height = (list.length * ROW_H) + 'px';
    const scrollTop = wrap.scrollTop;
    const viewH = wrap.clientHeight || 500;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
    const end = Math.min(list.length, Math.ceil((scrollTop + viewH) / ROW_H) + 5);
    const attrCols = visibleAttrCols();
    let html = '';
    for (let i = start; i < end; i++) {
        const node = list[i];
        const name = node.name;
        const el = state.elemMap.get(name);
        const t = el ? el.Type : 1;
        const sel = state.setSelected.has(name) ? ' selected' : '';
        const twisty = node.hasChildren
            ? '<span class="twisty ' + (node.expanded ? 'expanded' : '') + '" data-settwisty="' + esc(name) + '">▶</span>'
            : '<span class="twisty empty"></span>';
        let attrs = '';
        for (const a of attrCols) {
            const v = el && el.Attributes ? el.Attributes[a.Name] : '';
            attrs += '<span class="attr-cell" title="' + esc(a.Name) + '">' + esc(v) + '</span>';
        }
        const gridCols = gridTemplate(attrCols);
        html += '<div class="row' + sel + '" data-name="' + esc(name) + '" data-side="set" draggable="true" '
            + 'style="position:absolute;top:' + (i * ROW_H) + 'px;left:0;right:0;grid-template-columns:' + gridCols + '">'
            + '<div class="name-cell" style="padding-left:' + (8 + node.depth * 16) + 'px">'
            + twisty
            + '<span class="elem-icon ' + typeClass(t) + '">' + typeIcon(t) + '</span>'
            + '<span class="elem-name">' + esc(display(name)) + '</span>'
            + weightBadge(name)
            + '</div>'
            + weightCell(name)
            + attrs
            + '</div>';
    }
    inner.innerHTML = html;
    document.getElementById('setCount').textContent = '(' + state.setMembers.length + ')';
}

// ---- Selection handling (Ctrl = toggle, Shift = range) ----
function handleRowClick(e, side) {
    const row = e.target.closest('.row');
    if (!row) return;
    const name = row.getAttribute('data-name');
    const selSet = side === 'avail' ? state.availSelected : state.setSelected;
    const list = side === 'avail' ? state.availFlat.map(n => n.name) : state.setFlat.map(n => n.name);
    const idx = list.indexOf(name);
    const lastKey = side === 'avail' ? 'lastAvailIdx' : 'lastSetIdx';
    if (e.shiftKey && state[lastKey] != null && state[lastKey] >= 0 && state[lastKey] < list.length) {
        if (!e.ctrlKey && !e.metaKey) selSet.clear();
        const a = Math.min(state[lastKey], idx), b = Math.max(state[lastKey], idx);
        for (let i = a; i <= b; i++) selSet.add(list[i]);
    } else {
        if (!e.ctrlKey && !e.metaKey) selSet.clear();
        if (selSet.has(name) && (e.ctrlKey || e.metaKey)) selSet.delete(name); else selSet.add(name);
        state[lastKey] = idx;
    }
    side === 'avail' ? renderAvail() : renderSet();
}

// ---- Transfer operations ----
function collectDescendants(name, acc) {
    acc.push(name);
    const kids = state.childrenMap.get(name);
    if (kids) for (const k of kids) collectDescendants(k, acc);
}
function addMembers(withChildren) {
    const toAdd = [];
    for (const name of state.availSelected) {
        if (withChildren) { const acc = []; collectDescendants(name, acc); toAdd.push(...acc); }
        else toAdd.push(name);
    }
    const existing = new Set(state.setMembers);
    for (const n of toAdd) if (!existing.has(n)) { state.setMembers.push(n); existing.add(n); state.setDepthMap.set(n, 0); }
    state.availSelected.clear();
    renderAvail(); rebuildSetFlat();
    setStatus(state.setMembers.length + ' members in set.');
}
function removeMembers() {
    if (state.setSelected.size === 0) return;
    state.setMembers = state.setMembers.filter(n => !state.setSelected.has(n));
    state.setSelected.clear();
    rebuildSetFlat();
}
function keepSelectedInSet() {
    if (state.setSelected.size === 0) return;
    // Only meaningful if some selected names are actual set members
    if (!state.setMembers.some(n => state.setSelected.has(n))) return;
    state.setMembers = state.setMembers.filter(n => state.setSelected.has(n));
    state.setSelected.clear();
    rebuildSetFlat();
    setStatus(state.setMembers.length + ' members kept.');
}
function removeAll() { state.setMembers = []; state.setSelected.clear(); state.setExpanded.clear(); state.setDepthMap.clear(); rebuildSetFlat(); }
function addAll() {
    // Add every element (respecting an active filter) to the current set
    const existing = new Set(state.setMembers);
    for (const el of state.elements) {
        if (state.availFilter && !state.availFilter.has(el.Name)) continue;
        if (!existing.has(el.Name)) { state.setMembers.push(el.Name); existing.add(el.Name); state.setDepthMap.set(el.Name, 0); }
    }
    state.availSelected.clear();
    renderAvail(); rebuildSetFlat();
    setStatus(state.setMembers.length + ' members in set.');
}
function addVisible() {
    // Add exactly the members currently displayed in the Available list
    // (respecting the active search / filter / expansion state)
    const existing = new Set(state.setMembers);
    for (const node of state.availFlat) {
        if (!existing.has(node.name)) { state.setMembers.push(node.name); existing.add(node.name); state.setDepthMap.set(node.name, 0); }
    }
    state.availSelected.clear();
    renderAvail(); rebuildSetFlat();
    setStatus(state.setMembers.length + ' members in set.');
}

// ---- Filter / MDX generation ----
function getConditions() {
    const rows = document.querySelectorAll('#condRows .cond-row');
    const conds = [];
    rows.forEach(r => {
        conds.push({
            field: r.querySelector('.cond-field').value,
            op: r.querySelector('.cond-op').value,
            value: r.querySelector('.cond-value').value
        });
    });
    return conds;
}
function applyFilterLocal() {
    const mode = document.querySelector('input[name=matchMode]:checked').value;
    const conds = getConditions().filter(c => c.value !== '' || c.field === 'Level');
    if (conds.length === 0) { state.availFilter = null; rebuildAvailFlat(); return; }
    const allowed = new Set();
    for (const el of state.elements) {
        const results = conds.map(c => evalCond(el, c));
        const pass = mode === 'all' ? results.every(Boolean) : results.some(Boolean);
        if (pass) allowed.add(el.Name);
    }
    state.availFilter = allowed;
    rebuildAvailFlat();
    setStatus(allowed.size + ' members match filter.');
}
function evalCond(el, c) {
    if (c.field === 'Level') {
        const lv = parseInt(c.value, 10);
        if (isNaN(lv)) return true;
        if (c.op === 'equals') return el.Level === lv;
        if (c.op === 'gte') return el.Level >= lv;
        if (c.op === 'lte') return el.Level <= lv;
        return el.Level === lv;
    }
    let hay;
    if (c.field === 'Name') hay = el.Name;
    else hay = el.Attributes ? (el.Attributes[c.field] || '') : '';
    hay = String(hay).toLowerCase();
    const needle = String(c.value).toLowerCase();
    if (c.op === 'contains') return hay.includes(needle);
    if (c.op === 'equals') return hay === needle;
    if (c.op === 'startsWith') return hay.startsWith(needle);
    return hay.includes(needle);
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

// Build MDX statement from current selection / filter
function buildMDX() {
    const dim = state.dimension, hier = state.hierarchy;
    const q = '[' + dim + '].[' + hier + ']';
    // If a filter is active, express it as TM1FILTERBYPATTERN / level filters
    const mode = document.querySelector('input[name=matchMode]:checked');
    const conds = getConditions().filter(c => c.value !== '' || c.field === 'Level');
    if (state.availFilter && conds.length) {
        // Compose from conditions (best-effort, AND chained via FILTER)
        const parts = conds.map(c => {
            if (c.field === 'Level') return 'TM1FILTERBYLEVEL({TM1SUBSETALL(' + q + ')}, ' + (parseInt(c.value,10)||0) + ')';
            if (c.field === 'Name') return 'TM1FILTERBYPATTERN({TM1SUBSETALL(' + q + ')}, "*' + c.value + '*")';
            return 'FILTER({TM1SUBSETALL(' + q + ')}, INSTR(' + q + '.CurrentMember.Properties("' + c.field + '"), "' + c.value + '") > 0)';
        });
        if (parts.length === 1) return '{' + parts[0] + '}';
        const joiner = (mode && mode.value === 'any') ? 'UNION' : 'INTERSECT';
        let expr = parts[0];
        for (let i = 1; i < parts.length; i++) expr = joiner + '({' + expr + '}, {' + parts[i] + '})';
        return '{' + expr + '}';
    }
    // Otherwise explicit member list from current set — but if the set is
    // effectively the whole hierarchy, keep it compact (…Members) instead of
    // listing every element.
    if (state.setMembers.length) {
        if (state.elements && state.elements.length && state.setMembers.length >= state.elements.length) {
            return '{' + q + '.Members}';
        }
        return '{' + state.setMembers.map(n => q + '.[' + n + ']').join(', ') + '}';
    }
    return '{TM1SUBSETALL(' + q + ')}';
}

// ---- MDX dock (shared style with the Cube Viewer; Subset Builder wizard) ----
function toggleMdxDock(){
    const split=document.getElementById('split');
    if(split.classList.contains('mdx-open')){ closeMdxDock(); return; }
    document.getElementById('mdxText').value=formatMDX(buildMDX());
    histReset(document.getElementById('mdxText').value);
    split.classList.add('mdx-open');
    renderFnList(); renderSnList();
}
function closeMdxDock(){ document.getElementById('split').classList.remove('mdx-open'); }
function applyMdxNow(){
    const mdx=document.getElementById('mdxText').value.trim();
    if(!mdx){ return; }
    state.mdxRequestSeq++;
    setStatus('Resolving MDX…');
    post('resolveMDX', { mdx, dimension: state.dimension, requestId: state.mdxRequestSeq });
}
let _mdxAutoTimer=null;
function scheduleAutoApply(){
    const auto=document.getElementById('mdxAuto');
    if(!auto||!auto.checked){ return; }
    if(_mdxAutoTimer){ clearTimeout(_mdxAutoTimer); }
    _mdxAutoTimer=setTimeout(()=>{ applyMdxNow(); }, 700);
}
function insertAtCursor(tpl){
    const ta=document.getElementById('mdxText');
    let text=String(tpl);
    let caret=text.indexOf('§');
    if(caret>=0){ text=text.replace('§',''); } else { caret=text.length; }
    const start=ta.selectionStart||0, end=ta.selectionEnd||0;
    ta.value=ta.value.slice(0,start)+text+ta.value.slice(end);
    const pos=start+caret; ta.focus(); ta.setSelectionRange(pos,pos);
    histRecord(); scheduleAutoApply();
}
var _mbStarted=false;
var _mbUserTouched=false;
function toggleBuild(){
    const pane=document.getElementById('mdxBuildPane');
    const btn=document.getElementById('mdxBuildToggle');
    const open=pane.classList.toggle('open');
    btn.classList.toggle('active',open);
    if(open && !_mbStarted && typeof mbInit==='function'){
        _mbStarted=true;
        mbInit({ mode:'subset', dimension: state.dimension, hierarchy: state.hierarchy });
    }
}
let _mbApplyTimer=null;
function scheduleBuilderApply(){
    if(_mbApplyTimer){ clearTimeout(_mbApplyTimer); }
    _mbApplyTimer=setTimeout(()=>{ applyMdxNow(); }, 600);
}
// ---- Undo/redo history for the MDX editor ----
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
    updateUndoButtons(); scheduleAutoApply();
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
    const grip=document.getElementById('mdxResizer'), dock=document.getElementById('mdxDock');
    if(!grip||!dock){ return; }
    let startX=0, startW=0, dragging=false;
    grip.addEventListener('mousedown',e=>{ dragging=true; startX=e.clientX; startW=dock.getBoundingClientRect().width; grip.classList.add('dragging'); document.body.style.userSelect='none'; e.preventDefault(); });
    window.addEventListener('mousemove',e=>{ if(!dragging){ return; } const w=Math.max(340, Math.min(window.innerWidth*0.85, startW+(startX-e.clientX))); dock.style.width=w+'px'; });
    window.addEventListener('mouseup',()=>{ if(!dragging){ return; } dragging=false; grip.classList.remove('dragging'); document.body.style.userSelect=''; });
}
var _fnCatOpen={};
function renderFnList(filter){
    const host=document.getElementById('fnList');
    if(!host||!window.MDX_FUNCTIONS){ return; }
    const qq=(filter||'').trim().toLowerCase();
    const searching=qq.length>0;
    let html='';
    const cats=window.MDX_FUNCTIONS;
    for(let c=0;c<cats.length;c++){
        const cat=cats[c];
        const fns=cat.funcs.filter(f=>!qq || f.name.toLowerCase().indexOf(qq)>=0 || (f.desc||'').toLowerCase().indexOf(qq)>=0);
        if(fns.length===0){ continue; }
        const open=searching || !!_fnCatOpen[c];
        html+='<div class="fn-cat"><div class="fn-cat-head" data-cat="'+c+'"><span class="fn-cat-caret">'+(open?'▾':'▸')+'</span>'+esc(cat.name)+'<span class="fn-cat-count">'+fns.length+'</span></div>';
        html+='<div class="fn-cat-items" data-body="'+c+'"'+(open?'':' style="display:none;"')+'>';
        for(let i=0;i<fns.length;i++){ const f=fns[i]; html+='<div class="fn-item" data-c="'+c+'" data-i="'+cat.funcs.indexOf(f)+'" title="'+esc(f.desc||'')+'"><span class="fn-name">'+esc(f.name)+'</span><span class="fn-syn">'+esc(f.syntax||'')+'</span></div>'; }
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
        items[k].addEventListener('click',()=>{ const c=+items[k].getAttribute('data-c'), i=+items[k].getAttribute('data-i'); const f=window.MDX_FUNCTIONS[c].funcs[i]; insertAtCursor(f.insert||f.name); });
    }
}
function renderSnList(){
    const host=document.getElementById('snList');
    if(!host||!window.MDX_SNIPPETS){ return; }
    let html='';
    for(let i=0;i<window.MDX_SNIPPETS.length;i++){ const s=window.MDX_SNIPPETS[i]; html+='<div class="sn-item" data-i="'+i+'"><div class="sn-name">'+esc(s.name)+'</div><div class="sn-desc">'+esc(s.desc||'')+'</div></div>'; }
    host.innerHTML=html;
    const items=host.querySelectorAll('.sn-item');
    for(let k=0;k<items.length;k++){ items[k].addEventListener('click',()=>{ const s=window.MDX_SNIPPETS[+items[k].getAttribute('data-i')]; insertAtCursor(s.mdx); }); }
}

// ---- Drag & drop ----
let dragData = null;
function setupDnd() {
    document.querySelectorAll('.list-wrap').forEach(wrap => {
        wrap.addEventListener('dragstart', e => {
            const row = e.target.closest('.row');
            if (!row) return;
            const side = row.getAttribute('data-side');
            const selSet = side === 'avail' ? state.availSelected : state.setSelected;
            const name = row.getAttribute('data-name');
            if (!selSet.has(name)) { selSet.clear(); selSet.add(name); side === 'avail' ? renderAvail() : renderSet(); }
            dragData = { side, names: Array.from(selSet) };
        });
        wrap.addEventListener('dragover', e => { e.preventDefault(); wrap.classList.add('drop-target'); });
        wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
        wrap.addEventListener('drop', e => {
            e.preventDefault(); wrap.classList.remove('drop-target');
            if (!dragData) return;
            const targetSide = wrap.id === 'setWrap' ? 'set' : 'avail';
            if (dragData.side === 'avail' && targetSide === 'set') {
                const existing = new Set(state.setMembers);
                for (const n of dragData.names) if (!existing.has(n)) { state.setMembers.push(n); existing.add(n); state.setDepthMap.set(n, 0); }
                state.availSelected.clear(); renderAvail(); rebuildSetFlat();
            } else if (dragData.side === 'set' && targetSide === 'avail') {
                const rm = new Set(dragData.names);
                state.setMembers = state.setMembers.filter(n => !rm.has(n));
                state.setSelected.clear(); rebuildSetFlat();
            }
            dragData = null;
        });
    });
}

// ---- Condition row UI ----
function addCondRow() {
    const attrOpts = state.attributes.filter(a => a.Type.toLowerCase() !== 'alias')
        .map(a => '<option value="' + esc(a.Name) + '">' + esc(a.Name) + '</option>').join('');
    const div = document.createElement('div');
    div.className = 'cond-row';
    div.innerHTML =
        '<select class="cond-field"><option value="Name">Name</option><option value="Level">Level</option>' + attrOpts + '</select>'
        + '<select class="cond-op"><option value="contains">Contains</option><option value="equals">Equals</option><option value="startsWith">Starts with</option></select>'
        + '<input type="text" class="cond-value" placeholder="Enter keyword">'
        + '<span class="remove" title="Remove">⊖</span>';
    div.querySelector('.remove').addEventListener('click', () => div.remove());
    document.getElementById('condRows').appendChild(div);
}

// ==================================================
// Event wiring
// ==================================================
function init() {
    post('getDimensions');

    document.getElementById('dimSel').addEventListener('change', e => {
        state.dimension = e.target.value;
        // New dimension — drop the previous dimension's current set to avoid mixing
        state.setMembers = [];
        state.setSelected.clear();
        state.setExpanded.clear();
        state.setDepthMap.clear();
        state.pendingMembers = null;
        rebuildSetFlat();
        post('getHierarchies', { dimension: state.dimension });
    });
    document.getElementById('hierSel').addEventListener('change', e => {
        state.hierarchy = e.target.value;
        state.setMembers = []; state.setSelected.clear(); state.setExpanded.clear(); state.setDepthMap.clear(); rebuildSetFlat();
        post('getSubsets', { dimension: state.dimension, hierarchy: state.hierarchy });
        setStatus('Loading hierarchy…');
        post('loadHierarchy', { dimension: state.dimension, hierarchy: state.hierarchy });
    });
    // Auto-load a subset as soon as it is selected (no Load click needed)
    document.getElementById('subsetSel').addEventListener('change', e => {
        const sub = e.target.value;
        if (!state.dimension || !state.hierarchy) return;
        if (sub) {
            setStatus('Loading subset…');
            post('loadSubset', { dimension: state.dimension, hierarchy: state.hierarchy, subset: sub });
        } else {
            state.setMembers = []; state.setSelected.clear(); rebuildSetFlat();
        }
    });
    document.getElementById('loadBtn').addEventListener('click', () => {
        if (!state.dimension || !state.hierarchy) { setStatus('Pick a dimension and hierarchy first.'); return; }
        setStatus('Loading hierarchy…');
        post('loadHierarchy', { dimension: state.dimension, hierarchy: state.hierarchy });
        const sub = document.getElementById('subsetSel').value;
        if (sub) post('loadSubset', { dimension: state.dimension, hierarchy: state.hierarchy, subset: sub });
    });
    document.getElementById('aliasSel').addEventListener('change', e => {
        state.currentAlias = e.target.value; renderAvail(); rebuildSetFlat();
    });
    document.getElementById('attrToggle').addEventListener('click', () => {
        state.showAttrs = !state.showAttrs;
        document.getElementById('attrToggle').classList.toggle('active', state.showAttrs);
        renderAvail(); renderSet();
    });
    document.getElementById('weightToggle').addEventListener('click', () => {
        state.showWeights = !state.showWeights;
        document.getElementById('weightToggle').classList.toggle('active', state.showWeights);
        renderAvail(); renderSet();
    });
    // Attribute picker flyout
    const attrFlyout = document.getElementById('attrFlyout');
    document.getElementById('attrFilter').addEventListener('input', () => renderAttrPicker());
    document.getElementById('attrPickBtn').addEventListener('click', e => {
        e.stopPropagation();
        if (attrFlyout.classList.contains('open')) { attrFlyout.classList.remove('open'); return; }
        renderAttrPicker();
        const r = e.target.getBoundingClientRect();
        attrFlyout.style.top = (r.bottom + 4) + 'px';
        attrFlyout.style.left = Math.max(8, r.right - 240) + 'px';
        attrFlyout.classList.add('open');
    });
    document.getElementById('attrList').addEventListener('change', e => {
        const cb = e.target.closest('input[type=checkbox]');
        if (!cb) return;
        if (!state.selectedAttrs) {
            // Materialise the current default so toggling is well-defined.
            state.selectedAttrs = new Set(visibleAttrCols().map(a => a.Name));
        }
        if (cb.checked) state.selectedAttrs.add(cb.value); else state.selectedAttrs.delete(cb.value);
        if (!state.showAttrs) { state.showAttrs = true; document.getElementById('attrToggle').classList.add('active'); }
        renderAvail(); renderSet();
    });
    document.getElementById('attrAllBtn').addEventListener('click', () => {
        state.selectedAttrs = new Set(state.attributes.filter(a => a.Type.toLowerCase() !== 'alias').map(a => a.Name));
        state.showAttrs = true; document.getElementById('attrToggle').classList.add('active');
        renderAttrPicker(); renderAvail(); renderSet();
    });
    document.getElementById('attrNoneBtn').addEventListener('click', () => {
        state.selectedAttrs = new Set();
        renderAttrPicker(); renderAvail(); renderSet();
    });
    document.addEventListener('click', e => {
        if (attrFlyout.classList.contains('open') && !attrFlyout.contains(e.target) && e.target.id !== 'attrPickBtn') {
            attrFlyout.classList.remove('open');
        }
    });

    // Available tree interactions (event delegation)
    const availWrap = document.getElementById('availWrap');
    availWrap.addEventListener('scroll', renderAvail);
    availWrap.addEventListener('click', e => {
        const tw = e.target.closest('.twisty');
        if (tw && tw.dataset.twisty) {
            const n = tw.dataset.twisty;
            if (state.expanded.has(n)) state.expanded.delete(n); else state.expanded.add(n);
            rebuildAvailFlat();
            return;
        }
        handleRowClick(e, 'avail');
    });
    availWrap.addEventListener('dblclick', () => addMembers(false));

    const setWrap = document.getElementById('setWrap');
    setWrap.addEventListener('scroll', renderSet);
    setWrap.addEventListener('click', e => {
        const tw = e.target.closest('.twisty');
        if (tw && tw.dataset.settwisty) {
            toggleSetExpand(tw.dataset.settwisty);
            return;
        }
        handleRowClick(e, 'set');
    });
    setWrap.addEventListener('dblclick', removeMembers);

    document.getElementById('availSearch').addEventListener('input', e => { state.availSearch = e.target.value; rebuildAvailFlat(); });
    document.getElementById('setSearch').addEventListener('input', e => { state.setSearch = e.target.value; rebuildSetFlat(); });

    document.getElementById('addBtn').addEventListener('click', () => addMembers(false));
    document.getElementById('addChildrenBtn').addEventListener('click', () => addMembers(true));
    document.getElementById('addVisibleBtn').addEventListener('click', addVisible);
    document.getElementById('addAllBtn').addEventListener('click', addAll);
    document.getElementById('removeBtn').addEventListener('click', removeMembers);
    document.getElementById('removeAllBtn').addEventListener('click', removeAll);
    document.getElementById('setKeepBtn').addEventListener('click', keepSelectedInSet);
    document.getElementById('setRemoveSelBtn').addEventListener('click', removeMembers);

    document.getElementById('expandAllBtn').addEventListener('click', () => {
        for (const el of state.elements) if (state.childrenMap.has(el.Name)) state.expanded.add(el.Name);
        rebuildAvailFlat();
    });
    document.getElementById('collapseAllBtn').addEventListener('click', () => { state.expanded.clear(); rebuildAvailFlat(); });

    // Set ordering
    document.getElementById('setUpBtn').addEventListener('click', () => moveSet(-1));
    document.getElementById('setDownBtn').addEventListener('click', () => moveSet(1));
    document.getElementById('setSortBtn').addEventListener('click', () => {
        state.setMembers.sort((a, b) => display(a).localeCompare(display(b))); rebuildSetFlat();
    });

    // Filter flyout
    const flyout = document.getElementById('filterFlyout');
    document.getElementById('availFilterBtn').addEventListener('click', e => {
        const r = e.target.getBoundingClientRect();
        flyout.style.top = (r.bottom + 4) + 'px';
        flyout.style.left = Math.max(8, r.left - 200) + 'px';
        flyout.classList.toggle('open');
        if (flyout.classList.contains('open') && document.querySelectorAll('#condRows .cond-row').length === 0) addCondRow();
    });
    document.getElementById('addCondBtn').addEventListener('click', addCondRow);
    document.getElementById('applyFilterBtn').addEventListener('click', () => { applyFilterLocal(); flyout.classList.remove('open'); });
    document.getElementById('clearFilterBtn').addEventListener('click', () => {
        document.getElementById('condRows').innerHTML = ''; state.availFilter = null; rebuildAvailFlat(); flyout.classList.remove('open');
    });

    // MDX dock
    document.getElementById('mdxBtn').addEventListener('click', () => toggleMdxDock());
    document.getElementById('mdxDockClose').addEventListener('click', () => closeMdxDock());
    document.getElementById('mdxFormatBtn').addEventListener('click', () => { const t = document.getElementById('mdxText'); t.value = formatMDX(t.value); histRecord(); });
    document.getElementById('mdxMinifyBtn').addEventListener('click', () => { const t = document.getElementById('mdxText'); t.value = minifyMDX(t.value); histRecord(); });
    document.getElementById('mdxCopyBtn').addEventListener('click', () => post('copyMDX', { mdx: document.getElementById('mdxText').value }));
    document.getElementById('mdxUndoBtn').addEventListener('click', () => undoMdx());
    document.getElementById('mdxRedoBtn').addEventListener('click', () => redoMdx());
    document.getElementById('mdxBuildToggle').addEventListener('click', () => toggleBuild());
    document.getElementById('mdxApplyBtn').addEventListener('click', () => applyMdxNow());
    setupMdxEditor();

    // Save modal
    document.getElementById('saveBtn').addEventListener('click', () => {
        document.getElementById('saveName').value = document.getElementById('subsetSel').value || '';
        document.getElementById('saveModal').classList.add('open');
    });
    document.getElementById('usePickerBtn').addEventListener('click', () => {
        const members = state.setMembers.map(name => {
            const el = state.elemMap.get(name);
            return { name, type: el ? el.Type : 1, level: el ? el.Level : 0 };
        });
        post('applyToCaller', { members, alias: state.currentAlias || '' });
    });
    document.getElementById('saveCancelBtn').addEventListener('click', () => document.getElementById('saveModal').classList.remove('open'));
    document.getElementById('saveConfirmBtn').addEventListener('click', () => {
        const name = document.getElementById('saveName').value.trim();
        if (!name) { setStatus('Enter a subset name.'); return; }
        const isPublic = document.getElementById('savePublic').checked;
        const asMdx = document.getElementById('saveAsMdx').checked;
        // Prefer the MDX shown in the open editor (e.g. a FILTER / TM1FILTERBYLEVEL
        // expression) so a dynamic subset keeps its real definition instead of the
        // resolved element list produced by buildMDX().
        const mdxEl = document.getElementById('mdxText');
        const dockOpen = document.getElementById('split').classList.contains('mdx-open');
        const editorMdx = ((mdxEl && mdxEl.value) || '').trim();
        const dynamicMdx = (dockOpen && editorMdx) ? editorMdx : buildMDX();
        post('saveSubset', {
            dimension: state.dimension, hierarchy: state.hierarchy, name, isPublic,
            mdx: asMdx ? dynamicMdx : '',
            elements: asMdx ? [] : state.setMembers
        });
        document.getElementById('saveModal').classList.remove('open');
        setStatus('Saving subset…');
    });

    setupDnd();
}

function moveSet(dir) {
    const sel = state.setSelected;
    if (sel.size === 0) return;
    const arr = state.setMembers;
    const idxs = arr.map((n, i) => sel.has(n) ? i : -1).filter(i => i >= 0);
    if (dir < 0) {
        for (const i of idxs) if (i > 0 && !sel.has(arr[i - 1])) { [arr[i-1], arr[i]] = [arr[i], arr[i-1]]; }
    } else {
        for (const i of idxs.reverse()) if (i < arr.length - 1 && !sel.has(arr[i + 1])) { [arr[i+1], arr[i]] = [arr[i], arr[i+1]]; }
    }
    rebuildSetFlat();
}

// ==================================================
// Messages from extension host
// ==================================================
window.addEventListener('message', ev => {
    const m = ev.data;
    switch (m.command) {
        case 'dimensions': {
            const sel = document.getElementById('dimSel');
            sel.innerHTML = '<option value="">— select —</option>' + m.dimensions.map(d => '<option>' + esc(d) + '</option>').join('');
            setStatus('Select a dimension.');
            break;
        }
        case 'hierarchies': {
            const sel = document.getElementById('hierSel');
            sel.innerHTML = m.hierarchies.map(h => '<option>' + esc(h) + '</option>').join('');
            if (state.pendingPreselect) {
                const pre = state.pendingPreselect;
                const targetHier = (pre.hierarchy && m.hierarchies.includes(pre.hierarchy)) ? pre.hierarchy : (m.hierarchies[0] || '');
                sel.value = targetHier;
                state.hierarchy = targetHier;
                post('getSubsets', { dimension: state.dimension, hierarchy: state.hierarchy });
                setStatus('Loading hierarchy…');
                post('loadHierarchy', { dimension: state.dimension, hierarchy: state.hierarchy });
                if (pre.subset) {
                    const ssel = document.getElementById('subsetSel');
                    state.pendingSubset = pre.subset;
                    post('loadSubset', { dimension: state.dimension, hierarchy: state.hierarchy, subset: pre.subset });
                }
                state.pendingPreselect = null;
            } else if (m.hierarchies.length) {
                state.hierarchy = m.hierarchies[0];
                post('getSubsets', { dimension: state.dimension, hierarchy: state.hierarchy });
                setStatus('Loading hierarchy…');
                post('loadHierarchy', { dimension: state.dimension, hierarchy: state.hierarchy });
            }
            break;
        }
        case 'subsets': {
            const sel = document.getElementById('subsetSel');
            const cur = sel.value;
            sel.innerHTML = '<option value="">— New —</option>' + m.subsets.map(s => '<option>' + esc(s) + '</option>').join('');
            if (state.pendingSubset && m.subsets.includes(state.pendingSubset)) {
                sel.value = state.pendingSubset;
                state.pendingSubset = null;
            } else if (cur && m.subsets.includes(cur)) {
                sel.value = cur;
            }
            break;
        }
        case 'preselect': {
            // Switching to a different dimension — clear any carried-over set/selection
            state.setMembers = [];
            state.setSelected.clear();
            state.setExpanded.clear();
            state.setDepthMap.clear();
            state.availSelected.clear();
            state.availFilter = null;
            state.availSearch = '';
            state.setSearch = '';
            const availSearchEl = document.getElementById('availSearch'); if (availSearchEl) availSearchEl.value = '';
            const setSearchEl = document.getElementById('setSearch'); if (setSearchEl) setSearchEl.value = '';
            rebuildSetFlat();
            state.pendingMembers = (m.members && m.members.length) ? m.members.slice() : null;
            state.pendingPreselect = { hierarchy: m.hierarchy, subset: m.subset };
            state.pendingSubset = m.subset || null;
            const dsel = document.getElementById('dimSel');
            let found = false;
            for (const o of dsel.options) if (o.value === m.dimension) found = true;
            if (!found) { const o = document.createElement('option'); o.text = m.dimension; o.value = m.dimension; dsel.add(o); }
            dsel.value = m.dimension;
            state.dimension = m.dimension;
            post('getHierarchies', { dimension: m.dimension });
            setStatus('Opening ' + m.dimension + '…');
            break;
        }
        case 'hierarchyData': {
            buildTree(m);
            // Alias dropdown
            const aliasSel = document.getElementById('aliasSel');
            aliasSel.innerHTML = '<option value="">Member ID</option>' + state.aliasAttributes.map(a => '<option value="' + esc(a) + '">' + esc(a) + '</option>').join('');
            state.expanded.clear();
            for (const r of state.roots) if (state.childrenMap.has(r)) state.expanded.add(r);
            rebuildAvailFlat();
            // Prefill the current set with members handed over from the caller (e.g. Cube Viewer)
            if (state.pendingMembers) {
                const valid = state.pendingMembers.filter(n => state.elemMap.has(n));
                state.setMembers = valid.length ? valid : state.pendingMembers.slice();
                state.pendingMembers = null;
                state.setExpanded.clear(); state.setDepthMap.clear();
            }
            // Rebuild the current-set tree now that the hierarchy (childrenMap) is loaded
            rebuildSetFlat();
            setStatus(state.elements.length + ' elements loaded.');
            break;
        }
        case 'subsetContent': {
            state.setExpanded.clear(); state.setDepthMap.clear();
            // A dynamic subset returns BOTH its MDX expression and the resolved
            // elements — prefer the expression so the editor shows the real
            // definition; fall back to the element list only for static subsets.
            if (m.mdx) {
                // Open the dock first (it seeds mdxText via buildMDX), then write
                // the real expression so it isn't overwritten.
                if (!document.getElementById('split').classList.contains('mdx-open')) { toggleMdxDock(); }
                document.getElementById('mdxText').value = m.mdx;
                setStatus('Subset is MDX-based — resolving…');
                state.mdxRequestSeq++;
                post('resolveMDX', { mdx: m.mdx, dimension: state.dimension, requestId: state.mdxRequestSeq });
            } else if (m.elements && m.elements.length) {
                state.setMembers = m.elements.slice();
            }
            rebuildSetFlat();
            break;
        }
        case 'mdxResolved': {
            if (m.requestId !== state.mdxRequestSeq) break;
            if (m.error) { setStatus('MDX error: ' + m.error); break; }
            state.setMembers = (m.members || []).slice();
            state.setSelected.clear();
            state.setExpanded.clear(); state.setDepthMap.clear();
            rebuildSetFlat();
            setStatus(state.setMembers.length + ' members from MDX.');
            break;
        }
        case 'mdxResult': {
            const ta = document.getElementById('mdxText');
            if (ta && typeof m.mdx === 'string' && _mbUserTouched) { ta.value = formatMDX(m.mdx); histRecord(); scheduleBuilderApply(); }
            break;
        }
        case 'subsetSaved': {
            setStatus("Saved subset '" + m.name + "'.");
            break;
        }
        case 'error': {
            setStatus('Error: ' + m.message);
            break;
        }
        case 'enablePicker': {
            document.getElementById('usePickerBtn').classList.remove('hidden');
            break;
        }
    }
});

init();
`;
}

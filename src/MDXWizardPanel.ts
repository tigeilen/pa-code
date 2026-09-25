import * as vscode from 'vscode';
import { handleMdxBuilderBackend } from './MDXBuilder';

export interface MDXWizardOptions {
    onInsert?: (mdx: string, mode?: string) => void;
    mode?: 'subset' | 'view';
    cube?: string;
}

export class MDXWizardPanel {
    private static panels: Map<string, MDXWizardPanel> = new Map();
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private readonly _instanceName: string;
    private _onInsert?: (mdx: string, mode?: string) => void;
    private _initMode?: 'subset' | 'view';
    private _initCube?: string;

    private constructor(panel: vscode.WebviewPanel, instanceName: string, opts?: MDXWizardOptions) {
        this._panel = panel;
        this._instanceName = instanceName;
        this._onInsert = opts?.onInsert;
        this._initMode = opts?.mode;
        this._initCube = opts?.cube;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent();

        this._panel.webview.onDidReceiveMessage(async msg => {
            try {
                if (msg.command === 'insertMDX') {
                    if (this._onInsert) {
                        this._onInsert(msg.mdx, msg.mode);
                        vscode.window.showInformationMessage('MDX sent to the Cube Viewer.');
                        return;
                    }
                    const editor = vscode.window.activeTextEditor;
                    if (editor) {
                        editor.edit(eb => eb.insert(editor.selection.active, msg.mdx));
                    } else {
                        vscode.window.showWarningMessage('No active editor to insert MDX into.');
                    }
                    return;
                }
                const reply = await handleMdxBuilderBackend(this._instanceName, msg);
                if (reply) { this._post(reply.command, reply.data); }
            } catch (err: any) {
                this._post('error', { message: err.message });
            }
        }, null, this._disposables);
    }

    public static render(instanceName: string, opts?: MDXWizardOptions) {
        const beside = !!opts?.onInsert;
        const existing = MDXWizardPanel.panels.get(instanceName);
        if (existing) {
            if (opts?.onInsert) { existing._onInsert = opts.onInsert; }
            if (opts?.mode || opts?.cube) {
                existing._panel.webview.postMessage({ command: 'wizardInit', mode: opts.mode, cube: opts.cube });
            }
            existing._panel.reveal(beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'tm1MDXWizard', `MDX Wizard — ${instanceName}`, beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        MDXWizardPanel.panels.set(instanceName, new MDXWizardPanel(panel, instanceName, opts));
    }

    /** Closes the MDX Wizard tab bound to an instance (used on disconnect). */
    public static disposeForInstance(instanceName: string) {
        const p = MDXWizardPanel.panels.get(instanceName);
        if (p) { p._panel.dispose(); }
    }

    private dispose() {
        MDXWizardPanel.panels.delete(this._instanceName);
        this._panel.dispose();
        while (this._disposables.length) { const d = this._disposables.pop(); if (d) d.dispose(); }
    }

    private _post(command: string, data: any) {
        this._panel.webview.postMessage({ command, ...data });
    }

    // ==========================================
    // WEBVIEW HTML
    // ==========================================
    private _getWebviewContent(): string {
        const initJson = JSON.stringify({ mode: this._initMode || null, cube: this._initCube || null });
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<style>
html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
` + mdxBuilderStyles() + `
</style>
</head>
<body>
` + mdxBuilderHtml() + `
<script>const vscode = acquireVsCodeApi();</script>
<script>
` + mdxBuilderScript() + `
</script>
<script>mbInit(` + initJson + `);</script>
</body>
</html>`;
    }
}

export function mdxBuilderStyles(): string {
    return `:root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-foreground);
    --input-bg: var(--vscode-input-background);
    --input-fg: var(--vscode-input-foreground);
    --input-border: var(--vscode-input-border, #444);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --btn-hover: var(--vscode-button-hoverBackground);
    --border: var(--vscode-panel-border, #333);
    --accent: var(--vscode-focusBorder, #007acc);
    --desc: var(--vscode-descriptionForeground);
}
.mdxb, .mdxb * { box-sizing: border-box; margin: 0; padding: 0; }
.mdxb { font-family: var(--vscode-font-family); font-size: 13px; color: var(--fg); background: var(--bg); height: 100%; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }

/* ---- Layout ---- */
.mode-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.mode-tab { padding: 8px 20px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; background: transparent; color: var(--fg); border-top: none; border-left: none; border-right: none; }
.mode-tab:hover { background: var(--vscode-list-hoverBackground); }
.mode-tab.active { border-bottom-color: var(--accent); font-weight: 600; }

.main { display: flex; flex: 1; overflow: hidden; }
.config-panel { flex: 1; overflow-y: auto; padding: 16px; border-right: 1px solid var(--border); min-width: 300px; }
.preview-panel { flex: 1; min-width: 350px; display: flex; flex-direction: column; flex-shrink: 0; }
.preview-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
.preview-header span { font-weight: 600; font-size: 12px; text-transform: uppercase; color: var(--desc); letter-spacing: 0.5px; }
.preview-actions { display: flex; gap: 4px; }
.preview-code { min-height: 80px; max-height: 40vh; overflow: auto; padding: 12px; font-family: var(--vscode-editor-font-family, 'Consolas', monospace); font-size: 13px; white-space: pre-wrap; word-break: break-word; line-height: 1.5; color: #ce9178; background: var(--vscode-editor-background); border-bottom: 1px solid var(--border); }

/* ---- Form elements ---- */
.field { margin-bottom: 12px; }
.field-label { display: block; font-size: 11px; font-weight: 600; margin-bottom: 4px; color: var(--desc); text-transform: uppercase; letter-spacing: 0.3px; }
.mdxb select, .mdxb input[type="text"], .mdxb input[type="number"] {
    width: 100%; padding: 5px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px; font-size: 13px; font-family: inherit;
}
.mdxb select:focus, .mdxb input:focus { outline: 1px solid var(--accent); }
.radio-group { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.radio-group label { display: flex; align-items: center; gap: 4px; cursor: pointer; font-size: 13px; }
.mdxb input[type="radio"] { accent-color: var(--accent); }
.checkbox-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.checkbox-row input[type="checkbox"] { accent-color: var(--accent); }

.btn {
    background: var(--btn-bg); color: var(--btn-fg); border: none;
    padding: 4px 10px; border-radius: 3px; cursor: pointer; font-size: 12px;
}
.btn:hover { background: var(--btn-hover); }
.btn-sm { padding: 3px 8px; font-size: 11px; }
.btn-icon { background: transparent; border: none; color: var(--fg); cursor: pointer; padding: 4px 6px; border-radius: 3px; font-size: 13px; }
.btn-icon:hover { background: var(--vscode-toolbar-hoverBackground, #333); }
.btn-danger { background: #b91c1c; }
.btn-danger:hover { background: #dc2626; }

/* ---- Sections ---- */
.section { border: 1px solid var(--border); border-radius: 4px; padding: 10px; margin-bottom: 12px; }
.section-title { font-size: 12px; font-weight: 600; margin-bottom: 8px; color: var(--fg); }

/* ---- Filter rows ---- */
.filter-row { display: flex; gap: 6px; align-items: flex-end; margin-bottom: 6px; flex-wrap: wrap; }
.filter-row select, .filter-row input { width: auto; flex: 1; min-width: 80px; }

/* ---- Axis assignment (View Builder) ---- */
.axis-section { margin-bottom: 10px; }
.axis-label { font-size: 11px; font-weight: 600; color: var(--desc); margin-bottom: 4px; text-transform: uppercase; }
.axis-dims { display: flex; flex-direction: column; gap: 4px; min-height: 30px; border: 1px dashed var(--border); border-radius: 3px; padding: 6px; }
.dim-chip { display: flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--input-bg); border: 1px solid var(--border); border-radius: 3px; font-size: 12px; }
.dim-chip .chip-name { font-weight: 600; }
.dim-chip .chip-config { margin-left: auto; font-size: 11px; color: var(--accent); cursor: pointer; }
.dim-chip .chip-config:hover { text-decoration: underline; }

/* ---- Status ---- */
.mdxb .status { font-size: 12px; padding: 4px 12px; color: var(--desc); }
.mdxb .status.error { color: #f85149; }

/* ---- Inline subset builder ---- */
.inline-subset { border: 1px solid var(--accent); border-radius: 4px; padding: 8px; margin-top: 6px; background: rgba(0,122,204,0.05); }
.mdxb .mb-toolbar { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; margin-bottom: 10px; border-bottom: 1px solid var(--border); }
.mdxb .mb-ctrl-toggle { font-size: 12px; color: var(--desc); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.mdxb .mb-toolbar .status { margin-left: auto; }

/* Hide modes */
.mdxb .hidden { display: none !important; }
.mdxb textarea {
    width: 100%; padding: 5px 8px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px; font-size: 12px;
    font-family: var(--vscode-editor-font-family, 'Consolas', monospace);
    resize: vertical; min-height: 50px; line-height: 1.4;
}
.mdxb textarea:focus { outline: 1px solid var(--accent); }`;
}

export function mdxBuilderHtml(): string {
    return `<div class="mdxb">
    <!-- Mode Tabs -->
    <div class="mode-tabs">
        <button class="mode-tab active" data-mode="subset" onclick="switchMode('subset')">Subset Builder</button>
        <button class="mode-tab" data-mode="view" onclick="switchMode('view')">View Builder</button>
    </div>

    <div class="main">
        <!-- ============ CONFIG PANEL ============ -->
        <div class="config-panel">
            <div class="mb-toolbar">
                <button class="btn btn-sm" onclick="resetBuilder()" title="Reset the builder to the current view (or clear the selection)">↺ Reset</button>
                <label class="mb-ctrl-toggle"><input type="checkbox" class="mbCtrl" onchange="mbToggleControl(this)"> Control objects</label>
                <span class="status" id="statusMsg"></span>
            </div>

            <!-- ======== SUBSET MODE ======== -->
            <div id="subsetMode">
                <div class="field">
                    <label class="field-label">Dimension</label>
                    <select id="sDimension" onchange="onSubsetDimensionChange()"><option value="">Select...</option></select>
                </div>
                <div class="field">
                    <label class="field-label">Hierarchy</label>
                    <select id="sHierarchy" onchange="onSubsetHierarchyChange()"><option value="">Select...</option></select>
                </div>

                <div id="subsetOptions" class="hidden">
                    <!-- Base Selection -->
                    <div class="section">
                        <div class="section-title">Base Selection</div>
                        <div class="radio-group">
                            <label><input type="radio" name="sBase" value="all" checked onchange="onSubsetBaseChange()"> All Members</label>
                            <label><input type="radio" name="sBase" value="leaves" onchange="onSubsetBaseChange()"> Leaves Only</label>
                            <label><input type="radio" name="sBase" value="level" onchange="onSubsetBaseChange()"> Level
                                <input type="number" id="sLevel" min="0" max="50" value="0" style="width:74px;" oninput="mbClampLevel(this)" onchange="updateMDX()">
                            </label>
                            <label><input type="radio" name="sBase" value="members" onchange="onSubsetBaseChange()"> Pick Members</label>
                        </div>
                        <div id="pickMembersWrap" class="hidden" style="margin-top:6px;">
                            <input type="text" id="pickMembersSearch" placeholder="Search base members…" oninput="filterPickMembers()" style="margin-bottom:4px;">
                            <div id="pickMembersList" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:4px;font-size:12px;"></div>
                        </div>
                        <div class="section-title">Structure</div>
                        <div class="radio-group" style="margin-bottom:6px;">
                            <label><input type="radio" name="sStruct" value="none" checked onchange="updateMDX()"> None</label>
                            <label><input type="radio" name="sStruct" value="descendants" onchange="updateMDX()"> Descendants</label>
                            <label><input type="radio" name="sStruct" value="children" onchange="updateMDX()"> Children</label>
                            <label><input type="radio" name="sStruct" value="drilldown" onchange="updateMDX()"> DrillDown</label>
                            <label><input type="radio" name="sStruct" value="drilldownlevel" onchange="updateMDX()"> DrillDownLevel</label>
                        </div>
                        <div id="structElementWrap" class="hidden">
                            <label class="field-label">Parent Element</label>
                            <select id="sStructElement" onchange="updateMDX()"><option value="">Select...</option></select>
                        </div>
                    </div>

                    <!-- Filters -->
                    <div class="section">
                        <div class="section-title">Filters <button class="btn btn-sm" onclick="addFilter('pattern')">+ Pattern</button> <button class="btn btn-sm" onclick="addFilter('attribute')">+ Attribute</button> <button class="btn btn-sm" onclick="addFilter('value')">+ Cube Value</button></div>
                        <div id="filterList"></div>
                    </div>

                    <!-- Sorting -->
                    <div class="section">
                        <div class="section-title">Sorting</div>
                        <div style="display:flex;gap:8px;margin-bottom:6px;">
                            <select id="sSortType" onchange="onSortTypeChange()" style="flex:1;">
                                <option value="none">None</option>
                                <option value="alphabetic">Alphabetic (ORDER by Name)</option>
                                <option value="hierarchic">Hierarchic (TM1SORT)</option>
                                <option value="byindex">By Index (TM1SORTBYINDEX)</option>
                                <option value="byvalue">By Cube Value (ORDER)</option>
                                <option value="byattribute">By Attribute (ORDER)</option>
                            </select>
                            <select id="sSortDir" onchange="updateMDX()" style="width:80px;">
                                <option value="ASC">ASC</option>
                                <option value="DESC">DESC</option>
                                <option value="BASC">BASC</option>
                                <option value="BDESC">BDESC</option>
                            </select>
                        </div>
                        <div id="sortValueFields" class="hidden" style="display:flex;flex-direction:column;gap:4px;">
                            <input type="text" id="sSortCube" placeholder="Cube name" list="cubeList" oninput="updateMDX()">
                            <input type="text" id="sSortMeasure" placeholder="Measure element" oninput="updateMDX()">
                        </div>
                        <div id="sortAttrField" class="hidden">
                            <select id="sSortAttr" onchange="updateMDX()"><option value="">Select attribute...</option></select>
                        </div>
                    </div>

                    <!-- TopCount / BottomCount -->
                    <div class="section">
                        <div class="section-title">Top / Bottom Count</div>
                        <div style="display:flex;gap:8px;margin-bottom:6px;">
                            <select id="sTopBottomType" onchange="onSubsetTopBottomChange()" style="flex:1;">
                                <option value="none">None</option>
                                <option value="topcount">TopCount</option>
                                <option value="bottomcount">BottomCount</option>
                            </select>
                            <input type="number" id="sTopBottomCount" min="1" value="10" style="width:70px;" onchange="updateMDX()">
                        </div>
                        <div id="sTopBottomFields" class="hidden" style="display:flex;flex-direction:column;gap:4px;">
                            <input type="text" id="sTopBottomCube" placeholder="Cube name" list="cubeList" oninput="updateMDX()">
                            <input type="text" id="sTopBottomMeasure" placeholder="Measure element" oninput="updateMDX()">
                        </div>
                    </div>

                    <!-- Head / Tail -->
                    <div class="section">
                        <div class="section-title">Limit Results</div>
                        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                            <select id="sHeadTailType" onchange="updateMDX()" style="flex:1;">
                                <option value="none">No Limit</option>
                                <option value="head">First N (HEAD)</option>
                                <option value="tail">Last N (TAIL)</option>
                            </select>
                            <input type="number" id="sHeadTailCount" min="1" value="10" style="width:70px;" onchange="updateMDX()">
                        </div>
                        <div class="checkbox-row" style="margin-top:4px;">
                            <input type="checkbox" id="sSubsetRange" onchange="updateMDX()">
                            <label for="sSubsetRange" style="font-size:12px;">SUBSET Range (Start/Count)</label>
                        </div>
                        <div id="subsetRangeFields" class="hidden" style="display:flex;gap:6px;margin-top:4px;">
                            <div style="flex:1;"><label class="field-label">Start</label><input type="number" id="sRangeStart" min="0" value="0" onchange="updateMDX()"></div>
                            <div style="flex:1;"><label class="field-label">Count</label><input type="number" id="sRangeCount" min="1" value="10" onchange="updateMDX()"></div>
                        </div>
                    </div>

                    <!-- Set Operations -->
                    <div class="section">
                        <div class="section-title">Set Operations <button class="btn btn-sm" onclick="addSetOp('union')">+ Union</button> <button class="btn btn-sm" onclick="addSetOp('intersect')">+ Intersect</button> <button class="btn btn-sm" onclick="addSetOp('except')">+ Except</button></div>
                        <div id="setOpList"></div>
                    </div>
                </div>
            </div>

            <!-- ======== VIEW MODE ======== -->
            <div id="viewMode" class="hidden">
                <div class="field">
                    <label class="field-label">Cube</label>
                    <select id="vCube" onchange="onCubeChange()"><option value="">Select...</option></select>
                </div>

                <div id="viewOptions" class="hidden">
                    <!-- Columns -->
                    <div class="axis-section">
                        <div class="axis-label">Columns</div>
                        <div class="axis-dims" id="axisCols"></div>
                    </div>
                    <!-- Rows -->
                    <div class="axis-section">
                        <div class="axis-label">Rows</div>
                        <div class="axis-dims" id="axisRows"></div>
                    </div>
                    <!-- Titles / Context -->
                    <div class="axis-section">
                        <div class="axis-label">Titles / Context</div>
                        <div class="axis-dims" id="axisTitles"></div>
                    </div>

                    <!-- Unassigned -->
                    <div class="axis-section">
                        <div class="axis-label">Unassigned Dimensions</div>
                        <div class="axis-dims" id="axisUnassigned"></div>
                    </div>

                    <!-- Options -->
                    <div class="section">
                        <div class="section-title">Options</div>
                        <div class="checkbox-row"><input type="checkbox" id="vSuppressRows" onchange="updateMDX()"><label for="vSuppressRows">Suppress Zeroes on Rows</label></div>
                        <div class="checkbox-row"><input type="checkbox" id="vSuppressCols" onchange="updateMDX()"><label for="vSuppressCols">Suppress Zeroes on Columns</label></div>
                    </div>

                    <!-- Calculated Members -->
                    <div class="section">
                        <div class="section-title">Calculated Members (WITH MEMBER) <button class="btn btn-sm" onclick="addCalcMember()">+ Add</button></div>
                        <div id="calcMemberList"></div>
                    </div>

                    <!-- Dimension config (inline, shown when "Configure" is clicked) -->
                    <div id="dimConfigPanel" class="hidden">
                        <div class="section" style="border-color:var(--accent);">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                                <div class="section-title" id="dimConfigTitle" style="margin:0;">Configure Dimension</div>
                                <button class="btn btn-sm" onclick="closeDimConfig()">Close</button>
                            </div>
                            <div class="field">
                                <label class="field-label">Hierarchy</label>
                                <select id="dcHierarchy" onchange="onDcHierarchyChange()"></select>
                            </div>
                            <div class="field">
                                <label class="field-label">Subset Source</label>
                                <select id="dcSubsetType" onchange="onDcSubsetTypeChange()">
                                    <option value="all">All Members</option>
                                    <option value="members">Pick Member(s)</option>
                                    <option value="existing">Existing Subset</option>
                                    <option value="custom">Custom MDX Subset</option>
                                    <option value="drilldown">DrillDownMember</option>
                                </select>
                            </div>
                            <div id="dcMembersWrap" class="hidden field">
                                <input type="text" id="dcMembersSearch" placeholder="Search members…" oninput="filterDcMembers()" style="margin-bottom:4px;">
                                <div id="dcMembersList" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:3px;padding:4px;font-size:12px;"></div>
                            </div>
                            <div id="dcDrilldownWrap" class="hidden field">
                                <label class="field-label">Drill Down Element</label>
                                <select id="dcDrilldownElement" onchange="updateMDX()"><option value="">Select element...</option></select>
                            </div>
                            <div id="dcExistingWrap" class="hidden field">
                                <label class="field-label">Subset</label>
                                <select id="dcExistingSubset" onchange="updateMDX()"><option value="">Select...</option></select>
                            </div>
                            <div id="dcCustomWrap" class="hidden">
                                <!-- Inline subset builder fields (matches Subset Builder) -->
                                <div class="field">
                                    <label class="field-label">Base Selection</label>
                                    <div class="radio-group">
                                        <label><input type="radio" name="dcBase" value="all" checked onchange="updateMDX()"> All</label>
                                        <label><input type="radio" name="dcBase" value="leaves" onchange="updateMDX()"> Leaves</label>
                                        <label><input type="radio" name="dcBase" value="level" onchange="updateMDX()"> Level <input type="number" id="dcLevel" min="0" max="50" value="0" style="width:74px;" oninput="mbClampLevel(this)" onchange="updateMDX()"></label>
                                    </div>
                                </div>
                                <div class="field">
                                    <label class="field-label">Structure</label>
                                    <div class="radio-group" style="margin-bottom:4px;">
                                        <label><input type="radio" name="dcStruct" value="none" checked onchange="updateMDX()"> None</label>
                                        <label><input type="radio" name="dcStruct" value="descendants" onchange="updateMDX()"> Descendants</label>
                                        <label><input type="radio" name="dcStruct" value="children" onchange="updateMDX()"> Children</label>
                                        <label><input type="radio" name="dcStruct" value="drilldown" onchange="updateMDX()"> DrillDown</label>
                                        <label><input type="radio" name="dcStruct" value="drilldownlevel" onchange="updateMDX()"> DrillDownLevel</label>
                                    </div>
                                    <select id="dcStructElement" onchange="updateMDX()" style="margin-top:4px;"><option value="">Parent element...</option></select>
                                </div>
                                <!-- Filters -->
                                <div class="field">
                                    <label class="field-label">Filters <button class="btn btn-sm" onclick="addDcFilter('pattern')" style="margin-left:4px;">+ Pattern</button> <button class="btn btn-sm" onclick="addDcFilter('attribute')">+ Attribute</button> <button class="btn btn-sm" onclick="addDcFilter('value')">+ Value</button></label>
                                    <div id="dcFilterList"></div>
                                </div>
                                <!-- Sorting -->
                                <div class="field">
                                    <label class="field-label">Sorting</label>
                                    <div style="display:flex;gap:6px;margin-bottom:4px;">
                                        <select id="dcSortType" onchange="onDcSortTypeChange()" style="flex:1;"><option value="none">None</option><option value="alphabetic">Alphabetic</option><option value="hierarchic">Hierarchic</option><option value="byindex">By Index</option><option value="byvalue">By Cube Value</option><option value="byattribute">By Attribute</option></select>
                                        <select id="dcSortDir" onchange="updateMDX()" style="width:70px;"><option value="ASC">ASC</option><option value="DESC">DESC</option><option value="BASC">BASC</option><option value="BDESC">BDESC</option></select>
                                    </div>
                                    <div id="dcSortValueFields" class="hidden" style="display:flex;flex-direction:column;gap:4px;">
                                        <input type="text" id="dcSortCube" placeholder="Cube name" list="cubeList" oninput="updateMDX()">
                                        <input type="text" id="dcSortMeasure" placeholder="Measure element" oninput="updateMDX()">
                                    </div>
                                    <div id="dcSortAttrField" class="hidden">
                                        <select id="dcSortAttr" onchange="updateMDX()"><option value="">Select attribute...</option></select>
                                    </div>
                                </div>
                                <!-- TopCount / BottomCount -->
                                <div class="field">
                                    <label class="field-label">Top / Bottom Count</label>
                                    <div style="display:flex;gap:6px;margin-bottom:4px;">
                                        <select id="dcSubTopBottomType" onchange="onDcSubTopBottomChange()" style="flex:1;"><option value="none">None</option><option value="topcount">TopCount</option><option value="bottomcount">BottomCount</option></select>
                                        <input type="number" id="dcSubTopBottomCount" min="1" value="10" style="width:70px;" onchange="updateMDX()">
                                    </div>
                                    <div id="dcSubTopBottomFields" class="hidden" style="display:flex;flex-direction:column;gap:4px;">
                                        <input type="text" id="dcSubTopBottomCube" placeholder="Cube name" list="cubeList" oninput="updateMDX()">
                                        <input type="text" id="dcSubTopBottomMeasure" placeholder="Measure element" oninput="updateMDX()">
                                    </div>
                                </div>
                                <!-- Head / Tail -->
                                <div class="field">
                                    <label class="field-label">Limit Results</label>
                                    <div style="display:flex;gap:6px;">
                                        <select id="dcHeadTailType" onchange="updateMDX()" style="flex:1;"><option value="none">No Limit</option><option value="head">First N (HEAD)</option><option value="tail">Last N (TAIL)</option></select>
                                        <input type="number" id="dcHeadTailCount" min="1" value="10" style="width:70px;" onchange="updateMDX()">
                                    </div>
                                </div>
                            </div>
                            <!-- Title dim: element picker -->
                            <div id="dcElementWrap" class="hidden field">
                                <label class="field-label">Selected Element</label>
                                <input type="text" id="dcElementSearch" placeholder="Search title elements…" oninput="filterTitleElements()" style="margin-bottom:4px;">
                                <select id="dcElement" onchange="updateMDX()" size="6" style="width:100%;height:auto;">
                                    <option value="">Select element...</option>
                                </select>
                            </div>
                            <!-- TopCount / BottomCount (only for axis dims, hidden when custom subset is active) -->
                            <div id="dcTopBottomWrap" class="hidden">
                                <div class="field">
                                    <label class="field-label">Top / Bottom Count</label>
                                    <div style="display:flex;gap:6px;">
                                        <select id="dcTopBottomType" onchange="updateMDX()" style="flex:1;">
                                            <option value="none">None</option>
                                            <option value="topcount">TopCount</option>
                                            <option value="bottomcount">BottomCount</option>
                                        </select>
                                        <input type="number" id="dcTopBottomCount" min="1" value="10" style="width:70px;" onchange="updateMDX()">
                                    </div>
                                </div>
                                <div id="dcTopBottomMeasureWrap" class="hidden field">
                                    <label class="field-label">Measure (Element from Measures dimension)</label>
                                    <input type="text" id="dcTopBottomMeasure" placeholder="e.g. Value, Amount" oninput="updateMDX()">
                                </div>
                            </div>
                            <!-- Dimension Properties -->
                            <div id="dcPropertiesWrap" class="hidden">
                                <div class="field">
                                    <label class="field-label">Dimension Properties</label>
                                    <div id="dcPropertiesList"></div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- ============ MDX PREVIEW ============ -->
        <div class="preview-panel">
            <div class="preview-header">
                <span>Live MDX Preview</span>
                <div class="preview-actions">
                    <button class="btn btn-sm" onclick="copyMDX()" title="Copy to Clipboard">Copy</button>
                    <button class="btn btn-sm" onclick="insertMDX()" title="Insert into active Editor">Insert</button>
                    <button class="btn btn-sm" onclick="executeMDX()" title="Execute MDX and show results" style="background:var(--accent);color:var(--bg);">▶ Execute</button>
                </div>
            </div>
            <pre class="preview-code" id="mdxPreview">-- Select a dimension or cube to begin</pre>
            <div id="mdxResults" style="display:none;flex:1;overflow:hidden;display:flex;flex-direction:column;">
                <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-bottom:1px solid var(--border);flex-shrink:0;">
                    <span style="font-size:12px;font-weight:600;color:var(--accent);">Results <span id="mdxResultCount" style="font-weight:normal;color:var(--desc);"></span></span>
                    <button class="btn-icon" onclick="document.getElementById('mdxResults').style.display='none'" title="Close">✕</button>
                </div>
                <div id="mdxResultList" style="flex:1;overflow-y:auto;padding:4px 12px;font-size:12px;font-family:var(--vscode-editor-font-family, monospace);"></div>
            </div>
        </div>
    </div>
</div>`;
}

export function mdxBuilderScript(): string {
    return `let __pendingCube = '';

// ---- State ----
let mode = 'subset';
let subsetFilters = [];
let subsetSetOps = [];
let subsetMeta = { attributes: [], levelCount: 0, consolidatedElements: [], subsets: [] };
let subsetElements = []; // all elements for pick-members
let subsetSelectedMembers = [];

// View state
let viewDims = []; // { dimension, hierarchy, hierarchies, axis, subsetType, existingSubset, customConfig, meta, topBottom, properties, selectedMembers, allElements }
let viewCalcMembers = []; // { name, dimension, hierarchy, expression }
let currentConfigDimIdx = -1;

let currentMDX = '';

// ---- Init ----
let __pendingSubsetDim = '';
let __pendingSubsetHier = '';
let __allDims = [];
let __allCubes = [];
let mbShowControl = false;
function mbVisible(list) { return mbShowControl ? (list || []) : (list || []).filter(n => String(n).charAt(0) !== '}'); }
function syncControlChecks() { const boxes = document.querySelectorAll('.mbCtrl'); for (let i = 0; i < boxes.length; i++) { boxes[i].checked = mbShowControl; } }
function mbToggleControl(cb) {
    mbShowControl = !!(cb && cb.checked);
    syncControlChecks();
    fillSelect('sDimension', mbVisible(__allDims));
    fillSelect('vCube', mbVisible(__allCubes));
}
function mbInit(opts) {
    opts = opts || {};
    __pendingCube = opts.cube || '';
    __pendingSubsetDim = opts.dimension || '';
    __pendingSubsetHier = opts.hierarchy || '';
    vscode.postMessage({ command: 'getDimensions' });
    vscode.postMessage({ command: 'getCubes' });
    if (opts.mode === 'view') { switchMode('view'); }
}

// ---- Message handler ----
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.command) {
        case 'dimensions':
            __allDims = msg.dimensions || [];
            if (__pendingSubsetDim && String(__pendingSubsetDim).charAt(0) === '}') { mbShowControl = true; syncControlChecks(); }
            fillSelect('sDimension', mbVisible(__allDims));
            if (__pendingSubsetDim && mbVisible(__allDims).indexOf(__pendingSubsetDim) >= 0) {
                document.getElementById('sDimension').value = __pendingSubsetDim;
                __pendingSubsetDim = '';
                onSubsetDimensionChange();
            }
            break;
        case 'cubes':
            __allCubes = msg.cubes || [];
            {
                let __dl = document.getElementById('cubeList');
                if (!__dl) { __dl = document.createElement('datalist'); __dl.id = 'cubeList'; document.body.appendChild(__dl); }
                __dl.innerHTML = (__allCubes || []).map(c => '<option value="' + escHtml(c) + '"></option>').join('');
            }
            if (__pendingCube && String(__pendingCube).charAt(0) === '}') { mbShowControl = true; syncControlChecks(); }
            fillSelect('vCube', mbVisible(__allCubes));
            if (__pendingCube && mbVisible(__allCubes).indexOf(__pendingCube) >= 0) {
                document.getElementById('vCube').value = __pendingCube;
                __pendingCube = '';
                onCubeChange();
            }
            break;
        case 'hierarchies':
            fillSelect('sHierarchy', msg.hierarchies, __pendingSubsetHier || msg.dimension);
            __pendingSubsetHier = '';
            // Auto-trigger if a hierarchy was auto-selected
            if (document.getElementById('sHierarchy').value) {
                onSubsetHierarchyChange();
            }
            break;
        case 'hierarchyMeta':
            if (mode === 'subset') {
                subsetMeta = { attributes: msg.attributes, levelCount: msg.levelCount, consolidatedElements: msg.consolidatedElements, subsets: msg.subsets };
                const _lv = document.getElementById('sLevel');
                if (_lv && msg.levelCount) { _lv.max = Math.max(0, msg.levelCount - 1); }
                fillSelect('sStructElement', msg.consolidatedElements);
                renderSetOps();
                document.getElementById('subsetOptions').classList.remove('hidden');
                // Fetch all elements for pick-members
                vscode.postMessage({ command: 'getElements', dimension: document.getElementById('sDimension').value, hierarchy: document.getElementById('sHierarchy').value });
                updateMDX();
            } else {
                const idx = viewDims.findIndex(d => d.dimension === msg.dimension && d.hierarchy === msg.hierarchy);
                if (idx >= 0) {
                    viewDims[idx].meta = { attributes: msg.attributes, levelCount: msg.levelCount, consolidatedElements: msg.consolidatedElements, subsets: msg.subsets };
                    const _dl = document.getElementById('dcLevel');
                    if (_dl && currentConfigDimIdx === idx && msg.levelCount) { _dl.max = Math.max(0, msg.levelCount - 1); }
                    if (currentConfigDimIdx === idx) populateDimConfig(idx);
                }
            }
            break;
        case 'elements':
            if (mode === 'subset') {
                subsetElements = msg.elements || [];
                renderPickMembers();
            } else {
                const eIdx = viewDims.findIndex(d => d.dimension === msg.dimension && d.hierarchy === msg.hierarchy);
                if (eIdx >= 0) {
                    viewDims[eIdx].allElements = msg.elements || [];
                    if (currentConfigDimIdx === eIdx) {
                        renderDcMembers();
                        populateTitleElements(eIdx);
                    }
                }
            }
            break;
        case 'cubeDimensions':
            setupViewDims(msg.dimensions);
            break;
        case 'mdxResult':
            currentMDX = msg.mdx;
            document.getElementById('mdxPreview').textContent = msg.mdx || '-- No MDX generated';
            break;
        case 'executeMDXResult':
            {
                const resultsDiv = document.getElementById('mdxResults');
                const listDiv = document.getElementById('mdxResultList');
                const countSpan = document.getElementById('mdxResultCount');
                resultsDiv.style.display = 'flex';
                if (msg.error) {
                    listDiv.innerHTML = '<div style="color:#f44;">Error: ' + escHtml(msg.error) + '</div>';
                    countSpan.textContent = '';
                } else if (msg.members) {
                    countSpan.textContent = '(' + msg.members.length + ' elements)';
                    if (msg.members.length === 0) {
                        listDiv.innerHTML = '<div style="color:var(--desc);">No elements returned</div>';
                    } else {
                        listDiv.innerHTML = msg.members.map((m, idx) => '<div style="padding:2px 4px;' + (idx % 2 === 0 ? 'background:var(--hover);' : '') + '">' + escHtml(m) + '</div>').join('');
                    }
                }
            }
            break;
        case 'error':
            showStatus(msg.message, true);
            break;
        case 'wizardInit':
            if (msg.mode === 'view') { switchMode('view'); }
            if (msg.cube) {
                const sel = document.getElementById('vCube');
                if (sel && Array.from(sel.options).some(o => o.value === msg.cube)) {
                    sel.value = msg.cube; onCubeChange();
                } else {
                    __pendingCube = msg.cube;
                }
            }
            break;
    }
});

// ---- Utilities ----
function fillSelect(id, items, defaultValue) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select...</option>' + items.map(i => '<option value="' + escHtml(i) + '">' + escHtml(i) + '</option>').join('');
    // Auto-select same-name hierarchy or restore previous
    if (defaultValue && items.includes(defaultValue)) sel.value = defaultValue;
    else if (prev && items.includes(prev)) sel.value = prev;
}

function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function showStatus(text, isError) {
    const el = document.getElementById('statusMsg');
    el.textContent = text;
    el.className = isError ? 'status error' : 'status';
    if (!isError) setTimeout(() => el.textContent = '', 4000);
}

function getRadio(name) { const r = document.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ''; }
function mbClampLevel(el) { if (!el) { return; } let v = String(el.value).replace(/[^0-9]/g, ''); if (v.length > 2) { v = v.slice(0, 2); } const max = parseInt(el.max) || 50; if (v !== '' && parseInt(v) > max) { v = String(max); } el.value = v; }

// ---- Mode switching ----
function switchMode(m) {
    mode = m;
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === m));
    document.getElementById('subsetMode').classList.toggle('hidden', m !== 'subset');
    document.getElementById('viewMode').classList.toggle('hidden', m !== 'view');
    updateMDX();
}

// ============================================================
// SUBSET BUILDER
// ============================================================
function onSubsetDimensionChange() {
    const dim = document.getElementById('sDimension').value;
    document.getElementById('subsetOptions').classList.add('hidden');
    subsetFilters = [];
    subsetSetOps = [];
    subsetElements = [];
    subsetSelectedMembers = [];
    renderFilters();
    renderSetOps();
    if (dim) vscode.postMessage({ command: 'getHierarchies', dimension: dim });
}

function onSubsetHierarchyChange() {
    const dim = document.getElementById('sDimension').value;
    const hier = document.getElementById('sHierarchy').value;
    if (dim && hier) {
        vscode.postMessage({ command: 'getHierarchyMeta', dimension: dim, hierarchy: hier });
    }
}

function addFilter(type) {
    subsetFilters.push({ type, pattern: '', attributeName: '', operator: '=', value: '', cube: '', measure: '', tupleElements: [{ dimension: '', element: '' }], valueOperator: '>', threshold: '0', thresholdType: 'numeric' });
    renderFilters();
}

function removeFilter(idx) {
    subsetFilters.splice(idx, 1);
    renderFilters();
    updateMDX();
}

function addTupleElement(filterIdx) {
    if (!subsetFilters[filterIdx].tupleElements) subsetFilters[filterIdx].tupleElements = [];
    subsetFilters[filterIdx].tupleElements.push({ dimension: '', element: '' });
    renderFilters();
}

function removeTupleElement(filterIdx, tupleIdx) {
    subsetFilters[filterIdx].tupleElements.splice(tupleIdx, 1);
    renderFilters();
    updateMDX();
}

// Clear the current selection so the user can start over (Subset or View mode).
// In the Cube Viewer (a view is loaded) this restores the builder to that view.
function resetBuilder() {
    if (mode === 'view' && typeof window !== 'undefined' && window.__mbLayoutHint && document.getElementById('vCube').value) {
        // Rebuild from the current view's layout hint (restores axes & members).
        if (typeof onCubeChange === 'function') { onCubeChange(); }
        return;
    }
    if (mode === 'subset') {
        subsetFilters = [];
        subsetSetOps = [];
        subsetSelectedMembers = [];
        const setChecked = (name, val) => { const r = document.querySelector('input[name="' + name + '"][value="' + val + '"]'); if (r) { r.checked = true; } };
        setChecked('sBase', 'all');
        setChecked('sStruct', 'none');
        ['sLevel'].forEach(id => { const e = document.getElementById(id); if (e) { e.value = '0'; } });
        ['sSortCube', 'sSortMeasure', 'sTopBottomCube', 'sTopBottomMeasure'].forEach(id => { const e = document.getElementById(id); if (e) { e.value = ''; } });
        ['sSortType', 'sSortDir', 'sTopBottomType', 'sHeadTailType'].forEach(id => { const e = document.getElementById(id); if (e) { e.selectedIndex = 0; } });
        const tbc = document.getElementById('sTopBottomCount'); if (tbc) { tbc.value = '10'; }
        const htc = document.getElementById('sHeadTailCount'); if (htc) { htc.value = '10'; }
        const rc = document.getElementById('sSubsetRange'); if (rc) { rc.checked = false; }
        if (typeof onSubsetBaseChange === 'function') { onSubsetBaseChange(); }
        if (typeof onSortTypeChange === 'function') { onSortTypeChange(); }
        if (typeof onSubsetTopBottomChange === 'function') { onSubsetTopBottomChange(); }
        renderFilters();
        renderSetOps();
        renderPickMembers();
    } else {
        for (const d of viewDims) {
            d.subsetType = 'all'; d.selectedMembers = []; d.customConfig = null;
            d.existingSubset = ''; d.drilldownElement = '';
            d.topBottom = { type: 'none', count: 10, cube: '', measure: '' };
            d.properties = [];
        }
        viewCalcMembers = [];
        renderCalcMembers();
        closeDimConfig();
        renderAxes();
    }
    updateMDX();
}

function renderFilters() {
    const container = document.getElementById('filterList');
    if (subsetFilters.length === 0) { container.innerHTML = '<div style="color:var(--desc);font-size:12px;">No filters added</div>'; return; }
    let html = '';
    subsetFilters.forEach((f, i) => {
        if (f.type === 'pattern') {
            html += '<div class="filter-row"><span style="font-size:11px;color:var(--desc);width:60px;">Pattern</span>'
                + '<input type="text" placeholder="e.g. *Sales*" value="' + escHtml(f.pattern || '') + '" oninput="subsetFilters[' + i + '].pattern=this.value;updateMDX()">'
                + '<button class="btn-icon btn-danger" onclick="removeFilter(' + i + ')" title="Remove">✕</button></div>';
        } else if (f.type === 'attribute') {
            const attrOpts = subsetMeta.attributes.map(a => '<option value="' + escHtml(a.Name) + '"' + (f.attributeName === a.Name ? ' selected' : '') + '>' + escHtml(a.Name) + '</option>').join('');
            html += '<div class="filter-row"><select onchange="subsetFilters[' + i + '].attributeName=this.value;updateMDX()" style="min-width:100px;"><option value="">Attribute...</option>' + attrOpts + '</select>'
                + '<select onchange="subsetFilters[' + i + '].operator=this.value;updateMDX()" style="width:70px;"><option value="="' + (f.operator === '=' ? ' selected' : '') + '>=</option><option value="<>"' + (f.operator === '<>' ? ' selected' : '') + '><></option><option value="CONTAINS"' + (f.operator === 'CONTAINS' ? ' selected' : '') + '>Contains</option></select>'
                + '<input type="text" placeholder="Value" value="' + escHtml(f.value || '') + '" oninput="subsetFilters[' + i + '].value=this.value;updateMDX()">'
                + '<button class="btn-icon btn-danger" onclick="removeFilter(' + i + ')" title="Remove">✕</button></div>';
        } else if (f.type === 'value') {
            if (!f.tupleElements) f.tupleElements = [{ dimension: '', element: '' }];
            if (!f.thresholdType) f.thresholdType = 'numeric';
            const opSel = function(val, label) { return '<option value="' + val + '"' + (f.valueOperator === val ? ' selected' : '') + '>' + label + '</option>'; };
            let tupleHtml = '';
            f.tupleElements.forEach((te, ti) => {
                tupleHtml += '<div style="display:flex;gap:4px;margin-bottom:3px;">'
                    + '<input type="text" placeholder="Dimension" value="' + escHtml(te.dimension || '') + '" oninput="subsetFilters[' + i + '].tupleElements[' + ti + '].dimension=this.value;updateMDX()" style="flex:1;">'
                    + '<input type="text" placeholder="Element" value="' + escHtml(te.element || '') + '" oninput="subsetFilters[' + i + '].tupleElements[' + ti + '].element=this.value;updateMDX()" style="flex:1;">'
                    + (f.tupleElements.length > 1 ? '<button class="btn-icon btn-danger" onclick="removeTupleElement(' + i + ',' + ti + ')" title="Remove" style="flex:0;">✕</button>' : '')
                    + '</div>';
            });
            html += '<div style="border:1px solid var(--border);border-radius:3px;padding:6px;margin-bottom:4px;">'
                + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span style="font-size:11px;color:var(--accent);font-weight:600;">Cube Value Filter</span>'
                + '<button class="btn-icon btn-danger" onclick="removeFilter(' + i + ')" title="Remove">✕</button></div>'
                + '<div style="display:flex;gap:4px;margin-bottom:4px;">'
                + '<input type="text" placeholder="Cube" list="cubeList" value="' + escHtml(f.cube || '') + '" oninput="subsetFilters[' + i + '].cube=this.value;updateMDX()" style="flex:1;"></div>'
                + '<div style="font-size:11px;color:var(--desc);margin-bottom:3px;">Dimension / Element (Tuple):</div>'
                + tupleHtml
                + '<button class="btn" style="font-size:11px;padding:2px 8px;margin-bottom:4px;" onclick="addTupleElement(' + i + ')">+ Dimension</button>'
                + '<div style="display:flex;gap:4px;">'
                + '<select onchange="subsetFilters[' + i + '].valueOperator=this.value;updateMDX()" style="width:60px;">'
                + opSel('>','>') + opSel('<','<') + opSel('>=','>=') + opSel('<=','<=') + opSel('=','=') + opSel('<>','<>') + '</select>'
                + '<select onchange="subsetFilters[' + i + '].thresholdType=this.value;updateMDX()" style="width:70px;"><option value="numeric"' + (f.thresholdType === 'numeric' ? ' selected' : '') + '>Number</option><option value="string"' + (f.thresholdType === 'string' ? ' selected' : '') + '>String</option></select>'
                + '<input type="text" placeholder="Threshold" value="' + escHtml(f.threshold || '') + '" oninput="subsetFilters[' + i + '].threshold=this.value;updateMDX()" style="flex:1;">'
                + '</div></div>';
        }
    });
    container.innerHTML = html;
}

// ---- Set Operations ----
function addSetOp(type) {
    subsetSetOps.push({ type, operandType: 'existing', existingSubset: '', expression: '' });
    renderSetOps();
}

function removeSetOp(idx) {
    subsetSetOps.splice(idx, 1);
    renderSetOps();
    updateMDX();
}

function renderSetOps() {
    const container = document.getElementById('setOpList');
    if (subsetSetOps.length === 0) { container.innerHTML = '<div style="color:var(--desc);font-size:12px;">No set operations</div>'; return; }
    const subsetOpts = subsetMeta.subsets.map(s => '<option value="' + escHtml(s) + '">' + escHtml(s) + '</option>').join('');
    let html = '';
    subsetSetOps.forEach((op, i) => {
        const typeLabel = op.type.toUpperCase();
        html += '<div style="border:1px solid var(--border);border-radius:3px;padding:6px;margin-bottom:6px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
            + '<span style="font-size:11px;font-weight:600;color:var(--accent);">' + typeLabel + '</span>'
            + '<button class="btn-icon btn-danger" onclick="removeSetOp(' + i + ')" title="Remove">✕</button></div>'
            + '<div style="display:flex;gap:6px;margin-bottom:4px;">'
            + '<label style="font-size:12px;display:flex;align-items:center;gap:3px;"><input type="radio" name="setOpSrc' + i + '" value="existing"' + (op.operandType === 'existing' ? ' checked' : '') + ' onchange="subsetSetOps[' + i + '].operandType=\\'existing\\';renderSetOps();updateMDX()"> Existing Subset</label>'
            + '<label style="font-size:12px;display:flex;align-items:center;gap:3px;"><input type="radio" name="setOpSrc' + i + '" value="expression"' + (op.operandType === 'expression' ? ' checked' : '') + ' onchange="subsetSetOps[' + i + '].operandType=\\'expression\\';renderSetOps();updateMDX()"> MDX Expression</label>'
            + '</div>';
        if (op.operandType === 'existing') {
            html += '<select onchange="subsetSetOps[' + i + '].existingSubset=this.value;updateMDX()"><option value="">Select subset...</option>' + subsetOpts.replace('value="' + escHtml(op.existingSubset) + '"', 'value="' + escHtml(op.existingSubset) + '" selected') + '</select>';
        } else {
            html += '<input type="text" placeholder="e.g. {[Dim].[Hier].[Element1], [Dim].[Hier].[Element2]}" value="' + escHtml(op.expression || '') + '" oninput="subsetSetOps[' + i + '].expression=this.value;updateMDX()">';
        }
        html += '</div>';
    });
    container.innerHTML = html;
}

// ---- Calculated Members (View Builder) ----
function addCalcMember() {
    viewCalcMembers.push({ name: '', dimension: '', hierarchy: '', expression: '', solveOrder: viewCalcMembers.length + 1, formatString: '' });
    renderCalcMembers();
}

function removeCalcMember(idx) {
    viewCalcMembers.splice(idx, 1);
    renderCalcMembers();
    updateMDX();
}

function applyCalcTemplate(idx, template) {
    const cm = viewCalcMembers[idx];
    switch (template) {
        case 'variance':
            cm.expression = '[Measures].[Actual] - [Measures].[Budget]';
            cm.name = cm.name || 'Variance';
            break;
        case 'variance_pct':
            cm.expression = 'IIF(\\n  [Measures].[Budget] = 0,\\n  NULL,\\n  ([Measures].[Actual] - [Measures].[Budget]) / [Measures].[Budget]\\n)';
            cm.name = cm.name || 'Variance %';
            cm.formatString = cm.formatString || '0.00%';
            break;
        case 'sum':
            cm.expression = 'SUM(\\n  {TM1SubsetToSet([Dim].[Dim], "SubsetName", "public")}\\n)';
            cm.name = cm.name || 'Total';
            break;
        case 'avg':
            cm.expression = 'AVG(\\n  {TM1SubsetToSet([Dim].[Dim], "SubsetName", "public")}\\n)';
            cm.name = cm.name || 'Average';
            break;
        case 'min':
            cm.expression = 'MIN(\\n  {TM1FILTERBYLEVEL(TM1SUBSETALL([Dim].[Dim]), 0)},\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'MIN';
            break;
        case 'max':
            cm.expression = 'MAX(\\n  {TM1FILTERBYLEVEL(TM1SUBSETALL([Dim].[Dim]), 0)},\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'MAX';
            break;
        case 'ytd':
            cm.expression = 'SUM(\\n  PeriodsToDate([Period].[Period].[Years], [Period].[Period].CurrentMember),\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'YTD';
            break;
        case 'ytd_avg':
            cm.expression = 'AVG(\\n  PeriodsToDate([Period].[Period].[Years], [Period].[Period].CurrentMember),\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'YTD Average';
            break;
        case 'prior_period':
            cm.expression = '(\\n  [Period].[Period].CurrentMember.Lag(1),\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'Prior Period';
            break;
        case 'prior_year':
            cm.expression = '(\\n  [Period].[Period].CurrentMember.Lag(12),\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || 'Prior Year';
            break;
        case 'rolling_avg':
            cm.expression = 'AVG(\\n  LastPeriods(3, [Period].[Period].CurrentMember),\\n  [Measures].[Value]\\n)';
            cm.name = cm.name || '3mo Average';
            break;
        case 'multiply':
            cm.expression = '[Measures].[Sales Revenue] * 0.15';
            cm.name = cm.name || 'Calculated';
            break;
    }
    // Unescape newlines
    cm.expression = cm.expression.replace(/\\\\n/g, '\\n');
    renderCalcMembers();
    updateMDX();
}

function renderCalcMembers() {
    const container = document.getElementById('calcMemberList');
    if (viewCalcMembers.length === 0) { container.innerHTML = '<div style="color:var(--desc);font-size:12px;">No calculated members</div>'; return; }
    let html = '';
    viewCalcMembers.forEach((cm, i) => {
        html += '<div style="border:1px solid var(--border);border-radius:3px;padding:6px;margin-bottom:6px;">'
            + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
            + '<span style="font-size:11px;font-weight:600;color:var(--accent);">Member #' + (i + 1) + '</span>'
            + '<button class="btn-icon btn-danger" onclick="removeCalcMember(' + i + ')" title="Remove">✕</button></div>'
            // Template selector
            + '<div class="field"><label class="field-label">Template (optional)</label>'
            + '<select onchange="applyCalcTemplate(' + i + ',this.value);this.value=\\'\\';" style="font-size:12px;">'
            + '<option value="">Apply template...</option>'
            + '<optgroup label="Arithmetic">'
            + '<option value="variance">Variance (A - B)</option>'
            + '<option value="variance_pct">Variance % (IIF)</option>'
            + '<option value="multiply">Multiply (× constant)</option>'
            + '</optgroup>'
            + '<optgroup label="Aggregation">'
            + '<option value="sum">SUM (over set)</option>'
            + '<option value="avg">AVG (over set)</option>'
            + '<option value="min">MIN (over set)</option>'
            + '<option value="max">MAX (over set)</option>'
            + '</optgroup>'
            + '<optgroup label="Time Intelligence">'
            + '<option value="ytd">YTD (PeriodsToDate + SUM)</option>'
            + '<option value="ytd_avg">YTD Average (PeriodsToDate + AVG)</option>'
            + '<option value="prior_period">Prior Period (Lag 1)</option>'
            + '<option value="prior_year">Prior Year (Lag 12)</option>'
            + '<option value="rolling_avg">Rolling Average (LastPeriods)</option>'
            + '</optgroup>'
            + '</select></div>'
            // Name
            + '<div class="field"><label class="field-label">Name</label>'
            + '<input type="text" placeholder="e.g. Variance, YTD, Sub-Total" value="' + escHtml(cm.name) + '" oninput="viewCalcMembers[' + i + '].name=this.value;updateMDX()"></div>'
            // Dimension.Hierarchy
            + '<div class="field"><label class="field-label">Dimension.Hierarchy (optional, default: Measures)</label>'
            + '<div style="display:flex;gap:4px;"><input type="text" placeholder="Dimension" value="' + escHtml(cm.dimension) + '" oninput="viewCalcMembers[' + i + '].dimension=this.value;updateMDX()" style="flex:1;">'
            + '<input type="text" placeholder="Hierarchy" value="' + escHtml(cm.hierarchy) + '" oninput="viewCalcMembers[' + i + '].hierarchy=this.value;updateMDX()" style="flex:1;"></div></div>'
            // Expression (textarea)
            + '<div class="field"><label class="field-label">Expression</label>'
            + '<textarea rows="3" placeholder="e.g. [Measures].[Actual] - [Measures].[Budget]" oninput="viewCalcMembers[' + i + '].expression=this.value;updateMDX()">' + escHtml(cm.expression) + '</textarea></div>'
            // SOLVE_ORDER + FORMAT_STRING
            + '<div style="display:flex;gap:6px;">'
            + '<div class="field" style="flex:1;"><label class="field-label">Solve Order</label>'
            + '<input type="number" min="0" value="' + (cm.solveOrder || 1) + '" onchange="viewCalcMembers[' + i + '].solveOrder=parseInt(this.value);updateMDX()"></div>'
            + '<div class="field" style="flex:2;"><label class="field-label">Format String</label>'
            + '<input type="text" placeholder="e.g. #,##0.00;(#,##0.00)" value="' + escHtml(cm.formatString || '') + '" oninput="viewCalcMembers[' + i + '].formatString=this.value;updateMDX()"></div>'
            + '</div>'
            + '</div>';
    });
    container.innerHTML = html;
}

// ---- Sort Type Toggle ----
function onSortTypeChange() {
    const type = document.getElementById('sSortType').value;
    document.getElementById('sortValueFields').classList.toggle('hidden', type !== 'byvalue');
    document.getElementById('sortAttrField').classList.toggle('hidden', type !== 'byattribute');
    // Populate attribute dropdown for sort-by-attribute
    if (type === 'byattribute') {
        const sel = document.getElementById('sSortAttr');
        sel.innerHTML = '<option value="">Select attribute...</option>' + subsetMeta.attributes.map(a => '<option value="' + escHtml(a.Name) + '">' + escHtml(a.Name) + '</option>').join('');
    }
    updateMDX();
}

// ---- Subset TopCount/BottomCount Toggle ----
function onSubsetTopBottomChange() {
    const type = document.getElementById('sTopBottomType').value;
    document.getElementById('sTopBottomFields').classList.toggle('hidden', type === 'none');
    updateMDX();
}

// ============================================================
// VIEW BUILDER
// ============================================================
function onCubeChange() {
    const cube = document.getElementById('vCube').value;
    document.getElementById('viewOptions').classList.add('hidden');
    closeDimConfig();
    if (cube) vscode.postMessage({ command: 'getCubeDimensions', cube });
}

function setupViewDims(dims) {
    const hint = (typeof window !== 'undefined' && window.__mbLayoutHint) ? window.__mbLayoutHint : null;
    function axisFor(name, i) {
        if (hint) {
            if ((hint.cols || []).indexOf(name) >= 0) { return 'cols'; }
            if ((hint.rows || []).indexOf(name) >= 0) { return 'rows'; }
            if ((hint.titles || []).indexOf(name) >= 0) { return 'titles'; }
        }
        return i === 0 ? 'cols' : (i === 1 ? 'rows' : 'titles');
    }
    viewDims = dims.map((d, i) => {
        const axis = axisFor(d.Name, i);
        const memberList = (hint && hint.members && hint.members[d.Name]) ? hint.members[d.Name] : null;
        const isAxis = axis === 'cols' || axis === 'rows';
        const hasMembers = isAxis && memberList && memberList.length > 0;
        return {
            dimension: d.Name,
            hierarchy: (hint && hint.hierarchies && hint.hierarchies[d.Name]) || d.Name,
            hierarchies: (d.Hierarchies || []).map(h => h.Name),
            axis: axis,
            subsetType: hasMembers ? 'members' : 'all',
            selectedElement: (hint && hint.titleMembers && hint.titleMembers[d.Name]) ? hint.titleMembers[d.Name] : '',
            existingSubset: '',
            customConfig: null,
            drilldownElement: '',
            selectedMembers: hasMembers ? memberList.slice() : [],
            allElements: [],
            meta: null,
            topBottom: { type: 'none', count: 10, cube: '', measure: '' },
            properties: [],
            dcFilters: [],
            dcSorting: { type: 'none', direction: 'ASC', cube: '', measure: '', attributeName: '' },
            dcTopBottom: { type: 'none', count: 10, cube: '', measure: '' },
            dcHeadTail: { type: 'none', count: 10 }
        };
    });
    viewCalcMembers = [];
    renderCalcMembers();
    document.getElementById('viewOptions').classList.remove('hidden');
    renderAxes();
    updateMDX();
}

function renderAxes() {
    const buckets = { cols: [], rows: [], titles: [], unassigned: [] };
    viewDims.forEach((d, i) => { (buckets[d.axis] || buckets.unassigned).push({ ...d, idx: i }); });

    ['cols', 'rows', 'titles', 'unassigned'].forEach(axis => {
        const containerId = axis === 'cols' ? 'axisCols' : axis === 'rows' ? 'axisRows' : axis === 'titles' ? 'axisTitles' : 'axisUnassigned';
        const container = document.getElementById(containerId);
        if (buckets[axis].length === 0) {
            container.innerHTML = '<div style="color:var(--desc);font-size:11px;padding:4px;">Drop dimensions here</div>';
            return;
        }
        container.innerHTML = buckets[axis].map(d => {
            const moveOpts = ['cols', 'rows', 'titles', 'unassigned'].filter(a => a !== axis);
            const moveButtons = moveOpts.map(a => {
                const label = a === 'cols' ? 'Col' : a === 'rows' ? 'Row' : a === 'titles' ? 'Title' : 'None';
                return '<button class="btn btn-sm" onclick="mbMoveDim(' + d.idx + ',\\'' + a + '\\')" style="font-size:10px;padding:2px 5px;">' + label + '</button>';
            }).join(' ');
            const configLabel = d.axis === 'titles' ? '(' + (d.selectedElement ? escHtml(d.selectedElement) : 'All') + ')' : d.subsetType === 'existing' ? '(Subset: ' + escHtml(d.existingSubset || '?') + ')' : d.subsetType === 'custom' ? '(Custom MDX)' : d.subsetType === 'drilldown' ? '(DrillDown: ' + escHtml(d.drilldownElement || '?') + ')' : d.subsetType === 'members' ? '(' + (d.selectedMembers || []).length + ' members)' : '(All)';
            const hierLabel = d.hierarchy !== d.dimension ? ' [' + escHtml(d.hierarchy) + ']' : '';
            const extras = [];
            if (d.topBottom && d.topBottom.type !== 'none') extras.push(d.topBottom.type === 'topcount' ? 'Top ' + d.topBottom.count : 'Bottom ' + d.topBottom.count);
            if (d.properties && d.properties.length > 0) extras.push(d.properties.length + ' prop' + (d.properties.length > 1 ? 's' : ''));
            const extraLabel = extras.length > 0 ? ' · ' + extras.join(', ') : '';
            return '<div class="dim-chip"><span class="chip-name">' + escHtml(d.dimension) + hierLabel + '</span>'
                + '<span style="font-size:11px;color:var(--desc);">' + configLabel + extraLabel + '</span>'
                + '<span class="chip-config" onclick="openDimConfig(' + d.idx + ')">Configure</span>'
                + '<span style="display:flex;gap:2px;margin-left:4px;">' + moveButtons + '</span></div>';
        }).join('');
    });
}

function mbMoveDim(idx, axis) {
    viewDims[idx].axis = axis;
    closeDimConfig();
    renderAxes();
    updateMDX();
}

function openDimConfig(idx) {
    currentConfigDimIdx = idx;
    const d = viewDims[idx];
    document.getElementById('dimConfigPanel').classList.remove('hidden');
    document.getElementById('dimConfigTitle').textContent = 'Configure: ' + d.dimension;

    // Populate hierarchy selector
    const hierSel = document.getElementById('dcHierarchy');
    hierSel.innerHTML = d.hierarchies.map(h => '<option value="' + escHtml(h) + '"' + (h === d.hierarchy ? ' selected' : '') + '>' + escHtml(h) + '</option>').join('');

    // Fetch meta if not loaded
    if (!d.meta) {
        vscode.postMessage({ command: 'getHierarchyMeta', dimension: d.dimension, hierarchy: d.hierarchy });
    }
    // Fetch all elements if not loaded
    if (!d.allElements || d.allElements.length === 0) {
        vscode.postMessage({ command: 'getElements', dimension: d.dimension, hierarchy: d.hierarchy });
    }

    // Show/hide element picker for titles
    document.getElementById('dcElementWrap').classList.toggle('hidden', d.axis !== 'titles');
    if (d.axis === 'titles') {
        populateTitleElements(idx);
    }

    // Show/hide TopBottom for axis dims (cols/rows)
    const isAxisDim = d.axis === 'cols' || d.axis === 'rows';
    document.getElementById('dcTopBottomWrap').classList.toggle('hidden', !isAxisDim);
    if (isAxisDim && d.topBottom) {
        document.getElementById('dcTopBottomType').value = d.topBottom.type || 'none';
        document.getElementById('dcTopBottomCount').value = d.topBottom.count || 10;
        document.getElementById('dcTopBottomMeasure').value = d.topBottom.measure || '';
        document.getElementById('dcTopBottomMeasureWrap').classList.toggle('hidden', d.topBottom.type === 'none');
    }

    // Show/hide Properties for axis dims
    document.getElementById('dcPropertiesWrap').classList.toggle('hidden', !isAxisDim);

    document.getElementById('dcSubsetType').value = d.subsetType || 'all';
    onDcSubsetTypeChange();
    populateDimConfig(idx);

    // Restore drilldown element if applicable
    if (d.subsetType === 'drilldown' && d.drilldownElement) {
        document.getElementById('dcDrilldownElement').value = d.drilldownElement;
    }

    // Restore inline custom subset fields from customConfig or per-dim state
    if (d.customConfig) {
        // Restore base selection
        const baseRadio = document.querySelector('input[name="dcBase"][value="' + (d.customConfig.baseSelection || 'all') + '"]');
        if (baseRadio) baseRadio.checked = true;
        document.getElementById('dcLevel').value = d.customConfig.levelIndex || 0;
        // Restore structure
        const structRadio = document.querySelector('input[name="dcStruct"][value="' + (d.customConfig.structureType || 'none') + '"]');
        if (structRadio) structRadio.checked = true;
        if (d.customConfig.structureElement) {
            setTimeout(() => { document.getElementById('dcStructElement').value = d.customConfig.structureElement; }, 50);
        }
    }
    // Restore inline sorting
    const sorting = d.dcSorting || { type: 'none', direction: 'ASC' };
    document.getElementById('dcSortType').value = sorting.type;
    document.getElementById('dcSortDir').value = sorting.direction;
    document.getElementById('dcSortCube').value = sorting.cube || '';
    document.getElementById('dcSortMeasure').value = sorting.measure || '';
    document.getElementById('dcSortValueFields').classList.toggle('hidden', sorting.type !== 'byvalue');
    document.getElementById('dcSortAttrField').classList.toggle('hidden', sorting.type !== 'byattribute');
    // Restore inline topBottom
    const stb = d.dcTopBottom || { type: 'none', count: 10 };
    document.getElementById('dcSubTopBottomType').value = stb.type;
    document.getElementById('dcSubTopBottomCount').value = stb.count || 10;
    document.getElementById('dcSubTopBottomCube').value = stb.cube || '';
    document.getElementById('dcSubTopBottomMeasure').value = stb.measure || '';
    document.getElementById('dcSubTopBottomFields').classList.toggle('hidden', stb.type === 'none');
    // Restore inline headTail
    const ht = d.dcHeadTail || { type: 'none', count: 10 };
    document.getElementById('dcHeadTailType').value = ht.type;
    document.getElementById('dcHeadTailCount').value = ht.count || 10;
    // Render inline filters
    renderDcFilters();
}

function populateDimConfig(idx) {
    const d = viewDims[idx];
    if (!d.meta) return;
    const _dl = document.getElementById('dcLevel');
    if (_dl && d.meta.levelCount) { _dl.max = Math.max(0, d.meta.levelCount - 1); }
    // Fill existing subsets
    const esSel = document.getElementById('dcExistingSubset');
    esSel.innerHTML = '<option value="">Select...</option>' + d.meta.subsets.map(s => '<option value="' + escHtml(s) + '"' + (d.existingSubset === s ? ' selected' : '') + '>' + escHtml(s) + '</option>').join('');
    // Fill consolidated elements (for structure + drilldown)
    const ceSel = document.getElementById('dcStructElement');
    ceSel.innerHTML = '<option value="">Parent element...</option>' + d.meta.consolidatedElements.map(e => '<option value="' + escHtml(e) + '">' + escHtml(e) + '</option>').join('');
    const ddSel = document.getElementById('dcDrilldownElement');
    ddSel.innerHTML = '<option value="">Select element...</option>' + d.meta.consolidatedElements.map(e => '<option value="' + escHtml(e) + '"' + (d.drilldownElement === e ? ' selected' : '') + '>' + escHtml(e) + '</option>').join('');
    // Fill dimension properties checkboxes
    const propContainer = document.getElementById('dcPropertiesList');
    if (d.meta.attributes && d.meta.attributes.length > 0) {
        const selectedProps = d.properties || [];
        propContainer.innerHTML = d.meta.attributes.map(a => {
            const checked = selectedProps.includes(a.Name) ? ' checked' : '';
            return '<div class="checkbox-row"><input type="checkbox"' + checked + ' onchange="toggleDimProperty(' + idx + ',\\'' + escHtml(a.Name) + '\\',this.checked)"><label style="font-size:12px;">' + escHtml(a.Name) + ' <span style="color:var(--desc);font-size:11px;">(' + escHtml(a.Type || '') + ')</span></label></div>';
        }).join('');
    } else {
        propContainer.innerHTML = '<div style="color:var(--desc);font-size:12px;">No attributes available</div>';
    }
}

function closeDimConfig() {
    currentConfigDimIdx = -1;
    document.getElementById('dimConfigPanel').classList.add('hidden');
}

function onDcSubsetTypeChange() {
    const type = document.getElementById('dcSubsetType').value;
    document.getElementById('dcExistingWrap').classList.toggle('hidden', type !== 'existing');
    document.getElementById('dcCustomWrap').classList.toggle('hidden', type !== 'custom');
    document.getElementById('dcDrilldownWrap').classList.toggle('hidden', type !== 'drilldown');
    document.getElementById('dcMembersWrap').classList.toggle('hidden', type !== 'members');
    // Toggle TopBottom measure visibility
    const tbType = document.getElementById('dcTopBottomType').value;
    document.getElementById('dcTopBottomMeasureWrap').classList.toggle('hidden', tbType === 'none');
    // Hide outer TopBottom when custom subset is active (it has its own)
    const isAxisDim = currentConfigDimIdx >= 0 && (viewDims[currentConfigDimIdx].axis === 'cols' || viewDims[currentConfigDimIdx].axis === 'rows');
    document.getElementById('dcTopBottomWrap').classList.toggle('hidden', !isAxisDim || type === 'custom');
    if (currentConfigDimIdx >= 0) {
        viewDims[currentConfigDimIdx].subsetType = type;
        // Populate members list
        if (type === 'members') renderDcMembers();
        // Populate drilldown elements from meta if available
        if (type === 'drilldown' && viewDims[currentConfigDimIdx].meta) {
            const ddSel = document.getElementById('dcDrilldownElement');
            const consEls = viewDims[currentConfigDimIdx].meta.consolidatedElements;
            ddSel.innerHTML = '<option value="">Select element...</option>' + consEls.map(e => '<option value="' + escHtml(e) + '">' + escHtml(e) + '</option>').join('');
            if (viewDims[currentConfigDimIdx].drilldownElement) {
                ddSel.value = viewDims[currentConfigDimIdx].drilldownElement;
            }
        }
        renderAxes();
        updateMDX();
    }
}

function toggleDimProperty(idx, propName, checked) {
    if (!viewDims[idx].properties) viewDims[idx].properties = [];
    if (checked) {
        if (!viewDims[idx].properties.includes(propName)) viewDims[idx].properties.push(propName);
    } else {
        viewDims[idx].properties = viewDims[idx].properties.filter(p => p !== propName);
    }
    updateMDX();
}

// ---- Inline Dimension Config Filters ----
function addDcFilter(type) {
    if (currentConfigDimIdx < 0) return;
    if (!viewDims[currentConfigDimIdx].dcFilters) viewDims[currentConfigDimIdx].dcFilters = [];
    viewDims[currentConfigDimIdx].dcFilters.push({ type, pattern: '', attributeName: '', operator: '=', value: '', cube: '', measure: '', valueOperator: '>', threshold: '0' });
    renderDcFilters();
}

function removeDcFilter(idx) {
    if (currentConfigDimIdx < 0) return;
    viewDims[currentConfigDimIdx].dcFilters.splice(idx, 1);
    renderDcFilters();
    updateMDX();
}

function renderDcFilters() {
    const container = document.getElementById('dcFilterList');
    if (currentConfigDimIdx < 0) { container.innerHTML = ''; return; }
    const filters = viewDims[currentConfigDimIdx].dcFilters || [];
    const meta = viewDims[currentConfigDimIdx].meta || { attributes: [] };
    if (filters.length === 0) { container.innerHTML = '<div style="color:var(--desc);font-size:12px;">No filters</div>'; return; }
    const di = currentConfigDimIdx;
    let html = '';
    filters.forEach((f, i) => {
        if (f.type === 'pattern') {
            html += '<div class="filter-row"><span style="font-size:11px;color:var(--desc);width:55px;">Pattern</span>'
                + '<input type="text" placeholder="e.g. *Sales*" value="' + escHtml(f.pattern || '') + '" oninput="viewDims[' + di + '].dcFilters[' + i + '].pattern=this.value;updateMDX()">'
                + '<button class="btn-icon btn-danger" onclick="removeDcFilter(' + i + ')">✕</button></div>';
        } else if (f.type === 'attribute') {
            const attrOpts = meta.attributes.map(a => '<option value="' + escHtml(a.Name) + '"' + (f.attributeName === a.Name ? ' selected' : '') + '>' + escHtml(a.Name) + '</option>').join('');
            html += '<div class="filter-row"><select onchange="viewDims[' + di + '].dcFilters[' + i + '].attributeName=this.value;updateMDX()" style="min-width:80px;"><option value="">Attr...</option>' + attrOpts + '</select>'
                + '<select onchange="viewDims[' + di + '].dcFilters[' + i + '].operator=this.value;updateMDX()" style="width:55px;"><option value="="' + (f.operator === '=' ? ' selected' : '') + '>=</option><option value="<>"' + (f.operator === '<>' ? ' selected' : '') + '><></option><option value="CONTAINS"' + (f.operator === 'CONTAINS' ? ' selected' : '') + '>Contains</option></select>'
                + '<input type="text" placeholder="Value" value="' + escHtml(f.value || '') + '" oninput="viewDims[' + di + '].dcFilters[' + i + '].value=this.value;updateMDX()">'
                + '<button class="btn-icon btn-danger" onclick="removeDcFilter(' + i + ')">✕</button></div>';
        } else if (f.type === 'value') {
            const opSel = function(val, label) { return '<option value="' + val + '"' + (f.valueOperator === val ? ' selected' : '') + '>' + label + '</option>'; };
            html += '<div style="border:1px solid var(--border);border-radius:3px;padding:4px;margin-bottom:4px;">'
                + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;"><span style="font-size:11px;color:var(--accent);font-weight:600;">Value</span>'
                + '<button class="btn-icon btn-danger" onclick="removeDcFilter(' + i + ')">✕</button></div>'
                + '<div style="display:flex;gap:3px;margin-bottom:3px;">'
                + '<input type="text" placeholder="Cube" list="cubeList" value="' + escHtml(f.cube || '') + '" oninput="viewDims[' + di + '].dcFilters[' + i + '].cube=this.value;updateMDX()" style="flex:1;">'
                + '<input type="text" placeholder="Measure" value="' + escHtml(f.measure || '') + '" oninput="viewDims[' + di + '].dcFilters[' + i + '].measure=this.value;updateMDX()" style="flex:1;"></div>'
                + '<div style="display:flex;gap:3px;">'
                + '<select onchange="viewDims[' + di + '].dcFilters[' + i + '].valueOperator=this.value;updateMDX()" style="width:50px;">'
                + opSel('>','>') + opSel('<','<') + opSel('>=','>=') + opSel('<=','<=') + opSel('=','=') + opSel('<>','<>') + '</select>'
                + '<input type="text" placeholder="0" value="' + escHtml(f.threshold || '') + '" oninput="viewDims[' + di + '].dcFilters[' + i + '].threshold=this.value;updateMDX()" style="flex:1;">'
                + '</div></div>';
        }
    });
    container.innerHTML = html;
}

// ---- Inline Sort Type Toggle ----
function onDcSortTypeChange() {
    const type = document.getElementById('dcSortType').value;
    document.getElementById('dcSortValueFields').classList.toggle('hidden', type !== 'byvalue');
    document.getElementById('dcSortAttrField').classList.toggle('hidden', type !== 'byattribute');
    if (type === 'byattribute' && currentConfigDimIdx >= 0 && viewDims[currentConfigDimIdx].meta) {
        const sel = document.getElementById('dcSortAttr');
        sel.innerHTML = '<option value="">Select attribute...</option>' + viewDims[currentConfigDimIdx].meta.attributes.map(a => '<option value="' + escHtml(a.Name) + '">' + escHtml(a.Name) + '</option>').join('');
    }
    updateMDX();
}

// ---- Inline SubTopBottom Toggle ----
function onDcSubTopBottomChange() {
    const type = document.getElementById('dcSubTopBottomType').value;
    document.getElementById('dcSubTopBottomFields').classList.toggle('hidden', type === 'none');
    updateMDX();
}

// ============================================================
// MDX GENERATION
// ============================================================
function updateMDX() {
    if (mode === 'subset') {
        const dim = document.getElementById('sDimension').value;
        const hier = document.getElementById('sHierarchy').value;
        if (!dim || !hier) { document.getElementById('mdxPreview').textContent = '-- Select dimension and hierarchy'; return; }

        const struct = getRadio('sStruct');
        const headTailType = document.getElementById('sHeadTailType').value;
        const sortType = document.getElementById('sSortType').value;
        const sortDir = document.getElementById('sSortDir').value;
        const topBottomType = document.getElementById('sTopBottomType').value;
        const rangeEnabled = document.getElementById('sSubsetRange').checked;

        // Toggle subset range fields visibility
        document.getElementById('subsetRangeFields').classList.toggle('hidden', !rangeEnabled);

        const config = {
            dimension: dim,
            hierarchy: hier,
            baseSelection: getRadio('sBase'),
            levelIndex: parseInt(document.getElementById('sLevel').value) || 0,
            selectedMembers: subsetSelectedMembers,
            structureType: struct,
            structureElement: struct !== 'none' ? document.getElementById('sStructElement').value : '',
            filters: subsetFilters.filter(f =>
                (f.type === 'pattern' && f.pattern) ||
                (f.type === 'attribute' && f.attributeName && f.value) ||
                (f.type === 'value' && f.cube && f.threshold && f.tupleElements && f.tupleElements.some(te => te.dimension && te.element))
            ),
            sorting: {
                type: sortType,
                direction: sortDir,
                cube: document.getElementById('sSortCube').value,
                measure: document.getElementById('sSortMeasure').value,
                attributeName: document.getElementById('sSortAttr').value
            },
            headTail: { type: headTailType, count: parseInt(document.getElementById('sHeadTailCount').value) || 10 },
            topBottom: {
                type: topBottomType,
                count: parseInt(document.getElementById('sTopBottomCount').value) || 10,
                cube: document.getElementById('sTopBottomCube').value,
                measure: document.getElementById('sTopBottomMeasure').value
            },
            subsetRange: {
                enabled: rangeEnabled,
                start: parseInt(document.getElementById('sRangeStart').value) || 0,
                count: parseInt(document.getElementById('sRangeCount').value) || 10
            },
            setOperations: subsetSetOps.filter(op => (op.operandType === 'existing' && op.existingSubset) || (op.operandType === 'expression' && op.expression))
        };

        // Show/hide structure element picker
        document.getElementById('structElementWrap').classList.toggle('hidden', struct === 'none');

        vscode.postMessage({ command: 'generateMDX', mode: 'subset', config });
    } else {
        const cube = document.getElementById('vCube').value;
        if (!cube) { document.getElementById('mdxPreview').textContent = '-- Select a cube'; return; }

        // Save dim config if open
        saveDimConfig();

        const config = {
            cube,
            rows: viewDims.filter(d => d.axis === 'rows').map(buildAxisDimConfig),
            columns: viewDims.filter(d => d.axis === 'cols').map(buildAxisDimConfig),
            titles: viewDims.filter(d => d.axis === 'titles').map(d => ({
                dimension: d.dimension, hierarchy: d.hierarchy, selectedElement: d.selectedElement || ''
            })),
            suppressZeroesRows: document.getElementById('vSuppressRows').checked,
            suppressZeroesCols: document.getElementById('vSuppressCols').checked,
            calculatedMembers: viewCalcMembers.filter(cm => cm.name && cm.expression)
        };

        vscode.postMessage({ command: 'generateMDX', mode: 'view', config });
    }
}

function saveDimConfig() {
    if (currentConfigDimIdx < 0) return;
    const d = viewDims[currentConfigDimIdx];
    d.subsetType = document.getElementById('dcSubsetType').value;
    if (d.subsetType === 'existing') {
        d.existingSubset = document.getElementById('dcExistingSubset').value;
    } else if (d.subsetType === 'custom') {
        // Save inline sorting state
        d.dcSorting = {
            type: document.getElementById('dcSortType').value,
            direction: document.getElementById('dcSortDir').value,
            cube: document.getElementById('dcSortCube').value,
            measure: document.getElementById('dcSortMeasure').value,
            attributeName: document.getElementById('dcSortAttr').value
        };
        // Save inline topBottom state
        d.dcTopBottom = {
            type: document.getElementById('dcSubTopBottomType').value,
            count: parseInt(document.getElementById('dcSubTopBottomCount').value) || 10,
            cube: document.getElementById('dcSubTopBottomCube').value,
            measure: document.getElementById('dcSubTopBottomMeasure').value
        };
        // Save inline headTail state
        d.dcHeadTail = {
            type: document.getElementById('dcHeadTailType').value,
            count: parseInt(document.getElementById('dcHeadTailCount').value) || 10
        };
        // Build full SubsetConfig
        const validFilters = (d.dcFilters || []).filter(f =>
            (f.type === 'pattern' && f.pattern) ||
            (f.type === 'attribute' && f.attributeName && f.value) ||
            (f.type === 'value' && f.cube && f.threshold && f.tupleElements && f.tupleElements.some(te => te.dimension && te.element))
        );
        d.customConfig = {
            dimension: d.dimension,
            hierarchy: d.hierarchy,
            baseSelection: getRadio('dcBase'),
            levelIndex: parseInt(document.getElementById('dcLevel').value) || 0,
            structureType: getRadio('dcStruct'),
            structureElement: document.getElementById('dcStructElement').value,
            filters: validFilters,
            sorting: d.dcSorting,
            topBottom: d.dcTopBottom.type !== 'none' ? d.dcTopBottom : undefined,
            headTail: d.dcHeadTail.type !== 'none' ? d.dcHeadTail : undefined
        };
    } else if (d.subsetType === 'drilldown') {
        d.drilldownElement = document.getElementById('dcDrilldownElement').value;
    } else if (d.subsetType === 'members') {
        // selectedMembers already updated via checkbox toggles
    }
    if (d.axis === 'titles') {
        d.selectedElement = document.getElementById('dcElement').value;
    }
    // Save axis-level TopBottom (wrapper around the whole set)
    if (d.axis === 'cols' || d.axis === 'rows') {
        const tbType = document.getElementById('dcTopBottomType').value;
        d.topBottom = {
            type: tbType,
            count: parseInt(document.getElementById('dcTopBottomCount').value) || 10,
            cube: document.getElementById('vCube').value,
            measure: document.getElementById('dcTopBottomMeasure').value
        };
        document.getElementById('dcTopBottomMeasureWrap').classList.toggle('hidden', tbType === 'none');
    }
}

function buildAxisDimConfig(d) {
    return {
        dimension: d.dimension,
        hierarchy: d.hierarchy,
        subsetType: d.subsetType || 'all',
        existingSubset: d.existingSubset || '',
        customConfig: d.customConfig || null,
        drilldownElement: d.drilldownElement || '',
        selectedMembers: d.selectedMembers || [],
        topBottom: d.topBottom || { type: 'none', count: 10, cube: '', measure: '' },
        properties: d.properties || []
    };
}

// ---- Copy / Insert ----
function copyMDX() { vscode.postMessage({ command: 'copyMDX', mdx: currentMDX }); }
function insertMDX() { vscode.postMessage({ command: 'insertMDX', mdx: currentMDX, mode: mode }); }
function executeMDX() {
    const mdx = currentMDX;
    if (!mdx || mdx.startsWith('--')) return;
    document.getElementById('mdxResults').style.display = 'flex';
    document.getElementById('mdxResultList').innerHTML = '<div style="color:var(--desc);">Executing...</div>';
    document.getElementById('mdxResultCount').textContent = '';
    const dim = mode === 'subset' ? document.getElementById('sDimension').value : '';
    vscode.postMessage({ command: 'executeMDX', mdx: mdx, mode: mode, dimension: dim });
}

// ---- Hierarchy change in View Builder dim config ----
function onDcHierarchyChange() {
    if (currentConfigDimIdx < 0) return;
    const newHier = document.getElementById('dcHierarchy').value;
    const d = viewDims[currentConfigDimIdx];
    d.hierarchy = newHier;
    d.meta = null;
    d.allElements = [];
    d.selectedMembers = [];
    vscode.postMessage({ command: 'getHierarchyMeta', dimension: d.dimension, hierarchy: newHier });
    vscode.postMessage({ command: 'getElements', dimension: d.dimension, hierarchy: newHier });
    renderAxes();
    updateMDX();
}

// ---- Subset Builder: Pick Members ----
function onSubsetBaseChange() {
    const base = getRadio('sBase');
    document.getElementById('pickMembersWrap').classList.toggle('hidden', base !== 'members');
    if (base === 'members' && subsetElements.length === 0) {
        const dim = document.getElementById('sDimension').value;
        const hier = document.getElementById('sHierarchy').value;
        if (dim && hier) vscode.postMessage({ command: 'getElements', dimension: dim, hierarchy: hier });
    }
    if (base === 'members') renderPickMembers();
    updateMDX();
}

function renderPickMembers() {
    const container = document.getElementById('pickMembersList');
    const search = (document.getElementById('pickMembersSearch').value || '').toLowerCase();
    const filtered = search ? subsetElements.filter(e => e.toLowerCase().includes(search)) : subsetElements;
    if (filtered.length === 0) { container.innerHTML = '<div style="color:var(--desc);padding:4px;">No elements</div>'; return; }
    container.innerHTML = filtered.slice(0, 500).map(e => {
        const checked = subsetSelectedMembers.includes(e) ? ' checked' : '';
        return '<div class="checkbox-row" style="margin:0;"><input type="checkbox"' + checked + ' onchange="toggleSubsetMember(\\'' + escHtml(e).replace(/'/g, "\\\\'") + '\\',this.checked)"><label style="font-size:12px;">' + escHtml(e) + '</label></div>';
    }).join('');
    if (filtered.length > 500) container.innerHTML += '<div style="color:var(--desc);padding:4px;font-size:11px;">...and ' + (filtered.length - 500) + ' more (use search to filter)</div>';
}

function filterPickMembers() { renderPickMembers(); }

function toggleSubsetMember(name, checked) {
    if (checked) { if (!subsetSelectedMembers.includes(name)) subsetSelectedMembers.push(name); }
    else { subsetSelectedMembers = subsetSelectedMembers.filter(m => m !== name); }
    updateMDX();
}

// ---- View Builder: Pick Members for dim config ----
function renderDcMembers() {
    if (currentConfigDimIdx < 0) return;
    const d = viewDims[currentConfigDimIdx];
    const container = document.getElementById('dcMembersList');
    const search = (document.getElementById('dcMembersSearch').value || '').toLowerCase();
    const allEls = d.allElements || [];
    const filtered = search ? allEls.filter(e => e.toLowerCase().includes(search)) : allEls;
    if (filtered.length === 0) { container.innerHTML = '<div style="color:var(--desc);padding:4px;">' + (allEls.length === 0 ? 'Loading elements...' : 'No matches') + '</div>'; return; }
    const selected = d.selectedMembers || [];
    const di = currentConfigDimIdx;
    container.innerHTML = filtered.slice(0, 500).map(e => {
        const checked = selected.includes(e) ? ' checked' : '';
        return '<div class="checkbox-row" style="margin:0;"><input type="checkbox"' + checked + ' onchange="toggleDcMember(' + di + ',\\'' + escHtml(e).replace(/'/g, "\\\\'") + '\\',this.checked)"><label style="font-size:12px;">' + escHtml(e) + '</label></div>';
    }).join('');
    if (filtered.length > 500) container.innerHTML += '<div style="color:var(--desc);padding:4px;font-size:11px;">...and ' + (filtered.length - 500) + ' more</div>';
}

function filterDcMembers() { renderDcMembers(); }

function toggleDcMember(idx, name, checked) {
    if (!viewDims[idx].selectedMembers) viewDims[idx].selectedMembers = [];
    if (checked) { if (!viewDims[idx].selectedMembers.includes(name)) viewDims[idx].selectedMembers.push(name); }
    else { viewDims[idx].selectedMembers = viewDims[idx].selectedMembers.filter(m => m !== name); }
    renderAxes();
    updateMDX();
}

// ---- Title element picker ----
function populateTitleElements(idx) {
    const d = viewDims[idx];
    const sel = document.getElementById('dcElement');
    const allEls = d.allElements || [];
    const prev = d.selectedElement || '';
    sel.innerHTML = '<option value="">Select element...</option>' + allEls.map(e => '<option value="' + escHtml(e) + '"' + (e === prev ? ' selected' : '') + '>' + escHtml(e) + '</option>').join('');
}

function filterTitleElements() {
    if (currentConfigDimIdx < 0) return;
    const d = viewDims[currentConfigDimIdx];
    const search = (document.getElementById('dcElementSearch').value || '').toLowerCase();
    const sel = document.getElementById('dcElement');
    const allEls = d.allElements || [];
    const filtered = search ? allEls.filter(e => e.toLowerCase().includes(search)) : allEls;
    const prev = sel.value || d.selectedElement || '';
    sel.innerHTML = '<option value="">Select element...</option>' + filtered.map(e => '<option value="' + escHtml(e) + '"' + (e === prev ? ' selected' : '') + '>' + escHtml(e) + '</option>').join('');
}
`;
}

import * as vscode from 'vscode';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

type CompletionType = 'cube' | 'dimension' | 'element' | 'subset' | 'attribute';

// Map: UPPERCASE_FUNCTION_NAME -> [argIndex, completionType][]
// argIndex is 0-based. For 'element' and 'subset', the provider will automatically
// look up the 'dimension' entry in the same mapping to know which arg contains the dim name.
const FUNCTION_COMPLETION_MAP: Record<string, Array<[number, CompletionType]>> = {

    // ── Cell read (arg 0 = cube) ─────────────────────────────────────────
    'CELLGETN':                     [[0, 'cube']],
    'CELLGETS':                     [[0, 'cube']],
    'CELLISUPDATEABLE':             [[0, 'cube']],
    'CELLISUPDATEABLEEX':           [[0, 'cube']],
    'CELLSECURITYGET':              [[0, 'cube']],

    // ── Cell write (arg 1 = cube) ────────────────────────────────────────
    'CELLPUTN':                     [[1, 'cube']],
    'CELLPUTS':                     [[1, 'cube']],
    'CELLINCREMENTN':               [[1, 'cube']],
    'CELLPUTPROPORTIONALSPREAD':    [[1, 'cube']],

    // ── Cube functions ───────────────────────────────────────────────────
    'CUBECLEARDATA':                [[0, 'cube']],
    'CUBECREATE':                   [[0, 'cube']],
    'CUBEDESTROY':                  [[0, 'cube']],
    'CUBEEXISTS':                   [[0, 'cube']],
    'CUBEGETLOGCHANGES':            [[0, 'cube']],
    'CUBESETLOGCHANGES':            [[0, 'cube']],
    'CUBEPROCESSFEEDERS':           [[0, 'cube']],
    'CUBESAVEDATA':                 [[0, 'cube']],

    // ── Hierarchy functions ──────────────────────────────────────────────
    'HIERARCHYCOUNT':               [[0, 'cube']],
    'HIERARCHYCREATE':              [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYDESTROY':             [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYEXISTS':              [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYELEMENTINSERT':       [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYELEMENTDELETE':       [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYELEMENTCOMPONENTADD': [[0, 'cube'], [1, 'dimension']],
    'HIERARCHYELEMENTCOMPONENTDELETE': [[0, 'cube'], [1, 'dimension']],

    // ── Subset functions — (DimName, SubName, ...) ───────────────────────
    'SUBSETALIASTSET':              [[0, 'dimension'], [1, 'subset']],
    'SUBSETALIASSET':               [[0, 'dimension'], [1, 'subset']],
    'SUBSETCREATE':                 [[0, 'dimension']],
    'SUBSETCREATEBYMDX':            [[0, 'dimension']],
    'SUBSETDELETEALLEMENTS':        [[0, 'dimension'], [1, 'subset']],
    'SUBSETDELETALLELEMENTS':       [[0, 'dimension'], [1, 'subset']],
    'SUBSETDESTROY':                [[0, 'dimension'], [1, 'subset']],
    // SubsetElementDelete(DimName, SubName, Index) — Index is a number, no element completion
    'SUBSETELEMENTDELETE':          [[0, 'dimension'], [1, 'subset']],
    // SubsetElementInsert(DimName, SubName, ElName, Index)
    'SUBSETELEMENTINSERT':          [[0, 'dimension'], [1, 'subset'], [2, 'element']],
    'SUBSETELEMINSERT':             [[0, 'dimension'], [1, 'subset'], [2, 'element']],
    'SUBSETEXISTS':                 [[0, 'dimension'], [1, 'subset']],
    'SUBSETGETELEMENTNAME':         [[0, 'dimension'], [1, 'subset']],
    'SUBSETGETSIZE':                [[0, 'dimension'], [1, 'subset']],
    'SUBSETMDXGET':                 [[0, 'dimension'], [1, 'subset']],
    'SUBSETMDXSET':                 [[0, 'dimension'], [1, 'subset']],
    'SUBSETTOSET':                  [[0, 'dimension'], [1, 'subset']],
    'CREATESUBSET':                 [[0, 'dimension']],

    // ── View functions ───────────────────────────────────────────────────
    'VIEWCOLUMNDIMENSIONSET':       [[0, 'cube'], [2, 'dimension']],
    'VIEWCREATE':                   [[0, 'cube']],
    'VIEWDESTROY':                  [[0, 'cube']],
    'VIEWEXISTS':                   [[0, 'cube']],
    'VIEWEXTRACTSKIPCALCSSET':      [[0, 'cube']],
    'VIEWEXTRACTSKIPCONSOLIDATEDSTRINGSSET': [[0, 'cube']],
    'VIEWEXTRACTSKIPRULEVALUESSET': [[0, 'cube']],
    'VIEWEXTRACTSKIPZEROESSET':     [[0, 'cube']],
    'VIEWEXTRACTSKIPCONSOLIDATEDVALUESSET': [[0, 'cube']],
    'VIEWROWDIMENSIONSET':          [[0, 'cube'], [2, 'dimension']],
    // ViewSubsetAssign(Cube, View, Dim, SubsetName)
    'VIEWSUBSETASSIGN':             [[0, 'cube'], [2, 'dimension'], [3, 'subset']],
    'VIEWTITLEDIMENSIONSET':        [[0, 'cube'], [2, 'dimension']],
    'VIEWTITLEELEMENTSET':          [[0, 'cube']],
    'VIEWZEROOUT':                  [[0, 'cube']],
    'PUBLISHVIEW':                  [[0, 'cube']],
    'NATIVEVIEWTOMDX':              [[0, 'cube']],

    // ── Dimension-level functions ─────────────────────────────────────────
    'DIMENSIONCREATE':              [[0, 'dimension']],
    'DIMENSIONDESTROY':             [[0, 'dimension']],
    'DIMENSIONDELETEALLELEMENTS':   [[0, 'dimension']],
    // DimensionElementComponentAdd(DimName, ConsolName, ElName, Weight)
    'DIMENSIONELEMENTCOMPONENTADD': [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'DIMENSIONELEMENTCOMPONENTDELETE': [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'DIMENSIONELEMENTDELETE':       [[0, 'dimension'], [1, 'element']],
    'DIMENSIONELEMENTINSERT':       [[0, 'dimension']],
    'DIMENSIONELEMENTINSERTDIRECT': [[0, 'dimension']],
    'DIMENSIONELEMENTPRINCIPALNAME':[[0, 'dimension']],
    'DIMENSIONEXISTS':              [[0, 'dimension']],
    'DIMENSIONSORTORDER':           [[0, 'dimension']],
    'DIMENSIONTOPELEMENT':          [[0, 'dimension']],
    'DIMENSIONTOPELEMENTCOUNT':     [[0, 'dimension']],

    // ── Short-form dimension/element helpers ──────────────────────────────
    'DIMIX':                        [[0, 'dimension'], [1, 'element']],
    'DIMNM':                        [[0, 'dimension']],
    'DIMSIZ':                       [[0, 'dimension']],
    // Elcomp(DimName, ConsolName, Index) — ConsolName is an element
    'ELCOMP':                       [[0, 'dimension'], [1, 'element']],
    'ELCOMPN':                      [[0, 'dimension'], [1, 'element']],
    'ELISLEAV':                     [[0, 'dimension'], [1, 'element']],
    'ELPAR':                        [[0, 'dimension'], [1, 'element']],
    'ELPARN':                       [[0, 'dimension'], [1, 'element']],
    'ELLEV':                        [[0, 'dimension'], [1, 'element']],
    'ELWEIGHT':                     [[0, 'dimension'], [1, 'element']],

    // ── Element* functions ────────────────────────────────────────────────
    'ELEMENTCOUNT':                 [[0, 'dimension']],
    'ELEMENTINDEX':                 [[0, 'dimension'], [1, 'element']],
    'ELEMENTNAME':                  [[0, 'dimension']],
    'ELEMENTTYPE':                  [[0, 'dimension'], [1, 'element']],
    'ELEMENTLEVEL':                 [[0, 'dimension'], [1, 'element']],
    'ELEMENTASCEND':                [[0, 'dimension'], [1, 'element']],
    'ELEMENTDESCEND':               [[0, 'dimension'], [1, 'element']],
    'ELEMENTCOMPONENTCOUNT':        [[0, 'dimension'], [1, 'element']],
    'ELEMENTCOMPONENT':             [[0, 'dimension'], [1, 'element']],
    'ELEMENTCOMPONENTWEIGHT':       [[0, 'dimension'], [1, 'element']],
    'ELEMENTPARENTCOUNT':           [[0, 'dimension'], [1, 'element']],
    'ELEMENTPARENT':                [[0, 'dimension'], [1, 'element']],
    'ELEMENTWEIGHT':                [[0, 'dimension'], [1, 'element']],
    'ELEMENTISANCESTOR':            [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'ELEMENTISPARENT':              [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'ELEMENTISCHILD':               [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'ELEMENTISSIBLING':             [[0, 'dimension'], [1, 'element'], [2, 'element']],
    'ELEMENTSECURITYGET':           [[0, 'dimension'], [1, 'element']],

    // ── Attribute functions ───────────────────────────────────────────────
    // AttrGetN/S(DimName, ElName, AttrName)
    'ATTRGETN':                     [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    'ATTRGETS':                     [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    'ELEMENTATTRN':                 [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    'ELEMENTATTRS':                 [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    // AttrPutN/S(Value, DimName, ElName, AttrName) — value is arg 0
    'ATTRPUTN':                     [[1, 'dimension'], [2, 'element'], [3, 'attribute']],
    'ATTRPUTS':                     [[1, 'dimension'], [2, 'element'], [3, 'attribute']],
    'ELEMENTATTRPUTN':              [[1, 'dimension'], [2, 'element'], [3, 'attribute']],
    'ELEMENTATTRPUTS':              [[1, 'dimension'], [2, 'element'], [3, 'attribute']],
    'ATTRDELETE':                   [[0, 'dimension'], [1, 'attribute']],
    'ATTRINSERT':                   [[0, 'dimension']],
    'ELEMENTATTRDELETE':            [[0, 'dimension']],
    'ELEMENTATTRINSERT':            [[0, 'dimension']],
    // ATTRNL/ATTRSL(DimName, ElName, AttrName, [Lang])
    'ATTRNL':                       [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    'ATTRSL':                       [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    // ATTRS / ATTRN shorthand (same as AttrGetS/N)
    'ATTRS':                        [[0, 'dimension'], [1, 'element'], [2, 'attribute']],
    'ATTRN':                        [[0, 'dimension'], [1, 'element'], [2, 'attribute']],

    // ── Security functions ────────────────────────────────────────────────
    'CUBESECURITYPUT':              [[1, 'cube']],
    'DIMENSIONSECURITYPUT':         [[1, 'dimension']],
    'ELEMENTSECURITYPUT':           [[1, 'dimension'], [2, 'element']],
};

// Rules cross-cube reference functions: arg 0 = cube, then one element per cube
// dimension in order. Handled positionally (the static map can't express this).
const DB_FAMILY = new Set(['DB', 'CELLVALUEN', 'CELLVALUES']);

export class TM1CompletionProvider implements vscode.CompletionItemProvider {

    async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.CompletionItem[] | undefined> {

        if (!document.fileName.endsWith('.ti') && !document.fileName.endsWith('.rux')) return;

        const lineText = document.lineAt(position).text;
        const textBefore = lineText.substring(0, position.character);

        // Must be inside a single-quoted string
        const { inString, partial } = this.analyzeStringContext(textBefore);
        if (!inString) return;

        // Resolve which TM1 instance this file belongs to
        const instanceId = this.resolveInstance(document.fileName);
        if (!instanceId || !TM1Service.getInstance().isConnected(instanceId)) return;

        // Determine completion type from function context
        const { fnName, argIndex } = this.parseFunctionContext(textBefore);

        const isRule = document.fileName.toLowerCase().endsWith('.rux');

        try {
            // Rules: inside a left-side [ ... ] area (or feeder target), offer element
            // names drawn from the rule's own cube (the <Cube>.rux file name).
            if (isRule && this.isInsideArea(textBefore)) {
                const ruleCube = path.basename(document.fileName, path.extname(document.fileName));
                return await this.buildAreaElements(instanceId, ruleCube, partial);
            }

            if (!fnName) return;

            // DB / CellValue: cross-cube reference. Arg 0 is the cube; each following
            // arg is an element of that cube's dimensions, in order.
            if (DB_FAMILY.has(fnName.toUpperCase())) {
                if (argIndex === 0) {
                    const names = await TM1Service.getInstance().getCubeNames(instanceId);
                    return this.buildItems(names, partial, 'TM1 Cube', vscode.CompletionItemKind.Module);
                }
                const cubeName = this.extractArgValue(textBefore, 0);
                if (!cubeName) return;
                const dims = await TM1Service.getInstance().getCubeDimensions(instanceId, cubeName);
                const dim = dims[argIndex - 1];
                if (!dim) return;
                const names = await TM1Service.getInstance().getElementNames(instanceId, dim.Name);
                return this.buildItems(names, partial, `TM1 Element (${dim.Name})`, vscode.CompletionItemKind.Value, 200);
            }

            const mappings = FUNCTION_COMPLETION_MAP[fnName.toUpperCase()];
            if (!mappings) return;

            const matchEntry = mappings.find(([idx]) => idx === argIndex);
            if (!matchEntry) return;
            const completionType = matchEntry[1];

            // For 'element' and 'subset', find the dimension arg index in the same mapping
            // so we know where to look for the dimension name regardless of arg position
            const dimArgIndex = mappings.find(([, t]) => t === 'dimension')?.[0] ?? -1;

            if (completionType === 'cube') {
                const names = await TM1Service.getInstance().getCubeNames(instanceId);
                return this.buildItems(names, partial, 'TM1 Cube', vscode.CompletionItemKind.Module);

            } else if (completionType === 'dimension') {
                const names = await TM1Service.getInstance().getDimensionNames(instanceId);
                return this.buildItems(names, partial, 'TM1 Dimension', vscode.CompletionItemKind.Class);

            } else if (completionType === 'subset') {
                if (dimArgIndex < 0) return;
                const dimName = this.extractArgValue(textBefore, dimArgIndex);
                if (!dimName) return;
                const names = await TM1Service.getInstance().getSubsetNames(instanceId, dimName);
                return this.buildItems(names, partial, `TM1 Subset (${dimName})`, vscode.CompletionItemKind.Enum);

            } else if (completionType === 'attribute') {
                if (dimArgIndex < 0) return;
                const dimName = this.extractArgValue(textBefore, dimArgIndex);
                if (!dimName) return;
                const names = await TM1Service.getInstance().getAttributeNames(instanceId, dimName);
                return this.buildItems(names, partial, `TM1 Attribute (${dimName})`, vscode.CompletionItemKind.Property);

            } else if (completionType === 'element') {
                const cfg = ConfigManager.getConfig();
                // Rules always offer element completion; TI respects the opt-in setting.
                if (!isRule && !cfg.featureSettings?.enableElementCompletion) return;
                // No partial.length check — show up to 50 elements immediately when entering
                // the arg, consistent with how dimension and subset completions behave.
                // Results are filtered by whatever the user has typed so far.
                if (dimArgIndex < 0) return;
                const dimName = this.extractArgValue(textBefore, dimArgIndex);
                if (!dimName) return;
                const names = await TM1Service.getInstance().getElementNames(instanceId, dimName);
                return this.buildItems(names, partial, `TM1 Element (${dimName})`, vscode.CompletionItemKind.Value, 50);
            }
        } catch {
            // Silently ignore — server may be temporarily unreachable
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    // True when the cursor sits inside an unclosed [ ... ] area (left-side rule
    // restriction or feeder target). Brackets inside strings are ignored.
    private isInsideArea(textBefore: string): boolean {
        let inStr = false, open = 0;
        for (const ch of textBefore) {
            if (ch === "'") { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '[') open++;
            else if (ch === ']') open = Math.max(0, open - 1);
        }
        return open > 0;
    }

    // Element names for a rule area: the union of the rule cube's dimension
    // elements (deduplicated, filtered by what's typed, capped for responsiveness).
    private async buildAreaElements(
        instanceId: string, cubeName: string, partial: string
    ): Promise<vscode.CompletionItem[] | undefined> {
        let dims: { Name: string }[];
        try { dims = await TM1Service.getInstance().getCubeDimensions(instanceId, cubeName); }
        catch { return; }
        if (!dims || !dims.length) return;
        const lower = partial.toLowerCase();
        const seen = new Set<string>();
        const items: vscode.CompletionItem[] = [];
        for (const d of dims) {
            let names: string[];
            try { names = await TM1Service.getInstance().getElementNames(instanceId, d.Name); }
            catch { continue; }
            for (const n of names) {
                if (lower && !n.toLowerCase().includes(lower)) continue;
                const key = n.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                const item = new vscode.CompletionItem(n, vscode.CompletionItemKind.Value);
                item.detail = `TM1 Element (${d.Name})`;
                item.insertText = n;
                items.push(item);
                if (items.length >= 200) return items;
            }
        }
        return items;
    }

    private analyzeStringContext(textBefore: string): { inString: boolean; partial: string } {
        let inString = false;
        let partial = '';
        for (let i = 0; i < textBefore.length; i++) {
            if (textBefore[i] === "'") {
                inString = !inString;
                if (inString) partial = '';
            } else if (inString) {
                partial += textBefore[i];
            }
        }
        return { inString, partial };
    }

    private parseFunctionContext(textBefore: string): { fnName: string | null; argIndex: number } {
        // Find start of current string literal (the last unmatched opening quote)
        let quoteCount = 0;
        for (const ch of textBefore) if (ch === "'") quoteCount++;
        let scanEnd = textBefore.length - 1;
        if (quoteCount % 2 !== 0) {
            scanEnd = textBefore.lastIndexOf("'") - 1;
        }

        let depth = 0;
        let inStr = false;
        let argIndex = 0;

        for (let i = scanEnd; i >= 0; i--) {
            const ch = textBefore[i];
            if (ch === "'") { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === ')') { depth++; continue; }
            if (ch === '(') {
                if (depth === 0) {
                    const before = textBefore.substring(0, i).trimEnd();
                    const fnMatch = before.match(/([A-Za-z_]\w*)$/);
                    return { fnName: fnMatch ? fnMatch[1] : null, argIndex };
                }
                depth--;
                continue;
            }
            if (ch === ',' && depth === 0) argIndex++;
        }
        return { fnName: null, argIndex: 0 };
    }

    private extractArgValue(textBefore: string, targetArgIndex: number): string | null {
        const { fnName } = this.parseFunctionContext(textBefore);
        if (!fnName || targetArgIndex < 0) return null;

        const upper = textBefore.toUpperCase();
        const fnUpper = fnName.toUpperCase();
        const fnIdx = upper.lastIndexOf(fnUpper);
        if (fnIdx < 0) return null;
        const parenIdx = textBefore.indexOf('(', fnIdx);
        if (parenIdx < 0) return null;

        const argsText = textBefore.substring(parenIdx + 1);
        const args: string[] = [];
        let cur = '';
        let depth = 0;
        let inStr = false;

        for (const ch of argsText) {
            if (ch === "'") { inStr = !inStr; cur += ch; continue; }
            if (inStr) { cur += ch; continue; }
            if (ch === '(') { depth++; cur += ch; continue; }
            if (ch === ')') { if (depth > 0) { depth--; cur += ch; } continue; }
            if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
            cur += ch;
        }
        if (cur.trim()) args.push(cur.trim());

        const val = args[targetArgIndex];
        if (!val) return null;
        const m = val.match(/^'([^']*)'$/);
        return m ? m[1] : null;
    }

    private buildItems(
        names: string[], partial: string, detail: string,
        kind: vscode.CompletionItemKind, maxResults = 500
    ): vscode.CompletionItem[] {
        const lower = partial.toLowerCase();
        return names
            .filter(n => n.toLowerCase().includes(lower))
            .slice(0, maxResults)
            .map(n => {
                const item = new vscode.CompletionItem(n, kind);
                item.detail = detail;
                item.insertText = n;
                return item;
            });
    }

    private resolveInstance(filePath: string): string | null {
        if (!vscode.workspace.workspaceFolders) return null;
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const config = ConfigManager.getConfig();

        // File structure: <root>/<envFolder>/<serverName>/Processes/<file>.ti
        const relative = path.relative(rootPath, filePath).replace(/\\/g, '/');
        const parts = relative.split('/');
        if (parts.length < 3) return null;

        const envFolder = parts[0];
        const serverName = parts[1];

        const env = config.environments.find(e => e.folder === envFolder);
        if (!env) return null;

        const instanceId = `${env.name}_${serverName}`;
        if (TM1Service.getInstance().isConnected(instanceId)) return instanceId;
        return null;
    }
}

import { TM1Service, TM1ProcessContent } from './TM1Service';

/**
 * Shared read-only "model context" API over the connected TM1 instances.
 *
 * This is the single source of truth for the MCP server (mcp/Tm1McpServer):
 * tools, resources and prompts all delegate here. Every function delegates to
 * the existing TM1Service singleton and its live, authenticated connection
 * (Basic / CAM / OAuth). No REST is re-implemented and no credentials are
 * duplicated. Everything here is strictly read-only.
 */

function tm1(): TM1Service { return TM1Service.getInstance(); }

/** Names of all currently connected instances. */
export function connectedInstances(): string[] {
    return tm1().getConnectedInstanceNames();
}

/**
 * Resolves the target instance name. If a hint is given it is matched exactly,
 * or by environment/server suffix / substring. If omitted and exactly one
 * instance is connected, that one is used. Otherwise an explanatory error is
 * returned so the caller can surface it.
 */
export function resolveInstance(hint?: string): { name?: string; error?: string } {
    const connected = connectedInstances();
    if (connected.length === 0) {
        return { error: 'No TM1 instance is currently connected. Connect to an environment in the pa-code extension first, then retry.' };
    }
    if (hint && hint.trim()) {
        const h = hint.trim();
        const exact = connected.find(n => n === h);
        if (exact) return { name: exact };
        const match = connected.find(n => n.endsWith('_' + h) || n.startsWith(h + '_') || n.toLowerCase().includes(h.toLowerCase()));
        if (match) return { name: match };
        return { error: `Instance '${h}' is not connected. Connected instances: ${connected.join(', ')}.` };
    }
    if (connected.length === 1) return { name: connected[0] };
    return { error: `Multiple TM1 instances are connected — specify the 'instance' argument. Connected instances: ${connected.join(', ')}.` };
}

function isControl(name: string): boolean { return name.startsWith('}'); }

/** Escapes a string for safe use as a literal inside a RegExp. */
export function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Formats one TI process' four tabs plus properties as readable text. */
function formatProcess(name: string, c: TM1ProcessContent): string {
    const tab = (label: string, code: string) =>
        `### ${label}\n${code && code.trim() ? '```\n' + code + '\n```' : '(empty)'}`;
    return [
        `# TI Process: ${name}`,
        tab('Prolog', c.Prolog),
        tab('Metadata', c.Metadata),
        tab('Data', c.Data),
        tab('Epilog', c.Epilog),
        `### Properties (parameters / datasource / variables)\n\`\`\`json\n${c.PropertiesJSON}\n\`\`\``
    ].join('\n\n');
}

/**
 * Flattens an ExecuteMDX cellset into `member1 | member2 | ... = value` lines,
 * capped at maxCells. Cell ordinals map to axis tuples with axis 0 varying
 * fastest (standard OData/TM1 cellset ordering).
 */
function formatCellset(data: any, maxCells: number): string {
    const axes = data?.Axes || [];
    const cells = data?.Cells || [];
    if (!Array.isArray(cells) || cells.length === 0) return 'Query returned no cells.';
    const sizes: number[] = axes.map((a: any) => (a?.Tuples?.length || 0));
    const lines: string[] = [];
    let shown = 0;
    for (let o = 0; o < cells.length && shown < maxCells; o++) {
        const cell = cells[o];
        const v = cell?.FormattedValue ?? cell?.Value;
        if (v === undefined || v === null || v === '') continue; // skip empty cells
        let rem = o;
        const coords: string[] = [];
        for (let ai = 0; ai < axes.length; ai++) {
            const size = sizes[ai] || 1;
            const idx = rem % size;
            rem = Math.floor(rem / size);
            const members = axes[ai]?.Tuples?.[idx]?.Members || [];
            coords.push(members.map((m: any) => m.Name).join('/'));
        }
        lines.push(`${coords.join(' | ')} = ${v}`);
        shown++;
    }
    const header = `Cellset: ${cells.length} cells total, showing ${lines.length} non-empty${cells.length > maxCells ? ` (capped at ${maxCells})` : ''}.`;
    return `${header}\n\n${lines.join('\n') || '(all returned cells were empty)'}`;
}

interface CodeHit { object: string; tab: string; line: number; text: string; }

/** Scans TI code (optionally including control objects) for a regex. */
async function searchProcessCode(instanceName: string, pattern: string, includeControl: boolean, maxHits: number): Promise<CodeHit[]> {
    const details = await tm1().getAllProcessesDetails(instanceName, includeControl ? 'all' : 'normal');
    let re: RegExp;
    try { re = new RegExp(pattern, 'i'); } catch { throw new Error(`Invalid regular expression: ${pattern}`); }
    const hits: CodeHit[] = [];
    const tabs: (keyof TM1ProcessContent)[] = ['Prolog', 'Metadata', 'Data', 'Epilog'];
    for (const proc of details) {
        for (const tabName of tabs) {
            const code = String(proc.Content[tabName] || '');
            if (!code) continue;
            const lines = code.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                if (re.test(lines[i])) {
                    hits.push({ object: proc.Name, tab: tabName, line: i + 1, text: lines[i].trim() });
                    if (hits.length >= maxHits) return hits;
                }
            }
        }
    }
    return hits;
}

// --- Raw name lists (used for MCP completion) -------------------------------

export async function listCubeNames(instanceName: string): Promise<string[]> {
    return tm1().getCubeNames(instanceName);
}
export async function listProcessNames(instanceName: string, includeControl = false): Promise<string[]> {
    const procs = await tm1().getProcesses(instanceName, includeControl ? 'all' : 'normal');
    return procs.map(p => p.Name);
}
export async function listDimensionNames(instanceName: string): Promise<string[]> {
    return tm1().getDimensionNames(instanceName);
}

// --- Formatted read API (used by tools and MCP resources) -------------------

export function apiListInstances(): string {
    const names = connectedInstances();
    if (names.length === 0) return 'No TM1 instance is currently connected.';
    const lines = names.map(n => `- ${n}${tm1().getAdminStatus(n) ? ' (admin)' : ''}`);
    return `Connected TM1 instances:\n${lines.join('\n')}`;
}

export async function apiListCubes(inst: string, includeControl: boolean): Promise<string> {
    const cubes = await tm1().getCubes(inst, includeControl ? 'all' : 'normal');
    if (cubes.length === 0) return `No cubes found on ${inst}.`;
    return `${cubes.length} cubes on ${inst}:\n${cubes.map(c => `- ${c.Name}`).join('\n')}`;
}

export async function apiListDimensions(inst: string, includeControl: boolean): Promise<string> {
    let dims = await tm1().getDimensions(inst);
    if (!includeControl) dims = dims.filter(d => !isControl(d.Name));
    if (dims.length === 0) return `No dimensions found on ${inst}.`;
    return `${dims.length} dimensions on ${inst}:\n${dims.map(d => `- ${d.Name}`).join('\n')}`;
}

export async function apiListProcesses(inst: string, includeControl: boolean): Promise<string> {
    const procs = await tm1().getProcesses(inst, includeControl ? 'all' : 'normal');
    if (procs.length === 0) return `No TI processes found on ${inst}.`;
    return `${procs.length} TI processes on ${inst}:\n${procs.map(p => `- ${p.Name}`).join('\n')}`;
}

export async function apiGetProcessCode(inst: string, processName: string): Promise<string> {
    const content = await tm1().getProcessCode(inst, processName);
    return formatProcess(processName, content);
}

export async function apiGetProcessParameters(inst: string, processName: string): Promise<string> {
    const params = await tm1().getProcessParameters(inst, processName);
    if (!params || params.length === 0) return `Process ${processName} has no parameters.`;
    return `Parameters of ${processName}:\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
}

export async function apiGetCubeRules(inst: string, cubeName: string): Promise<string> {
    const rules = await tm1().getRuleContent(inst, cubeName);
    if (!rules || !rules.trim()) return `Cube ${cubeName} has no rules.`;
    return `# Rules for cube ${cubeName}\n\`\`\`\n${rules}\n\`\`\``;
}

export async function apiGetCubeDimensions(inst: string, cubeName: string): Promise<string> {
    const dims = await tm1().getCubeDimensions(inst, cubeName);
    if (dims.length === 0) return `Cube ${cubeName} not found or has no dimensions.`;
    const lines = dims.map((d, i) => {
        const hiers = (d.Hierarchies || []).map(h => h.Name).join(', ');
        return `${i + 1}. ${d.Name}${hiers && hiers !== d.Name ? ` [hierarchies: ${hiers}]` : ''}`;
    });
    return `Cube ${cubeName} has ${dims.length} dimensions (in order):\n${lines.join('\n')}`;
}

export async function apiListDimensionElements(inst: string, dimensionName: string, hierarchyName: string | undefined, limit: number): Promise<string> {
    const hier = (hierarchyName || dimensionName).trim();
    const cap = Math.min(Math.max(limit || 500, 1), 5000);
    const elements = await tm1().getHierarchyElements(inst, dimensionName, hier, cap);
    if (elements.length === 0) return `No elements found in ${dimensionName} / ${hier}.`;
    const capped = elements.length >= cap ? ` (capped at ${cap})` : '';
    return `${elements.length} elements in ${dimensionName} / ${hier}${capped}:\n${elements.map(e => `- ${e}`).join('\n')}`;
}

export async function apiListHierarchies(inst: string, dimensionName: string): Promise<string> {
    const hiers = await tm1().getHierarchies(inst, dimensionName);
    if (hiers.length === 0) return `Dimension ${dimensionName} not found or has no hierarchies.`;
    return `Dimension ${dimensionName} has ${hiers.length} hierarchies:\n${hiers.map(h => `- ${h.Name}`).join('\n')}`;
}

export async function apiListViews(inst: string, cubeName: string): Promise<string> {
    const views = await tm1().getViews(inst, cubeName);
    if (views.length === 0) return `Cube ${cubeName} has no views.`;
    return `Views on ${cubeName}:\n${views.map(v => `- ${v.Name} (${v.type})`).join('\n')}`;
}

export async function apiListSubsets(inst: string, dimensionName: string): Promise<string> {
    const subsets = await tm1().getSubsets(inst, dimensionName);
    if (subsets.length === 0) return `Dimension ${dimensionName} has no public subsets.`;
    return `Public subsets of ${dimensionName}:\n${subsets.map(s => `- ${s.Name}`).join('\n')}`;
}

export async function apiSearchCode(inst: string, pattern: string, includeControl: boolean, maxHits: number): Promise<string> {
    const cap = Math.min(Math.max(maxHits || 200, 1), 1000);
    const hits = await searchProcessCode(inst, pattern, includeControl, cap);
    if (hits.length === 0) return `No matches for /${pattern}/i across TI code on ${inst}.`;
    const lines = hits.map(h => `- ${h.object} [${h.tab}:${h.line}] ${h.text}`);
    return `${hits.length} matches for /${pattern}/i:\n${lines.join('\n')}`;
}

export async function apiAnalyzeObjectUsage(inst: string, objectName: string): Promise<string> {
    const re = new RegExp(escapeRegex(objectName), 'i');

    const procDetails = await tm1().getAllProcessesDetails(inst, 'all');
    const procHits: string[] = [];
    const tabs: (keyof TM1ProcessContent)[] = ['Prolog', 'Metadata', 'Data', 'Epilog'];
    for (const proc of procDetails) {
        const matchedTabs = tabs.filter(t => re.test(String(proc.Content[t] || '')));
        if (matchedTabs.length > 0) procHits.push(`- ${proc.Name} (${matchedTabs.join(', ')})`);
    }

    const ruleDetails = await tm1().getAllRulesDetails(inst, 'all');
    const ruleHits: string[] = [];
    for (const r of ruleDetails) {
        if (re.test(String(r.Content || ''))) ruleHits.push(`- ${r.CubeName}`);
    }

    if (procHits.length === 0 && ruleHits.length === 0) {
        return `No references to '${objectName}' found in TI processes or cube rules on ${inst}.`;
    }
    return [
        `References to '${objectName}' on ${inst}:`,
        `\n## TI processes (${procHits.length})`,
        procHits.join('\n') || '(none)',
        `\n## Cube rules (${ruleHits.length})`,
        ruleHits.join('\n') || '(none)'
    ].join('\n');
}

export async function apiExecuteMdx(inst: string, mdx: string, maxCells: number): Promise<string> {
    const cap = Math.min(Math.max(maxCells || 100, 1), 500);
    const data = await tm1().executeMDXCube(inst, mdx);
    return formatCellset(data, cap);
}

export async function apiGetServerInfo(inst: string): Promise<string> {
    const cfg = await tm1().getStaticConfiguration(inst);
    const json = JSON.stringify(cfg, null, 2);
    const capped = json.length > 6000 ? json.substring(0, 6000) + '\n… (truncated)' : json;
    return `Server configuration for ${inst}:\n\`\`\`json\n${capped}\n\`\`\``;
}

// --- Additional read API (IBM MCP-inspired) ---------------------------------

export async function apiGetProcessErrorLog(inst: string, processName: string): Promise<string> {
    const log = await tm1().getLatestErrorLog(inst, processName);
    if (!log) return `No error log found for process ${processName} on ${inst}.`;
    return `# Error log ${log.filename}\n\`\`\`\n${log.content}\n\`\`\``;
}

export async function apiGetCubeSampleMembers(inst: string, cubeName: string, perDimension: number): Promise<string> {
    const dims = await tm1().getCubeDimensions(inst, cubeName);
    if (dims.length === 0) return `Cube ${cubeName} not found or has no dimensions.`;
    const per = Math.min(Math.max(perDimension || 5, 1), 50);
    const lines: string[] = [];
    for (const d of dims) {
        const hier = (d.Hierarchies && d.Hierarchies[0] && d.Hierarchies[0].Name) || d.Name;
        let els: string[] = [];
        try { els = await tm1().getHierarchyElements(inst, d.Name, hier, per); } catch { els = []; }
        lines.push(`- ${d.Name}: ${els.slice(0, per).join(', ') || '(none)'}`);
    }
    return `Sample members per dimension of cube ${cubeName} (up to ${per} each):\n${lines.join('\n')}`;
}

export async function apiSearchDimensionElements(inst: string, dimensionName: string, searchTerm: string, hierarchyName: string | undefined, limit: number): Promise<string> {
    const hier = (hierarchyName || dimensionName).trim();
    const pool = await tm1().getHierarchyElements(inst, dimensionName, hier, 50000);
    const term = searchTerm.toLowerCase();
    const matches = pool.filter(e => e.toLowerCase().includes(term));
    const cap = Math.min(Math.max(limit || 50, 1), 500);
    const limited = matches.slice(0, cap);
    if (limited.length === 0) return `No elements in ${dimensionName} / ${hier} match '${searchTerm}'.`;
    const more = matches.length > cap ? ` (showing ${cap})` : '';
    return `${matches.length} elements in ${dimensionName} / ${hier} match '${searchTerm}'${more}:\n${limited.map(e => `- ${e}`).join('\n')}`;
}

export async function apiGetViewData(inst: string, cubeName: string, viewName: string, top: number): Promise<string> {
    const cap = Math.min(Math.max(top || 25, 1), 200);
    const { headers, rows } = await tm1().previewCubeView(inst, cubeName, viewName, cap);
    if (!rows || rows.length === 0) return `View ${viewName} on ${cubeName} returned no rows.`;
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
    return `Data of view ${viewName} on ${cubeName} (first ${cap} rows):\n\n${head}\n${sep}\n${body}`;
}

export async function apiListThreads(inst: string): Promise<string> {
    const threads = await tm1().getThreads(inst);
    if (!threads || threads.length === 0) return `No active threads on ${inst}.`;
    const lines = threads.map((t: any) => {
        const id = t.ID ?? t.Id ?? '?';
        const parts = [t.Type, t.State, t.Function ?? t.Name, t.Context].filter(Boolean).join(' ');
        return `- [${id}] ${parts}`.replace(/\s+/g, ' ').trim();
    });
    return `${threads.length} threads on ${inst}:\n${lines.join('\n')}`;
}

export async function apiGetMessageLog(inst: string, top: number): Promise<string> {
    const cap = Math.min(Math.max(top || 100, 1), 500);
    const entries = await tm1().getMessageLogEntries(inst, cap);
    if (!entries || entries.length === 0) return `No message log entries on ${inst}.`;
    const lines = entries.map((e: any) => {
        const time = e.TimeStamp ?? e.Timestamp ?? '';
        const level = e.Level ?? '';
        const logger = e.Logger ?? '';
        const msg = e.Message ?? '';
        return `- ${time} [${level}] ${logger}: ${msg}`;
    });
    return `Last ${entries.length} message log entries on ${inst}:\n${lines.join('\n')}`;
}

export async function apiListChores(inst: string): Promise<string> {
    const chores = await tm1().getChores(inst);
    if (!chores || chores.length === 0) return `No chores on ${inst}.`;
    const lines = chores.map((c: any) => {
        const name = c.Name ?? '?';
        const active = c.Active === true ? 'active' : (c.Active === false ? 'inactive' : '');
        return `- ${name}${active ? ` (${active})` : ''}`;
    });
    return `${chores.length} chores on ${inst}:\n${lines.join('\n')}`;
}

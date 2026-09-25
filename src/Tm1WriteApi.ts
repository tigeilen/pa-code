import { TM1Service } from './TM1Service';

/**
 * Shared write / model-building API over the connected TM1 instances.
 *
 * Companion to Tm1ReadApi: every function delegates to the live, authenticated
 * TM1Service singleton (Basic / CAM / OAuth). These functions mutate the server
 * and are only exposed by the MCP server when its mode is 'readwrite'. Each
 * returns a short human-readable summary string for the calling agent.
 */

function tm1(): TM1Service { return TM1Service.getInstance(); }

// --- Dimensions, hierarchies & elements ---------------------------------------

export async function apiCreateDimension(inst: string, dimensionName: string, hierarchyName?: string): Promise<string> {
    if (!dimensionName) throw new Error('dimensionName is required.');
    await tm1().createDimension(inst, dimensionName, hierarchyName);
    return `Created dimension '${dimensionName}'${hierarchyName && hierarchyName !== dimensionName ? ` with hierarchy '${hierarchyName}'` : ''}.`;
}

export async function apiCreateHierarchy(inst: string, dimensionName: string, hierarchyName: string): Promise<string> {
    if (!dimensionName || !hierarchyName) throw new Error('dimensionName and hierarchyName are required.');
    await tm1().createHierarchy(inst, dimensionName, hierarchyName);
    return `Created hierarchy '${hierarchyName}' in dimension '${dimensionName}'.`;
}

export async function apiDeleteDimension(inst: string, dimensionName: string): Promise<string> {
    if (!dimensionName) throw new Error('dimensionName is required.');
    await tm1().deleteDimension(inst, dimensionName);
    return `Deleted dimension '${dimensionName}'.`;
}

export async function apiAddElements(inst: string, dimensionName: string, hierarchyName: string | undefined, elements: { name: string; type?: string }[]): Promise<string> {
    if (!dimensionName) throw new Error('dimensionName is required.');
    if (!Array.isArray(elements) || elements.length === 0) throw new Error('elements must be a non-empty array of { name, type }.');
    if (elements.length > 20000) throw new Error('Too many elements in one call (max 20000). Split into chunks.');
    const r = await tm1().addElements(inst, dimensionName, hierarchyName || dimensionName, elements);
    return `Added ${r.added} element(s) to '${dimensionName}'${r.failed ? ` (${r.failed} skipped/failed — likely already exist)` : ''}.`;
}

export async function apiAddEdges(inst: string, dimensionName: string, hierarchyName: string | undefined, edges: { parent: string; child: string; weight?: number }[]): Promise<string> {
    if (!dimensionName) throw new Error('dimensionName is required.');
    if (!Array.isArray(edges) || edges.length === 0) throw new Error('edges must be a non-empty array of { parent, child, weight }.');
    if (edges.length > 20000) throw new Error('Too many edges in one call (max 20000). Split into chunks.');
    const r = await tm1().addEdges(inst, dimensionName, hierarchyName || dimensionName, edges);
    return `Added ${r.added} edge(s) to '${dimensionName}'${r.failed ? ` (${r.failed} skipped/failed)` : ''}.`;
}

export async function apiDeleteElement(inst: string, dimensionName: string, hierarchyName: string | undefined, elementName: string): Promise<string> {
    if (!dimensionName || !elementName) throw new Error('dimensionName and elementName are required.');
    await tm1().deleteElement(inst, dimensionName, hierarchyName || dimensionName, elementName);
    return `Deleted element '${elementName}' from '${dimensionName}'.`;
}

export async function apiUpdateElementAttributes(inst: string, dimensionName: string, hierarchyName: string | undefined, elementName: string, attributes: Record<string, string | number>): Promise<string> {
    if (!dimensionName || !elementName) throw new Error('dimensionName and elementName are required.');
    if (!attributes || typeof attributes !== 'object' || Object.keys(attributes).length === 0) throw new Error('attributes must be a non-empty object of { attributeName: value }.');
    await tm1().updateElementAttributes(inst, dimensionName, hierarchyName || dimensionName, elementName, attributes);
    return `Set ${Object.keys(attributes).length} attribute(s) on '${elementName}' in '${dimensionName}'.`;
}

// --- Cubes & rules ------------------------------------------------------------

export async function apiCreateCube(inst: string, cubeName: string, dimensions: string[]): Promise<string> {
    if (!cubeName) throw new Error('cubeName is required.');
    if (!Array.isArray(dimensions) || dimensions.length === 0) throw new Error('dimensions must be a non-empty ordered array of dimension names.');
    await tm1().createCube(inst, cubeName, dimensions);
    return `Created cube '${cubeName}' over [${dimensions.join(', ')}].`;
}

export async function apiDeleteCube(inst: string, cubeName: string): Promise<string> {
    if (!cubeName) throw new Error('cubeName is required.');
    await tm1().deleteCube(inst, cubeName);
    return `Deleted cube '${cubeName}'.`;
}

export async function apiSetCubeRules(inst: string, cubeName: string, rules: string): Promise<string> {
    if (!cubeName) throw new Error('cubeName is required.');
    await tm1().updateRule(inst, cubeName, rules || '');
    return `Updated rules on cube '${cubeName}' (${(rules || '').length} chars).`;
}

// --- Cell data ----------------------------------------------------------------

function normTuple(tuple: { dimension: string; element: string; hierarchy?: string }[]): { dimension: string; hierarchy: string; element: string }[] {
    if (!Array.isArray(tuple) || tuple.length === 0) throw new Error('tuple must be a non-empty array of { dimension, element, hierarchy? }.');
    return tuple.map(t => {
        if (!t.dimension || t.element == null) throw new Error('each tuple entry needs { dimension, element }.');
        return { dimension: t.dimension, hierarchy: t.hierarchy || t.dimension, element: String(t.element) };
    });
}

export async function apiWriteCell(inst: string, cubeName: string, tuple: { dimension: string; element: string; hierarchy?: string }[], value: string | number): Promise<string> {
    if (!cubeName) throw new Error('cubeName is required.');
    await tm1().writeCellByTuple(inst, cubeName, normTuple(tuple), value);
    return `Wrote value into '${cubeName}'.`;
}

export async function apiWriteCells(inst: string, cubeName: string, cells: { tuple: { dimension: string; element: string; hierarchy?: string }[]; value: string | number }[]): Promise<string> {
    if (!cubeName) throw new Error('cubeName is required.');
    if (!Array.isArray(cells) || cells.length === 0) throw new Error('cells must be a non-empty array of { tuple, value }.');
    if (cells.length > 10000) throw new Error('Too many cells in one call (max 10000). Split into chunks.');
    let written = 0, failed = 0; let firstError: string | undefined;
    for (const c of cells) {
        try { await tm1().writeCellByTuple(inst, cubeName, normTuple(c.tuple), c.value); written++; }
        catch (e: any) { failed++; if (!firstError) firstError = e?.message || String(e); }
    }
    if (written === 0) throw new Error(`No cells written to '${cubeName}': ${firstError || 'unknown error'}`);
    return `Wrote ${written} cell(s) into '${cubeName}'${failed ? ` (${failed} failed: ${firstError})` : ''}.`;
}

// --- TI processes -------------------------------------------------------------

interface ProcCode { prolog?: string; metadata?: string; data?: string; epilog?: string; propertiesJson?: string; }

function toProcessContent(code: ProcCode): any {
    return {
        Prolog: code.prolog || '', Metadata: code.metadata || '', Data: code.data || '', Epilog: code.epilog || '',
        PropertiesJSON: code.propertiesJson || ''
    };
}

export async function apiCreateProcess(inst: string, processName: string, code: ProcCode): Promise<string> {
    if (!processName) throw new Error('processName is required.');
    await tm1().createProcess(inst, processName);
    if (code && (code.prolog || code.metadata || code.data || code.epilog || code.propertiesJson)) {
        await tm1().updateProcessCode(inst, processName, toProcessContent(code));
    }
    return `Created TI process '${processName}' (compiled OK).`;
}

export async function apiUpdateProcess(inst: string, processName: string, code: ProcCode): Promise<string> {
    if (!processName) throw new Error('processName is required.');
    await tm1().updateProcessCode(inst, processName, toProcessContent(code));
    return `Updated TI process '${processName}' (compiled OK).`;
}

export async function apiDeleteProcess(inst: string, processName: string): Promise<string> {
    if (!processName) throw new Error('processName is required.');
    await tm1().deleteProcess(inst, processName);
    return `Deleted TI process '${processName}'.`;
}

export async function apiExecuteProcess(inst: string, processName: string, parameters: { Name: string; Value: any }[]): Promise<string> {
    if (!processName) throw new Error('processName is required.');
    const params = Array.isArray(parameters) ? parameters : [];
    const data = await tm1().executeProcess(inst, processName, params);
    // TM1 answers HTTP 200 whatever happened; the real result is the status code.
    const status = String(data?.ProcessExecuteStatusCode || 'Unknown');
    const outcome = status === 'CompletedSuccessfully' ? 'succeeded'
        : (status === 'Aborted' || status === 'QuitCalled' || status === 'RollbackCalled') ? 'rolled_back'
        : 'completed_with_errors';
    let errText = '';
    const logName = data?.ErrorLogFile?.Filename || data?.ErrorLogFile?.Name;
    if (outcome !== 'succeeded' && logName) {
        try { errText = '\n\nError log:\n' + await tm1().getErrorLog(inst, logName); } catch { /* ignore */ }
    }
    return `Process '${processName}' — outcome: ${outcome} (status: ${status}).${errText}`;
}

// --- Views & subsets ----------------------------------------------------------

export async function apiCreateView(inst: string, cubeName: string, viewName: string, mdx: string, isPrivate?: boolean): Promise<string> {
    if (!cubeName || !viewName || !mdx) throw new Error('cubeName, viewName and mdx are required.');
    await tm1().saveView(inst, cubeName, viewName, mdx, !!isPrivate);
    return `Saved ${isPrivate ? 'private' : 'public'} MDX view '${viewName}' on cube '${cubeName}'.`;
}

export async function apiDeleteView(inst: string, cubeName: string, viewName: string): Promise<string> {
    if (!cubeName || !viewName) throw new Error('cubeName and viewName are required.');
    await tm1().deleteView(inst, cubeName, viewName);
    return `Deleted view '${viewName}' from cube '${cubeName}'.`;
}

export async function apiCreateSubset(inst: string, dimensionName: string, hierarchyName: string | undefined, subsetName: string, isPublic: boolean, mdx?: string, elements?: string[]): Promise<string> {
    if (!dimensionName || !subsetName) throw new Error('dimensionName and subsetName are required.');
    if (!mdx && (!elements || elements.length === 0)) throw new Error('provide either mdx (dynamic subset) or elements (static subset).');
    await tm1().saveSubset(inst, dimensionName, hierarchyName || dimensionName, subsetName, isPublic, { mdx, elements });
    return `Saved ${isPublic ? 'public' : 'private'} ${mdx ? 'dynamic' : 'static'} subset '${subsetName}' on '${dimensionName}'.`;
}

export async function apiDeleteSubset(inst: string, dimensionName: string, subsetName: string): Promise<string> {
    if (!dimensionName || !subsetName) throw new Error('dimensionName and subsetName are required.');
    await tm1().deleteSubset(inst, dimensionName, subsetName);
    return `Deleted subset '${subsetName}' from '${dimensionName}'.`;
}

// --- Chores -------------------------------------------------------------------

export async function apiCreateChore(inst: string, choreBody: any): Promise<string> {
    if (!choreBody || !choreBody.Name) throw new Error('choreBody with at least a Name is required.');
    await tm1().createChore(inst, choreBody);
    return `Created chore '${choreBody.Name}'.`;
}

export async function apiUpdateChore(inst: string, choreName: string, choreBody: any): Promise<string> {
    if (!choreName) throw new Error('choreName is required.');
    await tm1().updateChore(inst, choreName, choreBody || {});
    return `Updated chore '${choreName}'.`;
}

export async function apiActivateChore(inst: string, choreName: string, active: boolean): Promise<string> {
    if (!choreName) throw new Error('choreName is required.');
    await tm1().updateChoreActive(inst, choreName, active);
    return `${active ? 'Activated' : 'Deactivated'} chore '${choreName}'.`;
}

export async function apiExecuteChore(inst: string, choreName: string): Promise<string> {
    if (!choreName) throw new Error('choreName is required.');
    await tm1().executeChore(inst, choreName);
    return `Executed chore '${choreName}'.`;
}

export async function apiDeleteChore(inst: string, choreName: string): Promise<string> {
    if (!choreName) throw new Error('choreName is required.');
    await tm1().deleteChore(inst, choreName);
    return `Deleted chore '${choreName}'.`;
}

// --- Security & configuration -------------------------------------------------

export async function apiCreateUser(inst: string, userName: string, friendlyName?: string): Promise<string> {
    if (!userName) throw new Error('userName is required.');
    await tm1().createUser(inst, userName, friendlyName);
    return `Created user '${userName}'.`;
}

export async function apiDeleteUser(inst: string, userName: string): Promise<string> {
    if (!userName) throw new Error('userName is required.');
    await tm1().deleteUser(inst, userName);
    return `Deleted user '${userName}'.`;
}

export async function apiCreateGroup(inst: string, groupName: string): Promise<string> {
    if (!groupName) throw new Error('groupName is required.');
    await tm1().createGroup(inst, groupName);
    return `Created group '${groupName}'.`;
}

export async function apiDeleteGroup(inst: string, groupName: string): Promise<string> {
    if (!groupName) throw new Error('groupName is required.');
    await tm1().deleteGroup(inst, groupName);
    return `Deleted group '${groupName}'.`;
}

export async function apiAddUserToGroup(inst: string, userName: string, groupName: string): Promise<string> {
    if (!userName || !groupName) throw new Error('userName and groupName are required.');
    await tm1().addUserToGroup(inst, userName, groupName);
    return `Added user '${userName}' to group '${groupName}'.`;
}

export async function apiUpdateConfigParameter(inst: string, parameterName: string, value: any): Promise<string> {
    if (!parameterName) throw new Error('parameterName is required.');
    await tm1().updateConfigurationParameterByName(inst, parameterName, value);
    return `Set configuration parameter '${parameterName}'.`;
}

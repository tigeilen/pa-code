import * as http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import * as vscode from 'vscode';
import * as api from '../Tm1ReadApi';
import * as wapi from '../Tm1WriteApi';

/**
 * In-process MCP (Model Context Protocol) server for pa-code.
 *
 * This is a real MCP endpoint — it speaks JSON-RPC 2.0 over the MCP Streamable
 * HTTP transport on a loopback port — but it runs *inside* the extension host,
 * so it reuses the live, authenticated TM1Service connection (Basic / CAM /
 * OAuth). No subprocess, no credential hand-off, no second connection layer.
 *
 * It exposes the full MCP primitive set, all read-only and all backed by the
 * shared Tm1ReadApi (the single source of truth):
 *   - Tools      (list cubes/dimensions/processes, get process code & rules,
 *                 search TI code, analyze usage, execute read-only MDX, …).
 *   - Resources  (tm1://… context that can be attached in chat, e.g. a process'
 *                 code or a cube's rules) + resource templates with completion.
 *   - Prompts    (reusable prompt templates: explain process, review rules,
 *                 impact analysis).
 *
 * This is the only AI surface for TM1 in pa-code (the earlier Language Model
 * Tools were consolidated here so external MCP clients get the same tools and
 * VS Code never shows a tool twice).
 *
 * Security: bound to 127.0.0.1 only, a random per-session bearer token is
 * required on every request (VS Code passes it via the server definition
 * headers), the Host header must be loopback, and the body size is capped.
 */

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'pa-code-tm1', version: '3.7.0' };
const MAX_BODY = 5_000_000;

const INSTANCE_ARG = { instance: { type: 'string', description: 'Connected instance name. Optional if exactly one instance is connected.' } };

interface McpToolDef {
    name: string;
    description: string;
    inputSchema: any;
    run: (args: any) => Promise<string>;
    /** True for tools that mutate the server — only exposed in read/write mode. */
    write?: boolean;
    /** When set, the destructive action requires args.confirm to equal args[confirmArg]. */
    confirmArg?: string;
}

interface JsonRpcMessage { jsonrpc?: string; id?: unknown; method?: string; params?: any; }

export class Tm1McpServer {
    private httpServer?: http.Server;
    private port = 0;
    private token = '';
    private sessions = new Set<string>();
    private starting?: Promise<void>;

    /** Key under which the (persisted) external bearer token is stored. */
    private static readonly TOKEN_KEY = 'pa-code.mcpServer.token';

    /**
     * @param secrets Optional SecretStorage. When provided, the bearer token is
     * persisted so external MCP clients (Claude, Codex, Cline, Continue, …) can
     * be configured once and keep working across VS Code restarts. Without it,
     * a fresh random token is used per session (the original Copilot-only mode).
     */
    constructor(private secrets?: vscode.SecretStorage) {}

    /** Starts the server (idempotent) and returns the endpoint + auth token. */
    async ensureStarted(): Promise<{ uri: string; token: string; version: string }> {
        if (!this.httpServer) {
            if (!this.starting) this.starting = this.start();
            await this.starting;
        }
        return { uri: `http://127.0.0.1:${this.port}/mcp`, token: this.token, version: SERVER_INFO.version };
    }

    /** True once the HTTP listener is up. */
    get isRunning(): boolean { return !!this.httpServer && this.port > 0; }

    dispose(): void {
        try { this.httpServer?.close(); } catch { /* ignore */ }
        this.httpServer = undefined;
        this.starting = undefined;
        this.sessions.clear();
    }

    /** Loads the persisted token, or creates and stores a new one. */
    private async loadOrCreateToken(): Promise<string> {
        // Optional env-var source of truth. Lets an external launcher (e.g. a
        // Codex MCP bridge) share the same token via `--bearer-token-env-var`,
        // without patching anything. Takes precedence when set and non-empty.
        const envName = vscode.workspace.getConfiguration('pa-code').get<string>('mcpServer.tokenEnvVar', '').trim();
        if (envName) {
            const fromEnv = process.env[envName];
            if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
        }
        if (this.secrets) {
            let t = await this.secrets.get(Tm1McpServer.TOKEN_KEY);
            if (!t) {
                t = randomBytes(24).toString('hex');
                await this.secrets.store(Tm1McpServer.TOKEN_KEY, t);
            }
            return t;
        }
        return randomBytes(24).toString('hex');
    }

    /**
     * Rotates the bearer token (invalidates any external client configured with
     * the old one). Returns the new token. The server keeps running.
     */
    async regenerateToken(): Promise<string> {
        const t = randomBytes(24).toString('hex');
        if (this.secrets) await this.secrets.store(Tm1McpServer.TOKEN_KEY, t);
        this.token = t;
        return t;
    }

    private async start(): Promise<void> {
        this.token = await this.loadOrCreateToken();
        // A fixed port gives external clients a stable URL to configure once.
        // 0 (default) keeps the original behaviour: an OS-assigned random port.
        const fixedPort = vscode.workspace.getConfiguration('pa-code').get<number>('mcpServer.port', 0) || 0;
        this.httpServer = http.createServer((req, res) => { void this.handle(req, res); });
        return new Promise((resolve, reject) => {
            this.httpServer!.on('error', reject);
            this.httpServer!.listen(fixedPort, '127.0.0.1', () => {
                const addr = this.httpServer!.address();
                if (addr && typeof addr === 'object') this.port = addr.port;
                resolve();
            });
        });
    }

    private authOk(req: http.IncomingMessage): boolean {
        const header = String(req.headers['authorization'] || '');
        const expected = `Bearer ${this.token}`;
        if (header.length !== expected.length) return false;
        try {
            return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
        } catch { return false; }
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        try {
            if (!this.authOk(req)) { res.writeHead(401).end(); return; }

            // Loopback-only: reject non-local Host headers (DNS-rebinding guard).
            const host = String(req.headers['host'] || '');
            if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) { res.writeHead(403).end(); return; }

            if (!(req.url || '').startsWith('/mcp')) { res.writeHead(404).end(); return; }

            if (req.method === 'GET') { res.writeHead(405).end(); return; }        // no server-initiated SSE
            if (req.method === 'DELETE') {
                const sid = req.headers['mcp-session-id'];
                if (sid) this.sessions.delete(String(sid));
                res.writeHead(200).end();
                return;
            }
            if (req.method !== 'POST') { res.writeHead(405).end(); return; }

            const raw = await this.readBody(req);
            let parsed: JsonRpcMessage | JsonRpcMessage[];
            try { parsed = JSON.parse(raw); } catch { this.send(res, 200, this.err(null, -32700, 'Parse error')); return; }

            const messages = Array.isArray(parsed) ? parsed : [parsed];
            const responses: any[] = [];
            let sessionHeader: Record<string, string> | undefined;

            for (const m of messages) {
                if (!m || typeof m.method !== 'string') continue;  // ignore responses
                const isNotification = m.id === undefined || m.id === null;

                if (m.method === 'initialize') {
                    const sid = randomBytes(16).toString('hex');
                    this.sessions.add(sid);
                    sessionHeader = { 'Mcp-Session-Id': sid };
                    responses.push(this.ok(m.id, {
                        protocolVersion: (m.params && m.params.protocolVersion) || PROTOCOL_VERSION,
                        capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, prompts: {}, completions: {} },
                        serverInfo: SERVER_INFO
                    }));
                    continue;
                }

                if (isNotification) continue;  // e.g. notifications/initialized — acknowledge with 202 below

                try {
                    responses.push(this.ok(m.id, await this.dispatch(m.method, m.params || {})));
                } catch (e: any) {
                    responses.push(this.err(m.id, -32603, e?.message || 'Internal error'));
                }
            }

            if (responses.length === 0) { res.writeHead(202, sessionHeader || {}).end(); return; }
            this.send(res, 200, Array.isArray(parsed) ? responses : responses[0], sessionHeader);
        } catch {
            try { res.writeHead(500).end(); } catch { /* ignore */ }
        }
    }

    private dispatch(method: string, params: any): Promise<any> | any {
        switch (method) {
            case 'ping': return {};
            case 'tools/list': return this.listTools();
            case 'tools/call': return this.callTool(String(params?.name || ''), params?.arguments || {});
            case 'resources/list': return this.listResources();
            case 'resources/templates/list': return this.listTemplates();
            case 'resources/read': return this.readResource(String(params?.uri || ''));
            case 'prompts/list': return this.listPrompts();
            case 'prompts/get': return this.getPrompt(String(params?.name || ''), params?.arguments || {});
            case 'completion/complete': return this.complete(params || {});
            default: throw new Error(`Method not found: ${method}`);
        }
    }

    // --- Tools ---------------------------------------------------------------

    private readonly toolDefs: McpToolDef[] = this.buildTools();
    private readonly writeToolDefs: McpToolDef[] = this.buildWriteTools();
    private readonly toolMap = new Map([...this.toolDefs, ...this.writeToolDefs].map(t => [t.name, t]));

    /** True when the MCP server is configured for read/write (write tools exposed). */
    private get writeEnabled(): boolean {
        return vscode.workspace.getConfiguration('pa-code').get<string>('mcpServer.mode', 'readonly') === 'readwrite';
    }

    private listTools() {
        const tools = this.writeEnabled ? [...this.toolDefs, ...this.writeToolDefs] : this.toolDefs;
        return { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    }

    private async callTool(name: string, args: any) {
        const tool = this.toolMap.get(name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        if (tool.write && !this.writeEnabled) {
            return { content: [{ type: 'text', text: "Error: read/write mode is disabled. Enable it in the pa-code setting 'pa-code.mcpServer.mode' (set it to 'readwrite') to use write tools." }], isError: true };
        }
        if (tool.confirmArg) {
            const target = String((args || {})[tool.confirmArg] ?? '');
            if (target === '' || String((args || {}).confirm ?? '') !== target) {
                return { content: [{ type: 'text', text: `Error: this action is destructive/irreversible. Re-call '${tool.name}' with confirm set to the exact ${tool.confirmArg} value ("${target}") to proceed.` }], isError: true };
            }
        }
        try {
            const text = await tool.run(args || {});
            return { content: [{ type: 'text', text }] };
        } catch (e: any) {
            return { content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }], isError: true };
        }
    }

    /** Resolves the instance, then runs fn; returns the resolver error text otherwise. */
    private inst(args: any, fn: (inst: string) => Promise<string>): Promise<string> {
        const r = api.resolveInstance(args?.instance);
        if (r.error) return Promise.resolve(r.error);
        return fn(r.name!);
    }

    private buildTools(): McpToolDef[] {
        const obj = (props: any, required?: string[]) => ({ type: 'object', properties: { ...props }, ...(required ? { required } : {}) });
        return [
            { name: 'tm1_list_instances', description: 'List the connected TM1 / Planning Analytics instances.', inputSchema: obj({}),
              run: async () => api.apiListInstances() },
            { name: 'tm1_list_cubes', description: 'List the cubes of a connected TM1 database.', inputSchema: obj({ ...INSTANCE_ARG, includeControl: { type: 'boolean', description: "Include control cubes (name starts with '}'). Default false." } }),
              run: (a) => this.inst(a, (i) => api.apiListCubes(i, !!a.includeControl)) },
            { name: 'tm1_list_dimensions', description: 'List the dimensions of a connected TM1 database.', inputSchema: obj({ ...INSTANCE_ARG, includeControl: { type: 'boolean', description: "Include control dimensions. Default false." } }),
              run: (a) => this.inst(a, (i) => api.apiListDimensions(i, !!a.includeControl)) },
            { name: 'tm1_list_processes', description: 'List the TurboIntegrator processes of a connected TM1 database.', inputSchema: obj({ ...INSTANCE_ARG, includeControl: { type: 'boolean', description: "Include control processes. Default false." } }),
              run: (a) => this.inst(a, (i) => api.apiListProcesses(i, !!a.includeControl)) },
            { name: 'tm1_get_process_code', description: 'Return the full source (Prolog/Metadata/Data/Epilog) plus parameters/datasource/variables of a TI process.', inputSchema: obj({ processName: { type: 'string', description: 'Exact TI process name.' }, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => api.apiGetProcessCode(i, String(a.processName || ''))) },
            { name: 'tm1_get_process_parameters', description: 'Return the parameters of a TI process.', inputSchema: obj({ processName: { type: 'string', description: 'Exact TI process name.' }, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => api.apiGetProcessParameters(i, String(a.processName || ''))) },
            { name: 'tm1_get_cube_rules', description: 'Return the rules text of a TM1 cube.', inputSchema: obj({ cubeName: { type: 'string', description: 'Exact cube name.' }, ...INSTANCE_ARG }, ['cubeName']),
              run: (a) => this.inst(a, (i) => api.apiGetCubeRules(i, String(a.cubeName || ''))) },
            { name: 'tm1_get_cube_dimensions', description: 'Return the ordered dimensions (and hierarchies) of a TM1 cube.', inputSchema: obj({ cubeName: { type: 'string', description: 'Exact cube name.' }, ...INSTANCE_ARG }, ['cubeName']),
              run: (a) => this.inst(a, (i) => api.apiGetCubeDimensions(i, String(a.cubeName || ''))) },
            { name: 'tm1_list_dimension_elements', description: 'List the elements of a TM1 dimension hierarchy (capped).', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string', description: 'Defaults to the dimension name.' }, limit: { type: 'number', description: '1-5000, default 500.' }, ...INSTANCE_ARG }, ['dimensionName']),
              run: (a) => this.inst(a, (i) => api.apiListDimensionElements(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, Number(a.limit) || 500)) },
            { name: 'tm1_list_hierarchies', description: 'List the hierarchies of a TM1 dimension.', inputSchema: obj({ dimensionName: { type: 'string' }, ...INSTANCE_ARG }, ['dimensionName']),
              run: (a) => this.inst(a, (i) => api.apiListHierarchies(i, String(a.dimensionName || ''))) },
            { name: 'tm1_list_views', description: 'List the views defined on a TM1 cube.', inputSchema: obj({ cubeName: { type: 'string' }, ...INSTANCE_ARG }, ['cubeName']),
              run: (a) => this.inst(a, (i) => api.apiListViews(i, String(a.cubeName || ''))) },
            { name: 'tm1_list_subsets', description: 'List the public subsets of a TM1 dimension.', inputSchema: obj({ dimensionName: { type: 'string' }, ...INSTANCE_ARG }, ['dimensionName']),
              run: (a) => this.inst(a, (i) => api.apiListSubsets(i, String(a.dimensionName || ''))) },
            { name: 'tm1_search_code', description: 'Regex search across all TI process code (Prolog/Metadata/Data/Epilog).', inputSchema: obj({ pattern: { type: 'string', description: 'Case-insensitive regex.' }, includeControl: { type: 'boolean' }, maxHits: { type: 'number', description: '1-1000, default 200.' }, ...INSTANCE_ARG }, ['pattern']),
              run: (a) => this.inst(a, (i) => api.apiSearchCode(i, String(a.pattern || ''), !!a.includeControl, Number(a.maxHits) || 200)) },
            { name: 'tm1_analyze_object_usage', description: 'Find every TI process and cube rule that references a cube or dimension.', inputSchema: obj({ objectName: { type: 'string', description: 'Cube or dimension name.' }, ...INSTANCE_ARG }, ['objectName']),
              run: (a) => this.inst(a, (i) => api.apiAnalyzeObjectUsage(i, String(a.objectName || ''))) },
            { name: 'tm1_execute_mdx', description: 'Execute a read-only MDX query and return non-empty cell values (capped).', inputSchema: obj({ mdx: { type: 'string' }, maxCells: { type: 'number', description: '1-500, default 100.' }, ...INSTANCE_ARG }, ['mdx']),
              run: (a) => this.inst(a, (i) => api.apiExecuteMdx(i, String(a.mdx || ''), Number(a.maxCells) || 100)) },
            { name: 'tm1_get_server_info', description: 'Return the static server configuration snapshot.', inputSchema: obj({ ...INSTANCE_ARG }),
              run: (a) => this.inst(a, (i) => api.apiGetServerInfo(i)) },
            // --- IBM MCP-inspired additions ---
            { name: 'tm1_get_process_error_log', description: 'Return the latest error log produced by a failed run of a TI process.', inputSchema: obj({ processName: { type: 'string' }, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => api.apiGetProcessErrorLog(i, String(a.processName || ''))) },
            { name: 'tm1_get_cube_sample_members', description: 'Return a few sample members from each dimension of a cube (helps build MDX).', inputSchema: obj({ cubeName: { type: 'string' }, perDimension: { type: 'number', description: '1-50, default 5.' }, ...INSTANCE_ARG }, ['cubeName']),
              run: (a) => this.inst(a, (i) => api.apiGetCubeSampleMembers(i, String(a.cubeName || ''), Number(a.perDimension) || 5)) },
            { name: 'tm1_search_dimension_elements', description: 'Find elements of a dimension hierarchy matching a search term.', inputSchema: obj({ dimensionName: { type: 'string' }, searchTerm: { type: 'string' }, hierarchyName: { type: 'string', description: 'Defaults to the dimension name.' }, limit: { type: 'number', description: '1-500, default 50.' }, ...INSTANCE_ARG }, ['dimensionName', 'searchTerm']),
              run: (a) => this.inst(a, (i) => api.apiSearchDimensionElements(i, String(a.dimensionName || ''), String(a.searchTerm || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, Number(a.limit) || 50)) },
            { name: 'tm1_get_view_data', description: 'Execute a saved cube view and return its data as a markdown table (capped).', inputSchema: obj({ cubeName: { type: 'string' }, viewName: { type: 'string' }, top: { type: 'number', description: '1-200, default 25.' }, ...INSTANCE_ARG }, ['cubeName', 'viewName']),
              run: (a) => this.inst(a, (i) => api.apiGetViewData(i, String(a.cubeName || ''), String(a.viewName || ''), Number(a.top) || 25)) },
            { name: 'tm1_list_threads', description: 'List active threads (running processes / queries) on the server.', inputSchema: obj({ ...INSTANCE_ARG }),
              run: (a) => this.inst(a, (i) => api.apiListThreads(i)) },
            { name: 'tm1_get_message_log', description: 'Return recent TM1 server message log entries.', inputSchema: obj({ top: { type: 'number', description: '1-500, default 100.' }, ...INSTANCE_ARG }),
              run: (a) => this.inst(a, (i) => api.apiGetMessageLog(i, Number(a.top) || 100)) },
            { name: 'tm1_list_chores', description: 'List the chores (with active flag) on the server.', inputSchema: obj({ ...INSTANCE_ARG }),
              run: (a) => this.inst(a, (i) => api.apiListChores(i)) }
        ];
    }

    /** Write / model-building tools. Only exposed when mcpServer.mode = 'readwrite'. */
    private buildWriteTools(): McpToolDef[] {
        const obj = (props: any, required?: string[]) => ({ type: 'object', properties: { ...props }, ...(required ? { required } : {}) });
        const CONFIRM = { confirm: { type: 'string', description: 'Repeat the exact target name here to confirm this destructive/irreversible action.' } };
        const anyVal = { description: 'The value (string or number).' };
        const elemArr = { elements: { type: 'array', description: 'Elements to add.', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', description: 'Numeric | String | Consolidated (also N/S/C). Default Numeric.' } }, required: ['name'] } } };
        const edgeArr = { edges: { type: 'array', description: 'Consolidation edges parent -> child.', items: { type: 'object', properties: { parent: { type: 'string' }, child: { type: 'string' }, weight: { type: 'number', description: 'Default 1.' } }, required: ['parent', 'child'] } } };
        const tupleArr = { tuple: { type: 'array', description: 'One entry per cube dimension: { dimension, element, hierarchy? }.', items: { type: 'object', properties: { dimension: { type: 'string' }, element: { type: 'string' }, hierarchy: { type: 'string' } }, required: ['dimension', 'element'] } } };
        return [
            // --- Dimensions, hierarchies & elements ---
            { name: 'tm1_create_dimension', write: true, description: 'Create a dimension with a leaves hierarchy.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string', description: 'Defaults to the dimension name.' }, ...INSTANCE_ARG }, ['dimensionName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateDimension(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined)) },
            { name: 'tm1_create_hierarchy', write: true, description: 'Create an additional hierarchy in an existing dimension.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string' }, ...INSTANCE_ARG }, ['dimensionName', 'hierarchyName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateHierarchy(i, String(a.dimensionName || ''), String(a.hierarchyName || ''))) },
            { name: 'tm1_add_elements', write: true, description: 'Add elements (Numeric/String/Consolidated) to a dimension hierarchy. Existing elements are skipped.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string', description: 'Defaults to the dimension name.' }, ...elemArr, ...INSTANCE_ARG }, ['dimensionName', 'elements']),
              run: (a) => this.inst(a, (i) => wapi.apiAddElements(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, a.elements || [])) },
            { name: 'tm1_add_edges', write: true, description: 'Add consolidation edges (parent -> child, with weight) to a hierarchy.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string' }, ...edgeArr, ...INSTANCE_ARG }, ['dimensionName', 'edges']),
              run: (a) => this.inst(a, (i) => wapi.apiAddEdges(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, a.edges || [])) },
            { name: 'tm1_update_element_attributes', write: true, description: 'Set attribute values on an element (writes the }ElementAttributes_<dim> cube).', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string' }, elementName: { type: 'string' }, attributes: { type: 'object', description: 'Map of attributeName -> value.' }, ...INSTANCE_ARG }, ['dimensionName', 'elementName', 'attributes']),
              run: (a) => this.inst(a, (i) => wapi.apiUpdateElementAttributes(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, String(a.elementName || ''), a.attributes || {})) },
            { name: 'tm1_delete_element', write: true, confirmArg: 'elementName', description: 'Delete an element from a hierarchy. Destructive — requires confirm.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string' }, elementName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['dimensionName', 'elementName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteElement(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, String(a.elementName || ''))) },
            { name: 'tm1_delete_dimension', write: true, confirmArg: 'dimensionName', description: 'Delete a dimension. Destructive — requires confirm.', inputSchema: obj({ dimensionName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['dimensionName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteDimension(i, String(a.dimensionName || ''))) },
            // --- Cubes & rules ---
            { name: 'tm1_create_cube', write: true, description: 'Create a cube over an ordered list of existing dimensions.', inputSchema: obj({ cubeName: { type: 'string' }, dimensions: { type: 'array', items: { type: 'string' }, description: 'Ordered dimension names.' }, ...INSTANCE_ARG }, ['cubeName', 'dimensions']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateCube(i, String(a.cubeName || ''), a.dimensions || [])) },
            { name: 'tm1_delete_cube', write: true, confirmArg: 'cubeName', description: 'Delete a cube. Destructive — requires confirm.', inputSchema: obj({ cubeName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['cubeName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteCube(i, String(a.cubeName || ''))) },
            { name: 'tm1_set_cube_rules', write: true, confirmArg: 'cubeName', description: 'Replace the rules of a cube (overwrites existing). Requires confirm.', inputSchema: obj({ cubeName: { type: 'string' }, rules: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['cubeName', 'rules']),
              run: (a) => this.inst(a, (i) => wapi.apiSetCubeRules(i, String(a.cubeName || ''), String(a.rules || ''))) },
            // --- Cell data ---
            { name: 'tm1_write_cell', write: true, confirmArg: 'cubeName', description: 'Write a single value into a cube cell (by tuple). Requires confirm.', inputSchema: obj({ cubeName: { type: 'string' }, ...tupleArr, value: anyVal, ...CONFIRM, ...INSTANCE_ARG }, ['cubeName', 'tuple', 'value']),
              run: (a) => this.inst(a, (i) => wapi.apiWriteCell(i, String(a.cubeName || ''), a.tuple || [], a.value)) },
            { name: 'tm1_write_cells', write: true, confirmArg: 'cubeName', description: 'Write many values into a cube (array of { tuple, value }). Requires confirm.', inputSchema: obj({ cubeName: { type: 'string' }, cells: { type: 'array', description: 'Array of { tuple:[{dimension,element,hierarchy?}], value }.', items: { type: 'object' } }, ...CONFIRM, ...INSTANCE_ARG }, ['cubeName', 'cells']),
              run: (a) => this.inst(a, (i) => wapi.apiWriteCells(i, String(a.cubeName || ''), a.cells || [])) },
            // --- TI processes ---
            { name: 'tm1_create_process', write: true, description: 'Create a TI process with code (Prolog/Metadata/Data/Epilog). Compiles on save.', inputSchema: obj({ processName: { type: 'string' }, prolog: { type: 'string' }, metadata: { type: 'string' }, data: { type: 'string' }, epilog: { type: 'string' }, propertiesJson: { type: 'string', description: 'Optional JSON with parameters/datasource/variables.' }, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateProcess(i, String(a.processName || ''), { prolog: a.prolog, metadata: a.metadata, data: a.data, epilog: a.epilog, propertiesJson: a.propertiesJson })) },
            { name: 'tm1_update_process', write: true, description: 'Replace the code of an existing TI process. Compiles on save.', inputSchema: obj({ processName: { type: 'string' }, prolog: { type: 'string' }, metadata: { type: 'string' }, data: { type: 'string' }, epilog: { type: 'string' }, propertiesJson: { type: 'string' }, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => wapi.apiUpdateProcess(i, String(a.processName || ''), { prolog: a.prolog, metadata: a.metadata, data: a.data, epilog: a.epilog, propertiesJson: a.propertiesJson })) },
            { name: 'tm1_delete_process', write: true, confirmArg: 'processName', description: 'Delete a TI process. Destructive — requires confirm.', inputSchema: obj({ processName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteProcess(i, String(a.processName || ''))) },
            { name: 'tm1_execute_process', write: true, confirmArg: 'processName', description: 'Execute a TI process (side effects). Requires confirm. Returns an outcome: succeeded / completed_with_errors / rolled_back.', inputSchema: obj({ processName: { type: 'string' }, parameters: { type: 'array', description: 'TI parameters as [{Name, Value}].', items: { type: 'object', properties: { Name: { type: 'string' }, Value: anyVal }, required: ['Name', 'Value'] } }, ...CONFIRM, ...INSTANCE_ARG }, ['processName']),
              run: (a) => this.inst(a, (i) => wapi.apiExecuteProcess(i, String(a.processName || ''), a.parameters || [])) },
            // --- Views & subsets ---
            { name: 'tm1_create_view', write: true, description: 'Save an MDX view on a cube (public by default).', inputSchema: obj({ cubeName: { type: 'string' }, viewName: { type: 'string' }, mdx: { type: 'string' }, isPrivate: { type: 'boolean' }, ...INSTANCE_ARG }, ['cubeName', 'viewName', 'mdx']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateView(i, String(a.cubeName || ''), String(a.viewName || ''), String(a.mdx || ''), !!a.isPrivate)) },
            { name: 'tm1_delete_view', write: true, confirmArg: 'viewName', description: 'Delete a cube view. Destructive — requires confirm.', inputSchema: obj({ cubeName: { type: 'string' }, viewName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['cubeName', 'viewName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteView(i, String(a.cubeName || ''), String(a.viewName || ''))) },
            { name: 'tm1_create_subset', write: true, description: 'Save a static (elements) or dynamic (mdx) subset on a dimension.', inputSchema: obj({ dimensionName: { type: 'string' }, hierarchyName: { type: 'string' }, subsetName: { type: 'string' }, isPublic: { type: 'boolean', description: 'Default true.' }, mdx: { type: 'string' }, elements: { type: 'array', items: { type: 'string' } }, ...INSTANCE_ARG }, ['dimensionName', 'subsetName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateSubset(i, String(a.dimensionName || ''), a.hierarchyName ? String(a.hierarchyName) : undefined, String(a.subsetName || ''), a.isPublic !== false, a.mdx ? String(a.mdx) : undefined, a.elements)) },
            { name: 'tm1_delete_subset', write: true, confirmArg: 'subsetName', description: 'Delete a public subset. Destructive — requires confirm.', inputSchema: obj({ dimensionName: { type: 'string' }, subsetName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['dimensionName', 'subsetName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteSubset(i, String(a.dimensionName || ''), String(a.subsetName || ''))) },
            // --- Chores ---
            { name: 'tm1_create_chore', write: true, description: 'Create a chore from a TM1 REST chore body (Name, Tasks, StartTime, DSTSensitive, ExecutionMode, Frequency, Active).', inputSchema: obj({ choreBody: { type: 'object' }, ...INSTANCE_ARG }, ['choreBody']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateChore(i, a.choreBody || {})) },
            { name: 'tm1_update_chore', write: true, description: 'Update a chore from a partial REST chore body.', inputSchema: obj({ choreName: { type: 'string' }, choreBody: { type: 'object' }, ...INSTANCE_ARG }, ['choreName', 'choreBody']),
              run: (a) => this.inst(a, (i) => wapi.apiUpdateChore(i, String(a.choreName || ''), a.choreBody || {})) },
            { name: 'tm1_activate_chore', write: true, description: 'Activate or deactivate a chore schedule.', inputSchema: obj({ choreName: { type: 'string' }, active: { type: 'boolean' }, ...INSTANCE_ARG }, ['choreName', 'active']),
              run: (a) => this.inst(a, (i) => wapi.apiActivateChore(i, String(a.choreName || ''), !!a.active)) },
            { name: 'tm1_execute_chore', write: true, confirmArg: 'choreName', description: 'Execute a chore now (side effects). Requires confirm.', inputSchema: obj({ choreName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['choreName']),
              run: (a) => this.inst(a, (i) => wapi.apiExecuteChore(i, String(a.choreName || ''))) },
            { name: 'tm1_delete_chore', write: true, confirmArg: 'choreName', description: 'Delete a chore. Destructive — requires confirm.', inputSchema: obj({ choreName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['choreName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteChore(i, String(a.choreName || ''))) },
            // --- Security & configuration ---
            { name: 'tm1_create_user', write: true, description: 'Create a TM1 user (client).', inputSchema: obj({ userName: { type: 'string' }, friendlyName: { type: 'string' }, ...INSTANCE_ARG }, ['userName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateUser(i, String(a.userName || ''), a.friendlyName ? String(a.friendlyName) : undefined)) },
            { name: 'tm1_delete_user', write: true, confirmArg: 'userName', description: 'Delete a TM1 user. Destructive — requires confirm.', inputSchema: obj({ userName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['userName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteUser(i, String(a.userName || ''))) },
            { name: 'tm1_create_group', write: true, description: 'Create a security group.', inputSchema: obj({ groupName: { type: 'string' }, ...INSTANCE_ARG }, ['groupName']),
              run: (a) => this.inst(a, (i) => wapi.apiCreateGroup(i, String(a.groupName || ''))) },
            { name: 'tm1_delete_group', write: true, confirmArg: 'groupName', description: 'Delete a security group. Destructive — requires confirm.', inputSchema: obj({ groupName: { type: 'string' }, ...CONFIRM, ...INSTANCE_ARG }, ['groupName']),
              run: (a) => this.inst(a, (i) => wapi.apiDeleteGroup(i, String(a.groupName || ''))) },
            { name: 'tm1_add_user_to_group', write: true, description: 'Add a user to a security group.', inputSchema: obj({ userName: { type: 'string' }, groupName: { type: 'string' }, ...INSTANCE_ARG }, ['userName', 'groupName']),
              run: (a) => this.inst(a, (i) => wapi.apiAddUserToGroup(i, String(a.userName || ''), String(a.groupName || ''))) },
            { name: 'tm1_update_config_parameter', write: true, confirmArg: 'parameterName', description: 'Set a server configuration parameter (sensitive). Requires confirm.', inputSchema: obj({ parameterName: { type: 'string' }, value: anyVal, ...CONFIRM, ...INSTANCE_ARG }, ['parameterName', 'value']),
              run: (a) => this.inst(a, (i) => wapi.apiUpdateConfigParameter(i, String(a.parameterName || ''), a.value)) }
        ];
    }

    // --- Resources -----------------------------------------------------------

    private listResources() {
        const resources = api.connectedInstances().map(inst => ({
            uri: `tm1://${encodeURIComponent(inst)}/server/info`,
            name: `${inst} — server info`,
            description: `Static server configuration of ${inst}`,
            mimeType: 'text/plain'
        }));
        return { resources };
    }

    private listTemplates() {
        return {
            resourceTemplates: [
                { uriTemplate: 'tm1://{instance}/process/{name}/code', name: 'TI process code', description: 'Source (Prolog/Metadata/Data/Epilog) + properties of a TI process', mimeType: 'text/plain' },
                { uriTemplate: 'tm1://{instance}/cube/{name}/rules', name: 'Cube rules', description: 'Rules text of a cube', mimeType: 'text/plain' },
                { uriTemplate: 'tm1://{instance}/cube/{name}/dimensions', name: 'Cube dimensions', description: 'Ordered dimensions of a cube', mimeType: 'text/plain' },
                { uriTemplate: 'tm1://{instance}/server/info', name: 'Server info', description: 'Static server configuration', mimeType: 'text/plain' }
            ]
        };
    }

    private async readResource(uri: string) {
        const text = await this.resolveResource(uri);
        return { contents: [{ uri, mimeType: 'text/plain', text }] };
    }

    private async resolveResource(uri: string): Promise<string> {
        if (!uri.startsWith('tm1://')) throw new Error(`Unsupported URI scheme: ${uri}`);
        const parts = uri.slice('tm1://'.length).split('/').map(p => { try { return decodeURIComponent(p); } catch { return p; } });
        const [instHint, category, ...rest] = parts;
        const resolved = api.resolveInstance(instHint);
        if (resolved.error) return resolved.error;
        const inst = resolved.name!;

        if (category === 'server' && rest[0] === 'info') return api.apiGetServerInfo(inst);
        if (category === 'process' && rest.length >= 2 && rest[rest.length - 1] === 'code') {
            return api.apiGetProcessCode(inst, rest.slice(0, rest.length - 1).join('/'));
        }
        if (category === 'cube' && rest.length >= 2) {
            const sub = rest[rest.length - 1];
            const name = rest.slice(0, rest.length - 1).join('/');
            if (sub === 'rules') return api.apiGetCubeRules(inst, name);
            if (sub === 'dimensions') return api.apiGetCubeDimensions(inst, name);
        }
        throw new Error(`Unrecognized resource URI: ${uri}`);
    }

    // --- Prompts -------------------------------------------------------------

    private listPrompts() {
        return {
            prompts: [
                {
                    name: 'tm1_explain_process',
                    title: 'Explain TI Process',
                    description: 'Explain what a TM1 TurboIntegrator process does, step by step.',
                    arguments: [
                        { name: 'process', description: 'TI process name', required: true },
                        { name: 'instance', description: 'Connected instance name (optional if only one is connected)', required: false }
                    ]
                },
                {
                    name: 'tm1_review_cube_rules',
                    title: 'Review Cube Rules',
                    description: "Review a cube's rules for correctness, feeder coverage and performance.",
                    arguments: [
                        { name: 'cube', description: 'Cube name', required: true },
                        { name: 'instance', description: 'Connected instance name (optional if only one is connected)', required: false }
                    ]
                },
                {
                    name: 'tm1_impact_analysis',
                    title: 'Impact Analysis',
                    description: 'Assess the impact of changing a cube or dimension across all TI processes and cube rules.',
                    arguments: [
                        { name: 'object', description: 'Cube or dimension name', required: true },
                        { name: 'instance', description: 'Connected instance name (optional if only one is connected)', required: false }
                    ]
                }
            ]
        };
    }

    private async getPrompt(name: string, args: Record<string, string>) {
        const resolved = api.resolveInstance(args.instance);
        if (resolved.error) throw new Error(resolved.error);
        const inst = resolved.name!;

        let description: string;
        let text: string;
        if (name === 'tm1_explain_process') {
            const code = await api.apiGetProcessCode(inst, String(args.process || ''));
            description = `Explain TI process ${args.process}`;
            text = `You are a TM1 / Planning Analytics expert. Explain what the following TurboIntegrator process does, tab by tab (Prolog, Metadata, Data, Epilog), including its parameters and data source. Point out side effects and risks.\n\n${code}`;
        } else if (name === 'tm1_review_cube_rules') {
            const rules = await api.apiGetCubeRules(inst, String(args.cube || ''));
            description = `Review rules of cube ${args.cube}`;
            text = `You are a TM1 rules and feeders expert. Review the following cube rules for correctness, feeder coverage (avoid under- and over-feeding) and performance. Suggest concrete improvements.\n\n${rules}`;
        } else if (name === 'tm1_impact_analysis') {
            const usage = await api.apiAnalyzeObjectUsage(inst, String(args.object || ''));
            description = `Impact analysis for ${args.object}`;
            text = `You are a TM1 model expert. Based on the following usage report, assess the impact of changing or removing '${args.object}'. List what would break and what to check before making the change.\n\n${usage}`;
        } else {
            throw new Error(`Unknown prompt: ${name}`);
        }
        return { description, messages: [{ role: 'user', content: { type: 'text', text } }] };
    }

    // --- Completion ----------------------------------------------------------

    private async complete(params: any) {
        const ref = params?.ref || {};
        const argName: string = params?.argument?.name || '';
        const argValue = String(params?.argument?.value || '');
        const ctxArgs: Record<string, string> = params?.context?.arguments || {};

        let values: string[] = [];
        try {
            if (argName === 'instance') {
                values = api.connectedInstances();
            } else {
                const resolved = api.resolveInstance(ctxArgs.instance);
                const inst = resolved.name;
                if (inst) {
                    const uri = String(ref?.uri || '');
                    if (argName === 'process' || (argName === 'name' && uri.includes('/process/'))) {
                        values = await api.listProcessNames(inst);
                    } else if (argName === 'cube' || (argName === 'name' && uri.includes('/cube/'))) {
                        values = await api.listCubeNames(inst);
                    } else if (argName === 'object') {
                        values = [...await api.listCubeNames(inst), ...await api.listDimensionNames(inst)];
                    }
                }
            }
        } catch { values = []; }

        const filtered = argValue ? values.filter(v => v.toLowerCase().includes(argValue.toLowerCase())) : values;
        const limited = filtered.slice(0, 100);
        return { completion: { values: limited, total: filtered.length, hasMore: filtered.length > limited.length } };
    }

    // --- Low-level helpers ---------------------------------------------------

    private ok(id: unknown, result: any) { return { jsonrpc: '2.0', id, result }; }
    private err(id: unknown, code: number, message: string) { return { jsonrpc: '2.0', id, error: { code, message } }; }

    private send(res: http.ServerResponse, status: number, obj: any, extraHeaders?: Record<string, string>): void {
        const body = obj !== undefined ? JSON.stringify(obj) : '';
        res.writeHead(status, { 'Content-Type': 'application/json', ...(extraHeaders || {}) });
        res.end(body);
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => {
                data += chunk;
                if (data.length > MAX_BODY) { req.destroy(); reject(new Error('Request body too large')); }
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }
}

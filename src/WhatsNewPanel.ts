import * as vscode from 'vscode';

/**
 * Shows a "What's New" webview once after the extension is updated to a new
 * version (similar to VS Code's release notes). The last shown version is kept
 * in globalState so it only appears once per update.
 */
export class WhatsNewPanel {
    private static readonly STATE_KEY = 'pa-code.lastWhatsNewVersion';

    /** Opens the What's New page if the installed version changed since last shown. */
    public static maybeShow(context: vscode.ExtensionContext) {
        const current = (context.extension.packageJSON.version as string) || '';
        const last = context.globalState.get<string>(WhatsNewPanel.STATE_KEY);
        if (current && current !== last) {
            // Only surface the highlights for feature releases (x.y.0) or first install.
            WhatsNewPanel.show(current);
            context.globalState.update(WhatsNewPanel.STATE_KEY, current);
        }
    }

    /** Opens the What's New page unconditionally (used by the command). */
    public static show(version: string) {
        const panel = vscode.window.createWebviewPanel(
            'paCodeWhatsNew',
            `What's New in PA Code ${version}`,
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        panel.webview.html = WhatsNewPanel.html(version);
    }

    private static html(version: string): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
:root {
    --fg: var(--vscode-foreground);
    --bg: var(--vscode-editor-background);
    --muted: var(--vscode-descriptionForeground, #999);
    --accent: var(--vscode-textLink-foreground, #3794ff);
    --card: var(--vscode-editorWidget-background, #252526);
    --border: var(--vscode-panel-border, #333);
    --badge: var(--vscode-badge-background, #4d4d4d);
    --badge-fg: var(--vscode-badge-foreground, #fff);
}
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); margin: 0; padding: 0; }
.topbar { display:flex; align-items:center; justify-content:center; gap:14px; padding:14px; border-bottom:1px solid var(--border); position:sticky; top:0; background:var(--bg); z-index:5; }
.dots { display:flex; gap:8px; }
.dot { width:10px; height:10px; border-radius:50%; background:var(--border); border:none; cursor:pointer; padding:0; }
.dot.active { background:var(--accent); }
.navbtn { background:var(--card); color:var(--fg); border:1px solid var(--border); border-radius:8px; width:34px; height:34px; font-size:16px; cursor:pointer; }
.navbtn:disabled { opacity:.35; cursor:default; }
.viewport { overflow:hidden; }
.track { display:flex; transition: transform .3s ease; }
.slide { min-width:100%; padding: 28px 26px 40px; }
.wrap { max-width: 900px; margin: 0 auto; }
.hero { text-align:center; margin-bottom: 22px; }
.hero .pill { display:inline-block; background:var(--badge); color:var(--badge-fg); border-radius:999px; padding:3px 12px; font-size:12px; letter-spacing:.5px; }
.hero h1 { margin: 12px 0 6px; font-size: 26px; }
.hero p { color: var(--muted); margin: 0; font-size: 14px; }
.card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin:16px 0; }
.card.feature { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.card h2 { margin:0 0 4px; font-size:17px; display:flex; align-items:center; gap:8px; }
.card .sub { color:var(--muted); font-size:12px; margin:0 0 10px; }
ul { margin:0; padding-left:18px; }
li { margin:6px 0; line-height:1.5; }
li strong { color: var(--fg); }
.emoji { font-size:19px; }
code { background: rgba(127,127,127,0.18); padding:1px 5px; border-radius:4px; font-size:12px; }
.hint { text-align:center; color:var(--muted); font-size:12px; margin:14px 0 26px; }
</style>
</head>
<body>
<div class="topbar">
    <button class="navbtn" id="prev" title="Previous version">&lsaquo;</button>
    <div class="dots" id="dots"></div>
    <button class="navbtn" id="next" title="Next version">&rsaquo;</button>
</div>
<div class="viewport">
    <div class="track" id="track">

        <!-- SLIDE 0 -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.1.0</span>
                    <h1>PAW-Style Data Modeling</h1>
                    <p>A full Data Model Explorer with a Subset Editor and a Cube Viewer — right inside VS Code.</p>
                </div>
                <div class="card">
                    <h2><span class="emoji">🌳</span> Data Model Explorer</h2>
                    <p class="sub">Navigate your TM1 model the way you know it</p>
                    <ul>
                        <li><strong>Standard TM1 layout</strong> per instance: Cubes, Dimensions, Processes, Chores and Control Objects.</li>
                        <li><strong>Expandable cubes</strong> reveal their Dimensions, Views and Rules.</li>
                        <li><strong>One click</strong> on a dimension, hierarchy or subset opens the Subset Editor; a view opens the Cube Viewer.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🧮</span> Subset / Dimension Editor</h2>
                    <p class="sub">A PAW-style two-column editor</p>
                    <ul>
                        <li><strong>Available members</strong> and <strong>Current set</strong> as full hierarchy trees with expand/collapse, virtualized for very large dimensions.</li>
                        <li><strong>Transfer &amp; select</strong> with drag &amp; drop, Ctrl/Shift multi-select, and add/keep/remove actions.</li>
                        <li><strong>Aliases, attributes and filters</strong> (Name / Level / attribute values) with an editable <strong>MDX engine</strong>.</li>
                        <li><strong>Save</strong> as a static or dynamic (MDX) subset — Public or Private — or push straight into a Cube Viewer axis with <em>Use in Cube View</em>.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">📊</span> Cube Viewer</h2>
                    <p class="sub">A pivot grid with data entry</p>
                    <ul>
                        <li><strong>Pivot &amp; nest</strong> dimensions across Context, Rows and Columns with drag &amp; drop; nested headers merge repeated parent labels.</li>
                        <li><strong>Drill down</strong> consolidations, toggle <strong>zero suppression</strong>, and see <strong>aliases</strong> in headers.</li>
                        <li><strong>Data entry / writeback</strong> straight to TM1; rule-calculated cells are highlighted and read-only.</li>
                        <li><strong>Save &amp; open views</strong> on the server, and inspect the generated <strong>MDX</strong> anytime.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 1 -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.2.0</span>
                    <h1>New Connection Methods</h1>
                    <p>Sign in to Planning Analytics Workspace and to Windows-integrated TM1 servers.</p>
                </div>
                <div class="card">
                    <h2><span class="emoji">🔐</span> OAuth 2.0 for Planning Analytics Workspace</h2>
                    <p class="sub">Connect to PAW and its PAW-routed TM1 databases</p>
                    <ul>
                        <li><strong>Browser sign-in</strong> via the OAuth Authorization Code flow — the token is received on a local loopback callback.</li>
                        <li><strong>Configure once</strong> in the environment dialog: PAW Base URL, Client ID, Client Secret, Callback Port (with a ready-to-register callback URL) and an optional TM1 database.</li>
                        <li><strong>Secret kept safe</strong> in VS Code SecretStorage — never in the project file.</li>
                        <li><strong>Cached &amp; silently refreshed tokens</strong> mean you rarely sign in again, even after a restart. Reset them with <code>PA Code: Clear Stored OAuth Credentials</code>.</li>
                        <li><strong>Database discovery</strong>: if no database is set, pa-code lists the available TM1 servers and lets you pick one.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🪟</span> Windows Integrated Login (Security Mode 3)</h2>
                    <p class="sub">For TM1 servers running IntegratedSecurityMode 3</p>
                    <ul>
                        <li>Sign in with your <strong>Windows / AD credentials</strong> (e.g. <code>user@domain</code>), sent via Basic auth with no CAM namespace.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 2 -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.3.0</span>
                    <h1>Productivity, Safety &amp; UX</h1>
                    <p>Collaborative, conflict-safe editing plus a batch of workflow and UI improvements.</p>
                </div>
                <div class="card">
                    <h2><span class="emoji">🛡️</span> Two-way conflict protection</h2>
                    <p class="sub">Never lose server-side or local changes again</p>
                    <ul>
                        <li><strong>Safe save</strong>: if a process/rule changed on the server since you opened it, you get <em>Overwrite Server / Show Diff / Cancel</em> instead of a silent overwrite.</li>
                        <li><strong>Safe pull</strong>: locally-changed files are kept, not overwritten — pa-code reports them and lets you take the server version on demand.</li>
                        <li><strong>Offline protection</strong> toggle per file (<code>O</code> badge) — excluded from Pull.</li>
                        <li><strong>Consistent conflict dialogs</strong> everywhere (clear title, detail line, safe → compare → destructive buttons).</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">✍️</span> Process editing</h2>
                    <ul>
                        <li><strong>Permanent open</strong> (no preview tab), plus <strong>Delete</strong> and <strong>Rename</strong> a process from the tree.</li>
                        <li><strong>Code folding</strong> for <code>.ti</code>: #SECTION tabs, #JSON_PROPERTIES, #Region/#EndRegion and generated #****Begin/End blocks.</li>
                        <li><strong>Pretty SQL</strong>: the ODBC query is a multi-line editor with a <em>Format SQL</em> button.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🔌</span> Offline / manual-publish workflow</h2>
                    <ul>
                        <li><strong>Auto-Push toggle</strong> in the status bar: turn off pushing on save to edit offline and commit to git…</li>
                        <li>…then <strong>Publish Changed Files</strong> pushes everything at once, with the same conflict guard.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🚚</span> Deployment Assistant</h2>
                    <ul>
                        <li><strong>Multi-select</strong> browser (checkbox list + filter + Select All) to add many objects at once.</li>
                        <li><strong>Load from Log</strong>: reuse a previous deployment set to re-deploy or promote it.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">⚙️</span> Environment &amp; tree</h2>
                    <ul>
                        <li><strong>Test Connection</strong> button and a per-environment <strong>Request Timeout</strong> for slow servers, in a modernized dialog.</li>
                        <li><strong>Control Objects search</strong> works again in every category; <strong>Pull always includes control objects</strong>; MDX Wizard View Builder fixed.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 3 (headline: MCP) -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.4.0 · HEADLINE</span>
                    <h1>🤖 Built-in MCP Server</h1>
                    <p>Give AI agents live, structured context about your TM1 model — natively, from the extension.</p>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">✨</span> A real Model Context Protocol server</h2>
                    <p class="sub">Fully integrated — no separate install, no subprocess, no extra config</p>
                    <ul>
                        <li>pa-code now <strong>registers a real MCP server directly with VS Code</strong>. It runs <strong>in-process</strong> and <strong>reuses your live, authenticated TM1 connection</strong> (Basic / CAM / OAuth) — so there is no second connection layer and no duplicated credentials.</li>
                        <li><strong>Why it matters:</strong> it gives the VS Code Copilot agent — and any MCP-compatible client such as Claude Desktop — <strong>live context about your model</strong> (cubes, dimensions, processes, rules), so the AI truly understands your TM1 database before it helps you read, explain or change code.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🧰</span> 23 read-only tools</h2>
                    <p class="sub">The agent can inspect and analyze your model on its own</p>
                    <ul>
                        <li><strong>Discover &amp; inspect</strong>: list cubes, dimensions, processes, hierarchies, views, subsets; get process code &amp; parameters, cube rules, cube dimensions, dimension elements, server info.</li>
                        <li><strong>Analyze</strong>: regex-search across all TI code, find where a cube/dimension is used, search elements, sample cube members, read a view's data, run read-only MDX.</li>
                        <li><strong>Operate (read)</strong>: list threads, message log, chores, and the latest error log of a failed process — great for debugging with the agent.</li>
                        <li><strong>Strictly read-only</strong>: the AI never mutates your model. Writing back stays your deliberate pull/push.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">📎</span> Resources &amp; <span class="emoji">💬</span> Prompts</h2>
                    <ul>
                        <li><strong>Resources</strong> (<code>tm1://…</code>) bring live content into a chat prompt — a process' code, a cube's rules or dimensions, server info — with templates and name auto-completion. Attach them with <code>#</code>.</li>
                        <li><strong>Prompts</strong> pull the right context automatically: <em>Explain TI Process</em>, <em>Review Cube Rules</em>, <em>Impact Analysis</em>.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🔒</span> Secure &amp; how to use it</h2>
                    <ul>
                        <li><strong>Secure by design</strong>: loopback-only, a per-session bearer token on every request, DNS-rebinding protection, capped payloads — and read-only.</li>
                        <li><strong>Use it</strong>: open Copilot Chat in <strong>Agent mode</strong> → the TM1 tools appear automatically (or via the Tools picker). Reference resources with <code>#</code> and run prompts as <code>/mcp…</code> commands. Toggle everything with <code>pa-code.mcpServer.enabled</code>.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 4 (headline: 3.5.0 Lineage) -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.5.0 · HEADLINE</span>
                    <h1>🔗 Lineage, Fixes &amp; Improvements</h1>
                    <p>A new dependency Lineage view — plus a wave of bug fixes and improvements across the editors, search and IntelliSense.</p>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">🌐</span> Process &amp; Rule Lineage <span class="emoji">✨</span></h2>
                    <p class="sub">Right-click a process or cube → <em>Show Lineage</em> (or the Command Palette)</p>
                    <ul>
                        <li><strong>Process call tree</strong>: recursively follows <code>ExecuteProcess</code>/<code>RunProcess</code> to any depth (resolving literal names and simple variables); processes missing on the server are flagged red.</li>
                        <li><strong>Cube rule lineage</strong>: the cubes a cube reads via <code>DB</code>/<code>CellValueN/S</code> (blue), <code>ATTRS</code>/<code>ATTRN</code> dimensions (orange), cubes that <strong>feed into</strong> it (green) and cubes <strong>it feeds</strong> (purple). Draws instantly; the feed-in scan runs after and is cached.</li>
                        <li><strong>Interactive</strong>: click any box to re-root, with <strong>Back / Forward</strong> history; each lineage opens in its own tab.</li>
                        <li><strong>Run analysis from <code>tm1server.log</code></strong>: pick a look-back window and, for a chosen run, see how often each process ran, its average/total runtime and where it errored — read from the log (<strong>English &amp; German</strong>, chore-triggered runs too).</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🚀</span> New features</h2>
                    <ul>
                        <li><strong>Rules IntelliSense</strong>: signature help, function hover, and cube / element / attribute pickers inside <code>DB</code>/<code>CellValue</code> and left-side <code>[ … ]</code> rule areas.</li>
                        <li><strong>Set Editor</strong>: a <strong>searchable</strong> attribute-column picker and a PAW-style <strong>⚖ Weights</strong> column for consolidation weights.</li>
                        <li><strong>Cube Viewer</strong>: edit the MDX directly, a <strong>📂 Views</strong> picker inside the viewer, and <strong>Overwrite-on-save</strong> for views.</li>
                        <li><strong>Search Views &amp; Subsets</strong> in the tree.</li>
                        <li><strong>Connections stored in VS Code</strong> by default (per-connection <em>workspace</em> or <em>global</em> scope), with a configurable location for a legacy <code>tm1-project.json</code>.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🛠️</span> Improvements</h2>
                    <ul>
                        <li><strong>Cube Viewer</strong>: MDX <strong>Format / Minify</strong> (now in the Set Editor too), and <strong>Apply edited MDX in place</strong> — even when dimensions move between Rows, Columns and Context.</li>
                        <li><strong>Deployment Assistant</strong>: the <strong>Source</strong> instance is hidden from the <strong>Target</strong> list, plus a <strong>Refresh Connections</strong> button.</li>
                        <li><strong>Cube name in view tabs</strong>, live instance-level <strong>search</strong> (no Enter to confirm), and consistent <strong>accordion</strong> styling.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🐞</span> Bug fixes</h2>
                    <ul>
                        <li><strong>No more false “changed on the server” conflicts</strong> when saving a process — TM1's hidden, auto-generated Variables are no longer treated as changes.</li>
                        <li><strong>Process variables you add via JSON Properties now appear in PAW</strong> (and no longer trigger a false “variable already exists”), thanks to writing them in the canonical shape PAW expects.</li>
                        <li><strong>Complete IBM 2.0/2.1 function coverage</strong>: 233 functions now highlighted and 132 added to IntelliSense (fixes <code>DTYPE</code>, <code>ViewExtractSkipConsolidatedStringsSet</code>…).</li>
                        <li><strong>Removed the dead clear-search icon</strong> at instance level (connected instances no longer show a second, do-nothing <code>X</code>).</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 5 (headline: 3.6.0) -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.6.0 · HEADLINE</span>
                    <h1>✍️ MDX Editor, Viewer upgrades &amp; more</h1>
                    <p>A big release: a full MDX Editor with an embedded Wizard, major Cube Viewer &amp; Subset Editor upgrades, per-environment local storage, and a rebuilt Server Log.</p>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">✍️</span> MDX Editor <span class="emoji">✨</span></h2>
                    <p class="sub">In both the Cube Viewer and the Subset Editor — open it with the <strong>MDX</strong> button</p>
                    <ul>
                        <li><strong>Split-view editor docked beside the grid</strong> (no more modal): pretty-printed by default, resizable, with a <strong>Live</strong> toggle, <strong>Undo / Redo</strong>, and <strong>Apply / Format / Minify / Copy / Save as View</strong>.</li>
                        <li><strong>Searchable, collapsible Functions List</strong> (Logical, Member, Numeric, Set, Property, String, Miscellaneous, TM1) and ready-made <strong>Examples</strong> — click to insert at the cursor.</li>
                        <li><strong>🔧 Wizard toggle</strong> expands a visual builder (View Builder in the Cube Viewer, Subset Builder in the Subset Editor) that writes into the <strong>same MDX field</strong>, <strong>reconstructed from your current view</strong>, with changes flowing to the grid live. <strong>Reset</strong>, a <strong>Control objects</strong> filter and a capped <strong>Level</strong> input included.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">📊</span> Cube Viewer &amp; Subset Editor</h2>
                    <ul>
                        <li><strong>Keep / hide elements in the grid</strong> (PAW-style): <strong>double-click</strong> to keep only an element, or <strong>right-click</strong> a header for <em>Keep only</em>, <em>Hide</em>, <em>Drill down / up</em>, and <em>Edit subset in Subset Editor</em> — kept <strong>in sync</strong> with the Subset Editor.</li>
                        <li><strong>Correct layout for empty views</strong>: the Cube Viewer reads the native view definition, so empty / zero-suppressed views keep their real row/column dimensions and subsets instead of collapsing into Context.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">💾</span> Local Storage</h2>
                    <ul>
                        <li><strong>Per-environment file storage</strong> — set in <strong>Settings → Environments</strong> (and shown in the overview table).</li>
                        <li><strong>Browse-only mode</strong> (storage off): open processes/rules with <strong>no files or folders created</strong> — the tab shows the object name, with syntax highlighting, and <strong>Ctrl+S pushes straight to the server</strong>. Keep a repo Dev-only while Test/Prod stay connected.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">📜</span> Server Log</h2>
                    <ul>
                        <li>A <strong>rebuilt log viewer</strong>: full-text <strong>search</strong>, <strong>Level</strong> &amp; <strong>Logger</strong> filters, a <strong>time range</strong>, <strong>live tail</strong>, <strong>Load older</strong>, <strong>Export</strong>, plus a <strong>Thread</strong> column and readable timestamps.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🛠️</span> Fixes &amp; improvements</h2>
                    <ul>
                        <li><strong>Disconnect closes the instance's tabs</strong> instead of leaving "not connected" panels.</li>
                        <li><strong>Bulk Delete</strong> now covers <strong>Chores, Cubes and Dimensions</strong> (with confirmation) and a Control-objects filter.</li>
                        <li>Clearing Rows or Columns no longer fails with <em>"Sequence gap in selection axes"</em>.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 6 (headline: 3.7.0) -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.7.0 · HEADLINE</span>
                    <h1>🤖 AI model building &amp; admin power tools</h1>
                    <p>Let an AI agent build a whole TM1 model through the MCP server — plus Arc-style power tools: a TI console, user impersonation, and a pre-save rule syntax check. Now with a Git-friendly workflow and connection help.</p>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">🤖</span> MCP Server — write / model-building tools</h2>
                    <p class="sub">Enable with the setting <code>pa-code.mcpServer.mode</code> = <strong>readwrite</strong> (read-only stays the default)</p>
                    <ul>
                        <li>The built-in MCP server can now <strong>create and manipulate TM1 objects</strong> — dimensions, hierarchies, elements, consolidations, cubes, rules, TI processes, views, subsets, chores, security — so an <strong>AI agent can build an entire model</strong> (e.g. from a spreadsheet), not just read it.</li>
                        <li><strong>Safe by design</strong>: write tools appear only in read/write mode, and destructive actions (deletes, cell writes, rule replacement, process/chore execution) require a <strong>confirm</strong> argument that repeats the target name.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">⌨️</span> TI Console (one-liner)</h2>
                    <ul>
                        <li>Run a <strong>single TI statement</strong> — e.g. <code>CubeProcessFeeders('Balancesheet');</code> — without creating a process. pa-code makes a temporary process, runs it and deletes it. Open from <strong>Quick Actions</strong>, the instance right-click menu, or the terminal icon; press <code>Ctrl+Enter</code> to run.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">👤</span> Impersonation — view TM1 as another user</h2>
                    <ul>
                        <li><strong>See the model exactly as a user does</strong> — their cubes, cell contents, elements and rights. pa-code opens a real <strong>impersonated session</strong>, so the server applies that user's security. A <strong>status-bar badge</strong> shows who you're impersonating; <strong>Stop Impersonating</strong> switches back. In <strong>Quick Actions</strong> and the instance menu. (TM1 v11, Basic/API-key connections.)</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">✅</span> Rule syntax check before saving</h2>
                    <ul>
                        <li><strong>Check Rule Syntax</strong> validates your <code>.rux</code> rules <strong>without saving and without re-feeding</strong> the real cube — it compiles them on an empty throwaway cube and reports errors inline. So you save the real cube only once, with correct rules. Button in the rule editor toolbar (or right-click / command palette).</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🔀</span> Git-friendly workflow</h2>
                    <ul>
                        <li><strong>Per-environment “Pull on connect”</strong> (Settings → Environments): <strong>Ask</strong> (default), <strong>Always</strong>, or <strong>Never</strong> — so if your files come from Git you can stop the server version being pulled over your branch.</li>
                        <li><strong>No more phantom Git changes</strong>: opening a process/rule no longer flips line endings or triggers a false <em>“changed on the server”</em> prompt. Files are written LF-only and left untouched when unchanged, so Source Control stays clean until you actually edit something.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🔌</span> Connection help</h2>
                    <ul>
                        <li><strong>New “Connection examples” helper</strong> in the Settings dialog: ready-to-copy setups for on-prem v11, PA on Cloud, <strong>PA as a Service (v12) with an API key</strong>, and PAW OAuth — including the exact v12 URL shape (<code>…/api/&lt;tenant&gt;/v0/tm1/&lt;database&gt;</code>) and the common 401 causes.</li>
                    </ul>
                </div>
            </div>
        </section>

        <!-- SLIDE 7 (headline: 3.7.5) -->
        <section class="slide">
            <div class="wrap">
                <div class="hero">
                    <span class="pill">VERSION 3.8.0 · HEADLINE</span>
                    <h1>🎉 Open source & more delightful</h1>
                    <p>PA Code is now open source under the Apache License 2.0 — plus little moments of joy (celebrate successful runs) and a batch of feedback fixes for the TI Console, rule check and lineage.</p>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">�</span> Now open source (Apache-2.0)</h2>
                    <p class="sub">A community project you and your company can review, adopt and contribute to</p>
                    <ul>
                        <li>PA Code is now developed in the open under the <strong>Apache License 2.0</strong> — permissive, enterprise-friendly, with an explicit patent grant.</li>
                        <li>Contributions are welcome — see <code>CONTRIBUTING.md</code> (lightweight DCO sign-off). Companies can freely review the code for security.</li>
                    </ul>
                </div>
                <div class="card feature">
                    <h2><span class="emoji">�🎈</span> Celebrate a successful process</h2>
                    <p class="sub">Inspired by Streamlit's <code>st.balloons</code> — opt-in via <code>pa-code.delight.celebrateProcessSuccess</code></p>
                    <ul>
                        <li>When a TI process finishes successfully, a short <strong>animated toast</strong> plays and then leaves a <strong>persistent</strong> success message.</li>
                        <li>Pick the style with <code>pa-code.delight.celebrationStyle</code>: <strong>balloons</strong> (rising balloons), <strong>fireworks</strong> (rockets → burst), or <strong>panel</strong> (a floating balloons webview).</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">✨</span> Everyday delight (on by default)</h2>
                    <ul>
                        <li><strong>Fun success messages</strong> — a random cheerful phrase (“🎯 Nailed it!”, “🔥 Crushed it!”) instead of the plain text.</li>
                        <li><strong>Daily greeting</strong> — a time-of-day welcome the first time you connect each day.</li>
                        <li><strong>Progress personality</strong> — playful text during <strong>Pull All</strong>. Each is individually toggleable under <code>pa-code.delight.*</code>.</li>
                    </ul>
                </div>
                <div class="card">
                    <h2><span class="emoji">🛠️</span> Feedback fixes</h2>
                    <ul>
                        <li><strong>Rule check</strong> no longer fails with <em>“Could not find one or more dimensions”</em> for cubes whose dimension names contain spaces.</li>
                        <li><strong>TI Console autocomplete wraps around</strong> — ↑ on the first entry jumps to the last, and ↓ on the last back to the first.</li>
                        <li><strong>Lineage</strong> shows a <strong>breadcrumb trail</strong> and supports <strong>Alt+← / Alt+→</strong>, so you can always step back from a dead-end object.</li>
                    </ul>
                </div>
            </div>
        </section>

    </div>
</div>
<div class="hint">Use ‹ / › or your arrow keys to browse between versions · Reopen anytime via <code>PA Code: What's New</code></div>

<script>
(function(){
    var track = document.getElementById('track');
    var count = track.children.length;
    var idx = count - 1; // start on the newest version (the headline release)
    var prev = document.getElementById('prev');
    var next = document.getElementById('next');
    var dotsWrap = document.getElementById('dots');
    var dots = [];
    for (var i = 0; i < count; i++) {
        var d = document.createElement('button');
        d.className = 'dot';
        (function(n){ d.addEventListener('click', function(){ go(n); }); })(i);
        dotsWrap.appendChild(d);
        dots.push(d);
    }
    function render(){
        track.style.transform = 'translateX(' + (-idx * 100) + '%)';
        prev.disabled = idx === 0;
        next.disabled = idx === count - 1;
        for (var i = 0; i < dots.length; i++) { dots[i].className = 'dot' + (i === idx ? ' active' : ''); }
    }
    function go(i){ idx = Math.max(0, Math.min(count - 1, i)); render(); }
    prev.addEventListener('click', function(){ go(idx - 1); });
    next.addEventListener('click', function(){ go(idx + 1); });
    document.addEventListener('keydown', function(e){
        if (e.key === 'ArrowLeft') { go(idx - 1); }
        else if (e.key === 'ArrowRight') { go(idx + 1); }
    });
    render();
})();
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

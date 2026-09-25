# Change Log

All notable changes to the "pa-code" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [3.8.0] - 2026-09-24

**First open-source release** — PA Code is now developed in the open under the Apache License 2.0. 🎉

### Delightful UX (opt-in)
- **Celebrate a successful process** 🎈 (inspired by Streamlit's `st.balloons`): when a TI process finishes successfully, a short animated toast plays and then leaves a **persistent** success message (`🎉 Success! ‘Process’ · time`) that stays readable. **Off by default** — enable with **`pa-code.delight.celebrateProcessSuccess`**; choose the style with **`pa-code.delight.celebrationStyle`**: `balloons` (rising balloons), `fireworks` (rockets → burst), or `panel` (a floating balloons webview).
- **Fun success messages** (`pa-code.delight.funMessages`, **on by default**): a random cheerful phrase — “🎯 Nailed it!”, “✨ Clean run!”, “🔥 Crushed it!” … — instead of the standard success text.
- **Daily greeting** (`pa-code.delight.dailyGreeting`, **on by default**): a short, time-of-day welcome (“☀️ Good morning! …”) the first time you connect to a server each day.
- **Progress personality** (`pa-code.delight.progressPersonality`, **on by default**): playful progress text during **Pull All** (e.g. “Fetching your processes… 🧰”). All delight features remain individually toggleable.

### Fixes
- **Rule syntax check no longer fails with “Could not find one or more dimensions”**: the throwaway validation cube bound its dimensions with percent-encoded names, so any dimension containing a space (or other special character) wasn't found. The names are now passed raw (quotes doubled), so the check works for all cubes. *(Also fixes cube creation via the MCP write tools for such dimensions.)*
- **TI Console autocomplete wraps around**: pressing ↑ on the first suggestion now jumps to the last (and ↓ on the last back to the first).

### Lineage
- **Easier back-navigation**: the lineage now shows a **breadcrumb trail** of the cubes/processes you've visited (current one highlighted) and supports **Alt+← / Alt+→** to step back/forward — so you can always return from a dead-end object.

### Project
- **PA Code 3.8.0 is the first open-source release**, under the **Apache License 2.0** — a permissive, enterprise-friendly license with an explicit patent grant, so companies can review and adopt it freely and the community can contribute. Added `LICENSE`, `NOTICE` and `CONTRIBUTING.md` (with a lightweight DCO sign-off).

## [3.7.4] - 2026-09-23

A batch of feedback-driven improvements across the Server Log, TI Console, Impersonation, Connection editor, Cube Viewer and authentication, plus a private-views fix.

### Server Log
- **“Fatal” log level added** to the level filter (was missing; PAW shows it too).
- **Multi-select logger filter with search**: pick several loggers at once and type to filter the logger list — instead of a single dropdown.
- **Smarter export filename**: exported logs are named with a timestamp and, if you filtered by logger(s), those logger names — e.g. `Server_messagelog_20260921_143000_TM1.Process.log`.

### TI Console
- **Keyboard shortcut** to open the TI Console: `Ctrl+Alt+C` (`Cmd+Option+C` on macOS).
- **Autocomplete for TI functions** in the console input — start typing a function name, browse with ↑/↓ and accept with Enter/Tab, with the function signature and description shown as parameter help.

### Impersonation
- **Grouped into an “Impersonate” submenu** on the connected instance (Activate / Deactivate) instead of two separate entries.
- **Searchable user picker**: choose the user to impersonate from a searchable list loaded from the model (avoids typos); manual entry is still available.
- **Clearer admin error**: impersonating an administrator now explains the TM1 restriction (members of the ADMIN group can't be impersonated — 403) instead of a generic message.

### Connection editor
- **Field-accurate required-field validation**: the error names the exact field(s) that are empty (e.g. *Name*, *Local Workspace Folder*, *Host*, *Port*), highlights each in red and scrolls to the first.
- **Required fields are marked** with a red asterisk that adapts to the chosen Connection Type and Auth method.
- **Connection examples adapt to the selected Connection Type / Auth** — you now see only the relevant example (Admin Server, Single Instance, PA on Cloud, PA as a Service v12, or PAW OAuth) instead of the full list.
- **Half-filled connections survive losing focus**: the settings panel keeps its state when you click into another window, so a new connection you were filling in isn't reset.

### Cube Viewer
- **Export to CSV**: a new **⭳ Export** button writes the current grid (with nested row/column headers) to a CSV file — named after the cube/view plus a timestamp and UTF-8-BOM encoded so Excel shows special characters correctly.
- **Clean export values**: expand/collapse arrows on consolidated members are dropped, accounting negatives shown as `(51,324)` become `-51324`, and thousands separators are removed (`660,104,426` → `660104426`); decimals and `%` are kept.

### Authentication
- **Private/incognito browser option for CAM Browser SSO** (`pa-code.auth.privateBrowserWindow`): open the login browser in a private window (Chrome `--incognito` / Edge `--inprivate`) to bypass an existing SSO session and sign in as a different account — e.g. an admin on a production instance.

### Fixes
- **Private views are now shown**: the cube's Views node listed only public views because pa-code only queried the `/Views` collection. It now also reads `/PrivateViews`, so your private views appear (marked with a lock icon and a “private” label) and open like any other view.

## [3.7.2] - 2026-09-17

### Deployment Assistant — paste a list of objects
- **New “Paste List” in Step 2**: paste a list of process/rule names (one per line, e.g. copied from Notepad) and pa-code selects them all at once — no need to search and click each object. The type (TI Process / Rule) is detected automatically by matching against the source instance; surrounding quotes and a trailing `.ti`/`.rux` extension are tolerated, and duplicates are ignored.
- **Clear feedback**: after importing you get a summary — how many were added, how many were already in the list, and an explicit, scrollable list of any names that **could not be found** on the source instance.

## [3.7.1] - 2026-09-16

### Git workflow reliability
- **Pull/open compare processes & rules by content, not raw text**: line endings, trailing whitespace and TM1's volatile server-managed `Variables` (and JSON key order/formatting) are ignored, so objects pulled from Git are no longer wrongly reported as “local changes”.
- **Pull All no longer rewrites unchanged files**: an existing file that already matches the server is left untouched, so Pull doesn't fill Source Control with thousands of invisible (line-ending-only) changes. Only new or genuinely different files are written.
- **Processes containing literal `#SECTION`/`#JSON_PROPERTIES` are no longer stuck as “changed on the server”**: the compare now runs the server version through the same build→parse path as the local file, so generator/WebUpload processes that embed those markers compare equal (and *Overwrite Local* actually converges instead of re-flagging on every pull).

## [3.7.0] - 2026-09-14

A big release focused on **AI-driven model building** and **admin/testing power tools**, plus **connection help** and **Git-friendly workflow fixes**.

### MCP Server — write / model-building tools
- **The built-in MCP server can now create and manipulate TM1 objects**, so an AI agent can build a full model (dimensions, hierarchies, elements, consolidations, cubes, rules, TI processes, views, subsets, chores) — e.g. from a spreadsheet — not just read it.
- **New setting `pa-code.mcpServer.mode`** = `readonly` (default) | `readwrite`. Write tools are only exposed in read/write mode; read-only stays the safe default.
- **New write tools**: `tm1_create_dimension` / `tm1_create_hierarchy` / `tm1_add_elements` / `tm1_add_edges` / `tm1_update_element_attributes` / `tm1_delete_element` / `tm1_delete_dimension`; `tm1_create_cube` / `tm1_delete_cube` / `tm1_set_cube_rules`; `tm1_write_cell` / `tm1_write_cells`; `tm1_create_process` / `tm1_update_process` / `tm1_delete_process` / `tm1_execute_process`; `tm1_create_view` / `tm1_delete_view`; `tm1_create_subset` / `tm1_delete_subset`; `tm1_create_chore` / `tm1_update_chore` / `tm1_activate_chore` / `tm1_execute_chore` / `tm1_delete_chore`; `tm1_create_user` / `tm1_delete_user` / `tm1_create_group` / `tm1_delete_group` / `tm1_add_user_to_group` / `tm1_update_config_parameter`.
- **Safety**: destructive/irreversible tools (all deletes, cell writes, rule replacement, process/chore execution, config changes) require a `confirm` argument that repeats the target name. `tm1_execute_process` reports a real `outcome` (succeeded / completed_with_errors / rolled_back) since TM1 answers HTTP 200 regardless.

### TI Console (one-liner)
- **New TI Console** (Arc-style): run a single TurboIntegrator statement — e.g. `CubeProcessFeeders('Balancesheet');` — without creating a process. pa-code creates a temporary process behind the scenes, compiles and runs it, then deletes it. Open it from the **terminal icon** / right-click on a connected instance, from **Quick Actions**, or via **PA Code: Open TI Console**. Run with `Ctrl+Enter`; syntax and execution errors (including the TM1 error log) are shown inline.

### Impersonation — view TM1 as another user (v11)
- **New Impersonate User** (Arc-style): enter a user name and see the model exactly as that user does — cubes, cell contents, elements, private views/subsets and rights. pa-code opens a **new impersonated session** (re-authenticating with the connection's credentials plus the `TM1-Impersonate` header), so the server truly applies that user's security. A **status-bar badge** shows who you're impersonating; **Stop Impersonating** re-authenticates back to your own admin session. Available in **Quick Actions**, the connected-instance right-click menu, and the command palette. Requires a Basic/native or API-key connection; not supported on v12 / Planning Analytics as a Service.

### Rule syntax check before saving
- **New Check Rule Syntax** (`.rux` editor toolbar, right-click, or command palette): validates the current rule text **without saving and without re-feeding** the real cube. pa-code compiles the rules on a throwaway cube with the same dimensions (empty → instant), reports any errors inline as diagnostics, then deletes it — so you save the real cube only once, with correct rules, avoiding an extra feeder run.

### Quick Actions
- Added **TI Console**, **Impersonate User** and (while active) **Stop Impersonating** to the Quick Actions panel.

### Per-environment “Pull on connect” mode
- **New per-environment setting “Pull from Server on connect”** (Settings → Environments): **Ask** (default), **Always** (pull all processes/rules automatically, no prompt), or **Never** (skip it). Handy when your files come from Git (e.g. the dev branch) and you don't want the server version pulled over them, or when you always want a fresh pull without being asked.

### Git workflow fixes (line endings)
- **No more phantom “changed on the server” prompt on open**: files checked out from Git (which stores them as LF) are no longer flagged as “local changes” against the server's CRLF version. The sync baseline now compares content independent of line-ending style, so you don't have to click *Overwrite Local* after a Git pull.
- **No more spurious “M” (Modified) in Source Control just from opening a process/rule**: opening no longer rewrites the file with the server's CRLF line endings. Files are written LF-only (matching `.gitattributes eol=lf`), and an unchanged file is left untouched on disk — so Source Control stays clean until you actually edit something.
- **No confusing “all objects have local changes” message on the first pull** after the line-ending fix: a file now counts as “locally changed” only when it differs from **both** the server version **and** the last-sync baseline, so files that merely had an outdated baseline hash are pulled silently instead of being flagged as conflicts.
- **Pull/open now compare processes by content, not raw text**: line endings, trailing whitespace and TM1's volatile server-managed `Variables` (and JSON key order/formatting) are ignored, so processes pulled from Git are no longer wrongly reported as “local changes” just because TM1 reformatted their properties.
- **Pull All no longer rewrites unchanged files**: an existing file that already matches the server (canonically) is left untouched instead of being re-written, so Pull doesn't fill Source Control with thousands of invisible (line-ending-only) changes. Only new or genuinely different files are written.
- **Processes containing literal `#SECTION`/`#JSON_PROPERTIES` are no longer stuck as “changed on the server”**: the content compare now runs the server version through the same build→parse path as the local file, so generator/WebUpload processes that embed those markers compare equal (and *Overwrite Local* now actually converges instead of re-flagging on every pull).

### Connection help
- **New “Connection examples” helper in the Settings dialog**: ready-to-copy setups for on-prem v11 (Admin Server / Single Instance), PA on Cloud, **PA as a Service (v12) with an API key**, and PAW OAuth — including the exact v12 REST URL shape (`…/api/<tenant>/v0/tm1/<database>`) and a note that the API-key username is `apikey`. Added a hint on the **API Key / Token** auth method and a reminder of the common 401 causes (choosing CAM instead of API Key, or omitting the `/v0/tm1/<database>` URL tail).

## [3.6.6] - 2026-09-11

### Server Log
- **Live auto-refresh is on by default** (every 5s), now controlled by a clear **Live** checkbox instead of a button.
- **Log levels moved into a compact multi-select dropdown** (Info / Warn / Error / Debug) instead of separate checkboxes side by side, saving toolbar space.

### Subset Editor
- **Compact MDX for whole-hierarchy subsets**: opening a subset that covers every member now shows `{[Dim].[Hier].Members}` instead of listing each element, so it's readable and editable. A genuine partial selection still lists its members.

### MDX Wizard
- **Searchable cube dropdown**: the cube-name fields (sorting, top/bottom, cube-value filters) now suggest the connected model's cubes as you type.
- **Valid MDX from the function list**: the TM1 set functions (`TM1SubsetAll`, `TM1SubsetToSet`) now insert brace-wrapped MDX, e.g. `{TM1SubsetAll([Dimension])}`.
- **Clearer engine error** when MDX is invalid, hinting at the correct set syntax.

## [3.6.5] - 2026-09-11

### Fixes
- **Subset Editor – reopening a dynamic (MDX) subset now shows its MDX expression**: TM1 returns both the stored expression and its resolved elements for a dynamic subset, and the editor was showing the resolved element list. It now prefers the MDX expression, opens the MDX editor, and resolves the members from it — so a subset saved as `FILTER(TM1FILTERBYLEVEL(...))` reopens with that definition intact. Completes the dynamic-MDX subset fix started in 3.6.4.

## [3.6.4] - 2026-09-09

### Fixes
- **Process Properties – adding a parameter/variable no longer discards unsaved renames**: typing new names into the Parameters/Variables rows and then adding another row previously reset every row back to `pNew`/`vNew`. The current edits are now captured before the list re-renders, so existing rows keep their names and types.
- **Subset Editor – “Save as dynamic (MDX) subset” now stores the actual MDX**: when the MDX editor is open, saving a dynamic subset keeps the real expression shown in the editor (e.g. `FILTER(TM1FILTERBYLEVEL(...))`) instead of the resolved element list.

## [3.6.3] - 2026-09-03

### Cube Viewer & Subset Editor
- **Subset Editor closes itself after "Use in Cube View"**: once you send a set back to the Cube Viewer, the Subset Editor tab now closes automatically instead of piling up open tabs.
- **Expand a consolidated member directly in the context selector**: when a consolidated (C) element is selected in a Cube Viewer context (title) dimension, a small expand toggle now lists its children right in the dropdown — so you can drill into it without opening the Subset Editor. Toggle again to collapse.

## [3.6.2] - 2026-09-03

### Security
- **Content-Security-Policy added to all webview panels**: every panel now ships a CSP that blocks loading external scripts, styles, images and fonts and forbids any network connection out of the webview (`default-src 'none'`). This is a defense-in-depth layer on top of the existing HTML-escaping of server data. No visible change and no functional impact — all panels and controls behave exactly as before.

## [3.6.1] - 2026-09-03

### Security
- **Dependency security patches**: updated shipped runtime dependencies to clear all reachable `npm audit` findings (`undici`, `ws`, `form-data`, `ip-address`, `follow-redirects`, `uuid`). No functional changes.
- Documented dependency-security posture in `SECURITY.md`, including one transitive advisory (`extract-zip` via `puppeteer-core`/`@puppeteer/browsers`) whose vulnerable code path (downloading/extracting a bundled browser) is **never executed** — PA-Code only automates the already-installed system browser.

## [3.6.0] - 2026-08-27

A large release: a full **MDX Editor** with an embedded Wizard, major **Cube Viewer & Subset Editor** upgrades, **per-environment local file storage** (incl. browse-only edit/save), a rebuilt **Server Log** viewer, and a batch of fixes.

### MDX Editor
- **MDX Editor in the Cube Viewer** (like PAW, but simpler): the **MDX** button opens a live **split-view editor** docked next to the grid instead of a modal, so every change you apply is reflected in the cube view right away. It includes a **large, resizable** editor; a searchable, **collapsible categorised Functions List** (Logical, Member, Numeric, Set, Property, String, Miscellaneous, TM1); an **Examples** snippet list; a **Live** toggle; **Undo / Redo** (buttons + <code>Ctrl+Z</code>/<code>Ctrl+Y</code>); and **Apply / Format / Minify / Copy / Save as View** — all without leaving the editor. MDX is **pretty-printed by default**.
- **Embedded 🔧 Wizard**: a toggle expands a visual **View Builder** right inside the editor that writes into the **same MDX field**. It opens **reconstructed from your current view** — the exact members on each row/column axis and the selected context members are loaded in — ready to tweak, with changes flowing to the grid live.
- **MDX Editor in the Subset Editor** (same style): the **MDX** button opens the same docked editor, whose **🔧 Wizard** toggle expands the **Subset Builder** pre-selected to the dimension/hierarchy you're editing; **Apply MDX** loads the built set into the current set.
- **Reset selection** clears the builder (or, in the Cube Viewer, restores it to the current view). A **Control objects** toggle shows/hides `}`-prefixed objects in the dimension & cube pickers. The **Level** input is capped to the hierarchy's real level count (else 50).

### Cube Viewer & Subset Editor
- **Keep / hide elements directly in the grid** (PAW-style): **double-click** a row/column element to **keep only** that element, or **right-click** any header for a menu — *Keep only*, *Hide*, *Drill down / up*, and *Edit subset in Subset Editor*. The per-dimension selection stays **in sync with the Subset Editor** (edit it there, choose *Use in Cube View*, and it's pushed back).
- **Correct layout for empty views**: the Cube Viewer now reads the **native view definition** (which dimensions sit on Rows / Columns / Titles and the subset behind each), so an empty / zero-suppressed view keeps its correct row/column dimensions and subsets instead of collapsing everything into Context.

### Local Storage
- **Per-environment local file storage** — configurable in **Settings → Environments** (a checkbox in the connection form and a **Local Files** column in the overview table). Default is **on**.
- **Browse-only mode** (storage off): opening a process/rule **doesn't create any files or folders** — it opens in an in-memory editor whose **tab shows the object name**, with **TM1 syntax highlighting**, and **Ctrl+S pushes straight to the server** (no local file). *Pull All* writes nothing while you stay connected for browsing/analysis — so a repo can hold only your Dev environment while Test/Prod stay connected.

### Server Log
- **Rebuilt Server Log viewer**: a dedicated panel with **full-text search**, **Level** filters (Info / Warn / Error / Debug), a **Logger** filter, a **time range** (last 15 min → 7 days, or latest 2000), **live tail**, **Load older**, and **Export** of the filtered lines. Shows a **Thread** column and **readable timestamps**. Reads the same `MessageLogEntries` feed PAW uses, with the searching/filtering PAW lacks.

### Bug fixes & improvements
- **Disconnecting an instance now closes its open tabs** (Cube Viewer, Subset Editor, MDX Wizard, Bulk Delete, Server Log) instead of leaving panels that only error with "not connected".
- **Bulk Delete — more object types**: in addition to Processes, Views and Subsets, you can bulk-delete **Chores, Cubes and Dimensions** (with confirmation and per-item failure reporting), plus a **Control objects** filter.
- **Single-axis views no longer fail** with *"Sequence gap in selection axes"* — a single populated axis is now emitted `ON COLUMNS` so clearing Rows or Columns works.
- Saving a process/rule from browse-only mode shows a single clear message (the server/syntax error), consistent with the on-disk save.

## [3.5.3] - 2026-08-18

### Added
- **Variable IntelliSense in TI code** (like PAW): as you type an identifier in a `.ti`/`.pro` file, pa-code now suggests the process' own **variables** — the ones assigned earlier in the code — along with its **parameters** and **datasource variables** (from `#JSON_PROPERTIES`). Each suggestion shows the variable's first assigned value (e.g. `cSubset = 'TestSubset'`), and variables are listed above functions. Comparisons (`==`, `>=`, …) and comment/string contexts are ignored, so only real assignments are offered.

## [3.5.2] - 2026-08-18

### Fixed
- **ASCII datasource corrupted when saved from the Process Properties panel** (*"Invalid data source properties supplied for data source type 'ASCII'"*): the panel read and wrote **generic** property names (`dataSourceColumnDelimiter`, `dataSourceHeaderLines`, `dataSourceQuoteCharacter`, `dataSourceDecimalSeparator`) instead of the **ASCII-specific** ones TM1 requires. As a result it showed the wrong delimiter (e.g. *Comma* when the file used `;`) and, on save, rewrote the datasource with invalid properties while dropping `asciiDelimiterType`, `asciiThousandSeparator` and `dataSourceNameForClient` — so the process could no longer be saved. It now uses `asciiDelimiterChar` / `asciiHeaderRecords` / `asciiQuoteCharacter` / `asciiDecimalSeparator`, **preserves every datasource property the form doesn't edit**, and repairs already-corrupted datasources on save. This also fixes variables on datasource processes not appearing in PAW (a side-effect of the corrupted datasource).

## [3.5.1] - 2026-08-17

### Fixed
- **Saving a process with variables failed with "Invalid ProcessVariable property encountered in payload"**: the 3.5.0 variable-normalisation added fields (`StartValue`, `ExpandingType`, `Tuple`, `Attribute`) that aren't valid TM1 `ProcessVariable` properties, so any process with variables could no longer be saved. Variables are now written with only the valid fields — `Name`, `Type`, `Position`, `StartByte`, `EndByte` — while still renumbering positions and de-duplicating names, so adding/editing variables saves correctly and they still appear in PAW.

## [3.5.0] - 2026-08-13

A major feature release: a new **Lineage** view with runtime run-analysis, connections stored in VS Code, much richer Rules/TI IntelliSense, and a batch of Set Editor, Cube Viewer, Deployment and tree-search improvements.

### Added

**Lineage (new)**
- **Process & Rule lineage** — right-click a process or cube in the tree (or use the Command Palette) to open an interactive dependency diagram:
  - *Process call tree*: recursively follows `ExecuteProcess`/`RunProcess` to any depth, resolving literal names and simple variables (`v = 'Name';`); processes that are called but missing on the server are flagged red.
  - *Cube rule lineage*: the cubes a cube reads via `DB`/`CellValueN`/`CellValueS` (blue), the dimensions used in `ATTRS`/`ATTRN` (orange), the cubes that **feed into** it (green) and the cubes **it feeds** (purple), parsed from the calc and `FEEDERS` sections. The selected cube's own references render instantly; the slower "feeds into this cube" scan runs afterwards and is cached per instance for the session.
  - Rendered as a dependency-free diagram with a colour legend; **click any box to re-root**, with **Back/Forward history** and a breadcrumb. Each invocation opens its **own tab** so you can compare lineages side by side.
- **Process run analysis from `tm1server.log`**: pick a look-back window (1–30 days) and click **Analyze runs** to list every execution of the selected process. Choose a run to overlay each box with **how often it ran**, its **average or total runtime**, and **error status** (red outline + ⚠), with non-executed steps dimmed. Durations are read straight from the log (`elapsed time` / German `verstrichene Zeit`), and both **English and German** logs (`Prozess`, `Ausführung normal beendet`, `abgebrochen`) plus chore-triggered runs are understood.

**Connections**
- **Connections are now stored in VS Code by default** — no auto-created `tm1-project.json`. Each connection has a **Storage Scope** (this workspace / global), with a default via `pa-code.connections.defaultScope`, and a **Move Connections into VS Code** command migrates an existing file. Existing `tm1-project.json` files are still read; secrets stay in VS Code SecretStorage.
- Configurable location for a legacy `tm1-project.json` via `pa-code.projectFile.location` (store it outside the git repo).

**Rules & TI IntelliSense**
- **Signature help** (parameter hints) as you type function arguments — full syntax with the current argument highlighted; Ctrl+Shift+Space to summon.
- **Function hover** in `.ti`/`.pro`/`.rux` showing syntax, description and TI/Rules context.
- **Name pickers in arguments**: cube + per-dimension element completion in `DB`/`CellValueN`/`CellValueS`; element help inside left-side `[ … ]` rule areas and feeders; and **attribute-name completion** in the `ATTRN`/`ATTRS`/`AttrGet*`/`ElementAttr*`/`AttrPut*` families. Element completion is on by default in Rules files.

**Set Editor**
- **Searchable attribute picker** to choose exactly which attribute columns show — with a filter box and All/None — applied to both panes.
- **Consolidation weights**: a badge for non-default child weights, plus a PAW-style **⚖ Weights** column showing every child's weight relative to its parent.
- **MDX Format / Minify** in the subset MDX dialog (matching the Cube Viewer) to pretty-print or compact a set's MDX.

**Cube Viewer**
- MDX **Format** / **Minify** buttons; edit the MDX directly and **Apply** it to preview, **Save as View** to store it, or **Copy** it.
- A **📂 Views** button opens any of the cube's saved views from within the viewer, and saving over an existing view name now asks to **Overwrite** first.
- View tabs read `View: ‹cube› · ‹view›` so it's clear which cube a view belongs to.

**Syntax & functions**
- **Complete IBM 2.0/2.1 function coverage**: the function list was audited against the official IBM Planning Analytics 2.0/2.1 TI & Rules reference (401 functions). **233 previously unrecognised functions are now syntax-highlighted** — the full `*Attr*` families, all `Hierarchy*`/`HierarchySubset*`, sandbox, data-reservation, security-overlay and many rules functions — and **132 were added to the TM1 Function Reference and IntelliSense**, resolving cases like `DTYPE` and `ViewExtractSkipConsolidatedStringsSet` not being recognised.

**Elsewhere**
- **Search Views and Subsets in the tree** — per-cube Views and per-hierarchy Subsets folders each get their own search/clear icons.
- **Deployment Assistant**: a **Refresh Connections** button.

### Changed
- **Cube Viewer — Apply edited MDX in place**: applying edited MDX updates the grid directly and rebuilds its layout, even when dimensions move between Rows, Columns and Context.
- **Deployment Assistant**: the instance chosen as **Source** is hidden from the **Target** list (and vice-versa).
- **Consistent search UX**: descriptive search boxes across the Set Editor, MDX Wizard and the Cube Viewer view picker, and the instance-level tree search now filters **live as you type** (no Enter to confirm), matching the folder searches.
- **Consistent accordion styling** (rotating chevron + hover) for collapsible sections.

### Fixed
- **Spurious "changed on the server" conflict when saving a process**: TM1 silently regenerates datasource-derived, PAW-hidden process **Variables**, which made an otherwise-untouched process look modified on the server and blocked saves. The sync baseline now ignores that volatile `Variables` array (and JSON key order/formatting), so only real changes — code, parameters, datasource, security — count as conflicts. (One-time: the first save of each already-open process after updating re-establishes its baseline.)
- **Duplicate / non-working clear-search icon on connected instances**: an instance node showed two clear-search icons (the first did nothing) because the folder clear action's visibility rule (`viewItem =~ /_filtered$/`) also matched the instance node; it's now scoped to folder/control nodes only, so an instance shows a single, working clear-search icon.
- **Process variables saved via JSON Properties now show in PAW**: a variable added by hand in a process' `#JSON_PROPERTIES` could be stored by TM1 but not displayed in PAW — which then reported *“variable already exists”* when you re-added it. On save, pa-code now writes variables in the canonical shape PAW expects (Name, Type, sequential Position, StartValue and the required defaults) and drops duplicate names, so hand-added variables appear and round-trip cleanly.
- **Process Properties panel now reflects JSON edits and reports invalid JSON**: the Data Source / Parameters / Variables tabs read the process' `#JSON_PROPERTIES` block and now **refresh live** as you edit that JSON in the editor; if the JSON has a syntax error the panel shows a clear message instead of silently displaying empty tabs, and a variable's `Type` is read more tolerantly.

## [3.4.6] - 2026-07-31

### Changed
- **Integrated Login is now true single sign-on — no username/password prompt**: connecting with Integrated Login (Security Mode 2/3) no longer asks for credentials up front. It signs in directly with your **current Windows session** via Kerberos (exactly like Architect). Credentials are only requested **if** Kerberos SSO can't be used and the server can fall back to NTLM — in which case a single prompt appears explaining why. Previously it always asked for a username and password that the Kerberos path then ignored.

### Fixed
- **Kerberos Integrated Login now uses the server FQDN for the SPN**: the diagnostic log revealed the Kerberos attempt was requesting the SPN from the **short** host name, which the KDC rejects with *"The specified target is unknown or unreachable"* (SEC_E_TARGET_UNKNOWN) because SPNs are registered against the **FQDN**. pa-code now resolves the host to its FQDN (A record → reverse PTR) and requests `HTTP/<fqdn>` — even when the environment is configured with the short host name.

### Added
- **New setting `pa-code.integratedLogin.kerberosSpn`**: an optional explicit SPN override (e.g. `HTTP/tm1host.corp.example.com`) for cases where auto-detection can't determine the right name — set it to exactly match what your domain admin registered with `setspn -S HTTP/<fqdn> <account>`.

### Notes
- **Self-signed / untrusted TLS certificates are accepted** during Integrated Login (the login client, like the rest of pa-code, does not enforce certificate validation), so a self-signed HTTPS endpoint does not block Kerberos sign-in.
- If Kerberos still reports SEC_E_TARGET_UNKNOWN after this update, the `HTTP/<fqdn>` SPN is genuinely not registered in AD: run `setspn -S HTTP/<fqdn> <tm1-service-account>` (or use a computer/HOST-mapped account), then retry. The diagnostic log shows the exact SPN being requested.

## [3.4.5] - 2026-07-30

### Fixed
- **Integrated Login now really uses Kerberos (no more silent NTLM downgrade)**: the Kerberos attempt requested the SSPI **"Negotiate"** package (via the SPNEGO mech OID), which — when it can't immediately get a Kerberos ticket — **silently falls back to NTLM**. Kerberos-only TM1 servers then rejected the request with *"the client is using NTLM"* in `tm1sspi.log`. pa-code now selects the **"Kerberos"** SSPI package directly (KRB5 mech), so it sends a genuine Kerberos token and never downgrades to NTLM. If no Kerberos ticket can be obtained it fails cleanly and falls back to the standalone NTLM handshake (for ISM 2 servers that allow it) instead of sending a mismatched token.
- Reminder for Kerberos setups: use **Single Instance** with the server's **FQDN** (not the short name) as the host, and ensure the TM1 host's `HTTP/<fqdn>` SPN is registered — the FQDN is what the Kerberos ticket/SPN lookup uses.

### Added
- **Integrated Login diagnostic log**: a dedicated **"PA Code (Integrated Login)"** output channel now records each authentication attempt — endpoint, host/SPN, parsed user/domain, whether the Kerberos component loaded, each Kerberos/NTLM leg and HTTP status, and the final outcome (no passwords or tokens are logged). It opens automatically when a login fails, and can be shown anytime via **PA Code: Show Integrated Login Diagnostic Log** — making it much easier to analyse a failed sign-in.

## [3.4.4] - 2026-07-29

### MCP Server usable from any AI tool (not just Copilot), incl. Codex
- **Connect the built-in MCP server from external AI tools**: the read-only TM1 MCP server (23 tools, `tm1://` resources, prompts) can now be used by any MCP-aware client — Claude Code / Claude Desktop, Codex, Cline, Continue, Cursor, … — so users who don't use GitHub Copilot can still give their AI live context about the TM1 model. The Copilot Agent integration keeps working unchanged.
- **New command `PA Code: Show MCP Endpoint (for external AI tools)`**: reveals the endpoint and copies a ready-to-use configuration — a generic `mcpServers` HTTP JSON block (Claude Desktop, Cline, Continue, Cursor…), a `claude mcp add --transport http …` one-liner, a **Codex** pair (`setx <VAR> <token>` + `codex mcp add pa_code_tm1 --url <url> --bearer-token-env-var <VAR>`), or an `npx mcp-remote …` stdio-bridge command. Also copies the URL/token and can regenerate the token.
- **Persisted token**: the bearer token is stored in VS Code SecretStorage, so an external client configured once keeps working across restarts. Rotate it anytime from the endpoint command.
- **New setting `pa-code.mcpServer.port`**: pin the loopback port (e.g. `3900`) for a stable external URL. Default `0` keeps the OS-assigned random port.
- **New setting `pa-code.mcpServer.autoStart`**: start the MCP listener as soon as the extension activates (instead of lazily), so external tools such as Codex — which connect on their own and don't wait for VS Code/Copilot to request the server — find the endpoint already listening.
- **New setting `pa-code.mcpServer.tokenEnvVar`**: read the bearer token from a named environment variable (e.g. `PA_CODE_MCP_TOKEN`) so a client using `--bearer-token-env-var` shares the exact same token, with nothing secret written into the client's config. This replaces the community bundle-patch workaround with supported configuration that survives updates.
- The server still binds to `127.0.0.1` only, enforces a per-request bearer token, a loopback Host guard and capped payloads — and remains strictly read-only.

## [3.4.3] - 2026-07-29

### Windows Integrated Login now supports Kerberos SSO (Security Mode 2/3)
- **Real Kerberos/SPNEGO single sign-on**: Integrated Login now authenticates the same way native clients (Architect) do — on Windows it uses **SSPI with your current logged-in domain session** to obtain a Kerberos service ticket, so servers whose `tm1s.cfg` is configured for **Kerberos** (which returned `WWW-Authenticate: Negotiate` and rejected Basic/NTLM before) now connect. On macOS/Linux it uses the system **GSSAPI** credential cache.
- **Automatic fallback**: Integrated Login tries **Kerberos first**, then falls back to the **NTLM** handshake with the credentials you enter (for ISM 2 servers that allow NTLM). Clearer diagnostics when neither succeeds (e.g. no domain ticket, or an unregistered `HTTP/<fqdn>` SPN).
- **Cross-platform safe**: the Kerberos component is a native module that is loaded **lazily and optionally**. If it can't load on a machine, only Integrated Login is affected — every other authentication method and feature keeps working on Windows, macOS and Linux. (The VSIX is a little larger because it now carries the native binary.)

## [3.4.2] - 2026-07-28

### Fixed
- **Per-environment Request Timeout no longer breaks long-running operations**: the configurable timeout is meant only for the initial **login** of slow-to-reach environments. A global request interceptor was, however, applying it as a floor to *every* request — which imposed a timeout on operations that previously had none and made e.g. **rule transports fail** with "timeout of 15000ms exceeded" when saving large rules/feeders. The timeout is now scoped to the login handshake only; all other requests keep their original (longer or unlimited) timeouts, exactly as before the setting was introduced.

## [3.4.1] - 2026-07-28

### Fixed
- **Windows Integrated Login (Security Mode 2/3) now actually authenticates**: servers running IntegratedSecurityMode 3 answer with `WWW-Authenticate: Negotiate` and reject HTTP Basic with a 401 — which is what the previous Integrated Login path sent. pa-code now performs a real **NTLMv2 handshake** with your Windows/AD credentials over a single keep-alive connection and, on success, stores the returned `TM1SessionId` cookie for all further requests.
- **Flexible credential format**: enter either `DOMAIN\user` (e.g. `CONTOSO\jdoe`, the more reliable NetBIOS form) or `user@domain`. When no domain is given, the domain advertised by the server is used.
- **Safer sign-in**: only one credential attempt is made per connection (a scheme fallback happens only when a scheme offers no challenge), to avoid unnecessary failed logons and AD account lockouts. Clearer error messages distinguish rejected credentials from Kerberos-only servers that refuse NTLM.

## [3.4.0] - 2026-07-26

### Built-in MCP Server (headline)
- **A real, fully-integrated Model Context Protocol server**: pa-code registers an MCP server directly with VS Code — no separate install, no subprocess, no extra configuration. It runs **in-process** and **reuses your live, authenticated TM1 connection** (Basic / CAM / OAuth), so there is no second connection layer and no duplicated credentials. It gives the VS Code Copilot agent — and any MCP-compatible client such as Claude Desktop — live, structured context about your TM1 model, so the AI understands your cubes, dimensions, processes and rules before it helps you read, explain or change code.
- **23 read-only tools**: list cubes / dimensions / processes / hierarchies / views / subsets; get process code, parameters, cube rules, cube dimensions and dimension elements; server info; regex-search across all TI code; analyze where a cube/dimension is used; find and sample dimension elements; read a view's data; execute read-only MDX; list threads, message log and chores; and fetch the latest error log of a failed process. Everything is **strictly read-only** — writing back stays a deliberate pull/push.
- **Resources** (`tm1://…`): attach live model content directly in a chat prompt — a process' code, a cube's rules or dimensions, or the server info — with resource templates and name auto-completion (reference them with `#`).
- **Prompts**: reusable templates that pull the right context automatically — *Explain TI Process*, *Review Cube Rules*, *Impact Analysis*.
- **Secure by design**: bound to loopback only, a per-session bearer token on every request, Host-header (DNS-rebinding) protection and capped payloads. Toggle the whole server with `pa-code.mcpServer.enabled`.

## [3.3.0] - 2026-07-26

### Two-way conflict protection
- **Conflict-safe save**: pa-code records a baseline of the server source when you pull or open a process/rule. If it was changed on the server before you save, you get **Overwrite Server / Show Diff / Cancel** instead of a silent overwrite (for both processes and rules).
- **Conflict-safe pull**: Pull All keeps files you changed locally instead of overwriting them, reports what was kept, and lets you take the server version on demand.
- **Offline protection** toggle per file (marked with an `O` badge) — never overwritten by Pull.
- **Consistent conflict dialogs** throughout: a short title, a detail line explaining the consequence, and a consistent button order (safe → compare → destructive).

### Process editing
- **Permanent open** (no reused preview tab), plus **Delete process** and **Rename process** (copy + delete under the hood; the local file and its baseline move with it).
- **Code folding** for `.ti` files: `#SECTION` tabs, `#JSON_PROPERTIES`, `#Region`/`#EndRegion` and generated `#****Begin/End` blocks.
- **Pretty SQL**: the ODBC data-source query is now a multi-line editor with a **Format SQL** button.

### Offline / manual-publish workflow
- **Auto-Push toggle** (status bar): turn off pushing on save to edit offline and commit to git, then run **PA Code: Publish Changed Files** to push all changed `.ti`/`.rux` at once — with the same conflict guard.

### Deployment Assistant
- **Multi-select** browser (checkbox list + filter + Select All) to add many objects at once, and **Load from Log** to reuse a previous deployment set for re-deployment or promotion.

### Environment configuration & tree
- **Test Connection** button (validates parameters per connection type without saving) and a per-environment **Request Timeout** for slow connections, in a modernized, theme-consistent dialog.
- **Control Objects search** works again in every category; **Pull always includes control objects** (no prompt); and the **MDX Wizard** View Builder was fixed.

## [3.2.0] - 2026-07-17

### OAuth (PAW) & Windows Integrated Login
- **OAuth 2.0 for Planning Analytics Workspace**: connect to IBM PAW and its PAW-routed TM1 databases via the Authorization Code flow. Sign-in opens your system browser and completes on a local loopback callback. Configure PAW Base URL, Client ID, Client Secret, Callback Port (with a ready-to-register callback URL) and an optional TM1 database; the client secret is stored in VS Code SecretStorage (never in the project file).
- **No repeated logins**: access tokens are cached and silently refreshed via the refresh token, so reconnecting rarely needs another browser sign-in — even after a VS Code restart. Reset stored credentials with **PA Code: Clear Stored OAuth Credentials**.
- **Database discovery**: if no database is set, pa-code lists the available TM1 servers via `/api/v1/tm1/Servers` and lets you pick one; the connection then uses the PAW-routed TM1 REST base `/api/v1/tm1/<server>/api/v1`.
- **Windows Integrated Login (Security Mode 3)**: new authentication method for TM1 servers running IntegratedSecurityMode 3 — sign in with your Windows/AD credentials (e.g. `user@domain`), sent via Basic auth with no CAM namespace.

## [3.1.0] - 2026-07-17

### Data Model Tree (PAW-Style Navigation)
- **Standard TM1 Layout**: Each connected instance shows the familiar TM1 developer structure — **Cubes**, **Dimensions**, **Processes**, **Chores** and **Control Objects** (which expands into Cubes, Dimensions and Processes for the `}`-prefixed control objects).
- **Expandable Cubes**: A cube expands to reveal its **Dimensions**, **Views** and **Rules**, with a cube icon.
- **One-Click Editors**: Clicking a dimension, hierarchy or subset opens the Subset Editor pre-loaded with that selection; clicking a view opens it in the Cube Viewer.

### Subset / Dimension Editor (New)
- **PAW-Style Two-Column Editor**: An "Available members" hierarchy tree on the left and a "Current set" tree on the right, modeled on Planning Analytics Workspace. Both sides render the TM1 hierarchy with element-type icons (∑ consolidation, numeric, string) and expand/collapse, virtualized for tens of thousands of elements.
- **Multiple Dimensions**: Each dimension opens in its own panel, so several can be viewed and edited side by side.
- **Transfer & Selection**: Move members via drag & drop, double-click or the action buttons — insert member only, with children, all displayed, or all available; remove, remove all, keep only selected. Multi-select with Ctrl/Cmd and Shift-range on both lists.
- **Auto-Load**: Selecting a dimension, hierarchy or subset loads it immediately.
- **True Hierarchy Nesting**: In the Current set, members nest under their parent when the parent is also in the set; expanding a consolidation pulls its children into the set and collapsing removes them.
- **Alias Switcher & Attributes**: A "Display as" dropdown re-labels every element with any alias; a toggle shows additional attribute columns.
- **Filter Flyout**: Filter by Name / Level / attribute values with "Match all" (AND) or "Match any" (OR) modes.
- **MDX Engine**: Selections and filters are converted to valid TM1 MDX (`TM1FILTERBYLEVEL`, `TM1FILTERBYPATTERN`, explicit member lists, `UNION`/`INTERSECT`), and an editable MDX statement regenerates the set.
- **Save & Reuse**: "Save as…" writes the subset back to TM1 as a static element list or a dynamic MDX subset (Public or Private). "Use in Cube View" pushes the current set — including the chosen alias — straight onto a Cube Viewer axis.

### Cube Viewer (New)
- **PAW-Style Pivot Grid**: Open from a cube's context menu or by clicking a saved view. Context (title) dimensions sit on top; drag dimension chips between Context, Rows and Columns to pivot and re-nest, and reorder within a zone. A Swap button flips rows and columns.
- **Nested Headers & Drill**: Row and column headers support stacked dimensions with rowspan/colspan merging of repeated parent labels. Consolidations show a twisty and drill down lazily; row headers indent by depth.
- **Aliases**: Aliases chosen in the Subset Editor are shown in context cards and row/column headers (MDX still uses element names).
- **Zero Suppression**: Toggle `NON EMPTY` on rows and/or columns.
- **Data Entry / Writeback**: Double-click a writeable leaf cell to edit; Enter or blur writes the value to TM1 via the `tm1.Update` action, with support for thousands separators and decimals. Rule-calculated cells are highlighted (italic blue) and read-only; consolidated cells are editable for admins; write outcomes are surfaced as clear notifications.
- **Save & Open Views**: The "💾 Save View" button saves the current layout as a named MDX view on the server (Public or Private). Opening a saved view (native or MDX) reconstructs its rows, columns, context and members.
- **MDX Inspector**: View and copy the generated MDX at any time.

### General
- **What's New Page**: After updating, a "What's New" tab opens once to highlight the new features. It can be reopened anytime via the Command Palette → **PA Code: What's New**.

## [3.0.6] - 2026-07-09

### Proxy Support
- **Respects VS Code Proxy Settings**: All HTTP(S) requests now honor VS Code's `http.proxy` and `http.noProxy` settings, not just OS environment variables. Internal TM1 servers listed in `http.noProxy` are no longer incorrectly routed through a corporate proxy.
- **Proxy Precedence**: Proxy URL is taken from `http.proxy` first, then `HTTPS_PROXY`/`HTTP_PROXY` env vars. The no-proxy list combines `http.noProxy`, `NO_PROXY` env var, and always bypasses `localhost`/`127.0.0.1`/`::1`.
- **No-Proxy Matching**: Supports exact hosts, `*.domain`, `.domain`, and bare-domain suffix matching (e.g. `example.com` matches `tm1.example.com`).
- **Proxy Diagnostic Log**: New setting `pa-code.proxy.debug` and command **"PA Code: Show Proxy Diagnostic Log"**. When enabled, every request logs its DIRECT/PROXY routing decision to a dedicated output channel, and a full configuration summary can be shown for troubleshooting.

## [3.0.5] - 2026-06-29

### Connection
- **SSL/HTTP Fallback**: When an HTTPS connection fails with `WRONG_VERSION_NUMBER` (server uses plain HTTP), the extension automatically retries via HTTP and shows a warning to set `"ssl": false` in tm1-project.json.

### CAM Browser Login
- **Cookie Detection Fix**: The polling now fetches fresh page references from the browser on every cycle, preventing stale-page errors after SSO redirects.
- **Case-Insensitive Cookie Name**: Cookie detection now matches `cam_passport` / `CAMPassport` regardless of casing.
- **Poll Error Logging**: Cookie polling errors are now shown in the authentication log instead of being silently swallowed.

## [3.0.4] - 2026-06-29

### Process Properties Panel
- **Edit Process Properties**: New webview panel with Data Source / Parameters / Variables tabs for editing process metadata. Opens beside the `.ti` file via the editor title bar icon (⚙️).
- **Searchable Dropdowns**: Cube, View, Dimension, and Subset fields use searchable dropdown components that fetch data from the connected TM1 instance.
- **Data Source Preview**: "Preview" button for Cube View and Dimension Subset data sources fetches and displays the first 10 rows in a formatted table.
- **Variable & Parameter Management**: Add, remove, and edit parameters (with type/prompt/default) and variables directly in the UI.

### Tree View
- **Admin/Connection Status Indicators**: Connected instances show a green circle icon; disconnected instances show a gray outline. Admin users get a ★ badge (✦ for v12 Tenant) displayed in the item description.
- **Session Expiration Detection**: Background health check every 20 minutes pings all connected instances. On session expiry (401/403), the connection is removed, the tree refreshes, and a warning is shown.

### MDX Wizard
- **Hierarchy Selector**: View Builder dimension config now includes a hierarchy dropdown, allowing selection of non-default hierarchies.
- **Pick Members (Subset Builder)**: New "Pick Members" base selection option with searchable checkbox list to select explicit elements.
- **Pick Members (View Builder)**: New "Pick Member(s)" subset type in View Builder with searchable checkbox list for explicit member selection.
- **Title Element Picker**: Title dimension element input replaced with a filterable dropdown list populated from the server.
- **Duplicate TopBottom Fix**: TopBottom section no longer appears twice when switching subset types in View Builder.
- **Chip Hierarchy Label**: Dimension chips now show the hierarchy name in brackets when it differs from the dimension name.

### Bug Fixes
- **Recently Used Environment Name**: Fixed environment name extraction from instance names containing underscores (e.g. `WBM_DEV_Server`). Now matches against known config environment names instead of naively splitting at the first underscore.
- **Empty Password Allowed**: Password login dialog no longer rejects empty passwords (only cancellation aborts).

## [3.0.3] - 2026-06-23

### CAM Browser Login
- **Edge Startup Boost Fix**: Edge login no longer fails with "Failed to launch browser process" error. Uses spawn+connect approach to bypass Edge's Startup Boost process delegation (Edge 147+).
- **Cookie Detection (All Domains)**: Login now uses CDP `Network.getAllCookies` to detect the `cam_passport` cookie across all domains. Fixes authentication failures when the passport cookie is set on a different domain than the current page.
- **No Private Window**: Edge login no longer opens in InPrivate mode — SSO/MFA cookies persist between sessions.

### Connection
- **Admin Host Cache**: Admin host discovery results are cached for 60 seconds to avoid repeated requests on every tree refresh.
- **Silent Error Handling**: Admin host errors no longer show popup notifications — instead a clickable placeholder item appears in the tree view.

## [3.0.2] - 2026-06-17

### Documentation
- **README Rewritten**: Completely rewritten for TM1 developers new to VS Code. Starts with "Getting Started" guide, clearer structure, Git marked as optional.

## [3.0.1] - 2026-06-17

### Chore Manager
- **Frequency & Schedule Display**: Fixed frequency parsing and display — chores with daily/hourly schedules now correctly show their interval and start time.
- **Task Loading in Edit Modal**: Editing a chore now loads all tasks with their process names and parameters from the server. Tasks are fetched via `$expand=Tasks` in the initial listing and on-demand via the detail endpoint.
- **Execution History**: Improved message log parsing with additional patterns for TM1 log message formats. Default time range changed to "Last 7 Days".
- **Duration Fix**: Fixed duration calculation — logs arrive in descending order, so only the most recent start/end timestamps are now kept (previously the oldest pair was used, leading to missing durations). Increased log fetch limit from 500 to 2000 for better coverage across many chores.

### MDX Wizard
- **Cube Value Filter**: New tuple-based cube value filter with dynamic dimension/element pair rows (add/remove). Supports both numeric and string thresholds.
- **Execute & Preview**: Added "Execute" button with accent styling. Results panel shows member lists for subset mode and formatted cell values for view mode.
- **Layout Fix**: Both config and preview panels now use flex layout. Preview code area capped at 40vh for better balance.
- **MDX Execution (2-Step Cellset)**: Rewrote MDX execution to use TM1py's proven approach — creates a cellset via `POST /ExecuteMDX`, then extracts members via `GET /Cellsets('{id}')` with `$expand=Axes($expand=Tuples($expand=Members($select=Name)))`. Replaces the broken `ExecuteMDXSetExpression` endpoint.

### Server Log
- **Initial Load Increased**: Server log now loads 1000 entries initially (up from 200).
- **Load More Button**: New "↑ Load More Log Entries" button in the status bar allows loading older entries on demand (1000 at a time, inserted at the top). Button auto-hides when the log document is closed.

### Bulk Delete
- **Global Pattern Search Performance**: Parallelized REST calls for the global pattern search — now fetches views/subsets in batches of 10 concurrently instead of sequentially. Significantly faster on servers with many cubes/dimensions.

### Process Execution
- **Unified Parameter Handling**: Both the tree view "Execute" and the "Recently Used" execute button now show the same parameter panel. If last-used parameters exist, they are pre-filled by default.
- **Parameter Toggle**: When last-used parameters are available, a toggle bar appears at the top of the execution panel with "Last Used Parameters" (active) and "Default Parameters" buttons to switch between the two parameter sets with one click.

### Multi-Instance Panels
- **Per-Instance Webviews**: All panels (Chore Manager, Thread Viewer, Security Manager, File Manager, Bulk Delete, MDX Wizard, Instance Hub, Configuration) now support multiple simultaneous instances. Opening a panel for Server B while Server A's panel is open creates a new tab instead of revealing the existing one.

### Recently Used
- **Parameter Preview Before Execution**: "Run with Last Parameters" now opens the standard execution panel pre-filled with saved values (with toggle to switch to defaults).

### Favorites
- **Favorite Star in Editor**: `.ti` and `.rux` files now show a ⭐ star icon in the editor title bar to add the current file to Favorites directly.

### Bug Fixes
- **Template Literal Regex Escaping**: Fixed all regex patterns in ChoreManagerPanel webview code — backslashes are now properly doubled in template literals (`\\s`, `\\d`, etc.), resolving `SyntaxError: Invalid regular expression` errors.
- **OData Case-Sensitivity**: Chore message log filter now uses `tolower()` for case-insensitive matching.

## [3.0.0] - 2026-06-09

### Chore Manager
- **Chore Manager Panel**: New webview panel for managing TM1 scheduled chores. Accessible via the Instance Hub (Administration section), the right-click context menu on connected instances, or the Quick Actions sidebar.
- **Chore Overview**: Displays all chores in a sortable table with columns for Active status, Name, Frequency, Next Run, Last Run, Duration, Status, and Execution Mode.
- **Toggle Active**: Enable or disable chores directly from the table via toggle switches.
- **Execute Now**: Run any chore on-demand with a single click.
- **Create & Edit Chores**: Full modal dialog for creating and editing chores — configure name, start time, frequency (ISO 8601 duration with helpers), execution mode, and manage task lists with drag-and-drop reordering.
- **Process Parameters**: When adding tasks, process parameters are automatically fetched from the server and can be configured per task.
- **Delete Chores**: Delete chores with a confirmation prompt.
- **Execution History**: View recent execution history per chore with status and duration.

### Security Manager
- **Security Manager Panel**: New webview panel for managing TM1 security groups and user assignments. Displays a user-group matrix table with clickable cells to toggle group membership.
- **Group & User Management**: Create and delete security groups and users directly from the panel.
- **Search & Filter**: Filter users and groups by name. Group count display per user.

### MDX Wizard
- **Visual MDX Builder**: New two-mode webview panel (Subset Builder / View Builder) with live MDX preview.
- **Subset Builder**: Dimension/hierarchy selection, base selections (All Members, Leaf only, specific level), pattern filter with wildcards, attribute filter with operators (=, <>, CONTAINS), structure options (Descendants, Children), sorting, and set operations (UNION, INTERSECT, EXCEPT).
- **View Builder**: Cube selection with automatic dimension discovery, axis assignment (Rows, Columns, Titles) with drag & drop, per-dimension subset definition, and Suppress Zeroes options.

### File Manager
- **Server File Browser**: New webview panel to browse TM1 server files via REST API. Navigate Applications, Blobs, model_upload, and logs folders with breadcrumb-style navigation. View and download files from the server.

### Bulk Delete
- **Bulk Object Deletion**: New webview panel for bulk-deleting TM1 objects (Processes, Views, Subsets). Includes object type and context selection, table with checkboxes, search, and sort.

### Activity Bar & Sidebar
- **Dedicated PA Code Sidebar**: PA Code gets its own activity bar icon and sidebar with organized sections: Connections, Recently Used, Favorites, Quick Actions, and TM1 Function Reference.
- **Quick Actions**: Direct access to Search, New Process, Pull All, Server Log, Thread Viewer, Deployment Assistant, MDX Wizard, Chore Manager, and Settings from the sidebar.
- **Favorites**: Pin frequently-used processes for quick access via star icon. Remove with star-delete icon.

### Recently Used
- **Run with Last Parameters**: Processes in the "Recently Used" sidebar that have been executed with parameters now show a ► icon to re-run them instantly with the same parameter values from the last execution.

### Connections
- **v12 Tenant Support**: New "v12 Tenant (Multi-Database)" connection type for IBM Planning Analytics v12. Connect to a tenant URL and discover all databases via `/api/v1/Databases`, similar to how Admin Server discovers instances in v11.

### Bug Fixes
- **Syntax Error Line Mapping**: Fixed an off-by-one error where syntax error diagnostics and the "Go to TM1 Line" feature would jump to the wrong line when blank lines exist between section headers and code. Line numbers now correctly skip leading blank lines to match TM1's compile output.

## [2.3.1] - 2026-06-03

### Editor
- **Variable Hover — Jump to Definition with Highlight**: Clicking "Go to definition" in the variable hover tooltip now scrolls to the assignment line, centers it in the editor, and briefly highlights it for 1.5 seconds.

## [2.3.0] - 2026-06-02

### Editor
- **Run & Debug Buttons in Editor Toolbar**: `.ti` files now show persistent Run (▶) and Debug (🐛) buttons in the editor title bar, providing quick access without scrolling to the CodeLens at line 1.
- **Variable Hover**: Hovering over a variable in a `.ti` file shows all assignments of that variable in the script, with the source line and line number — similar to IDE hover in other languages.

### Deployment Assistant
- **Diff Statistics**: The review table now shows line-level diff statistics (`+N` / `-M`) next to the Compare button for existing objects. Added lines are shown in green, removed lines in red. Identical objects display "identical".

## [2.2.0] - 2026-05-28

### Rule Editor
- **Rule Syntax Checking**: After saving a `.rux` file, the extension automatically checks the rule syntax on the server via `tm1.CheckRules`. Syntax errors are shown as diagnostics (red underline) with the cursor jumping to the first error line.
- **Save Progress with Timer & Cancel**: Rule saves now display a progress notification with a live elapsed-time counter and a cancel button — analogous to TI process execution. Useful for large rules or feeders that take longer to save.

## [2.1.0] - 2026-05-27

### Instance Hub
- **Instance Hub Panel**: New tile-based navigation panel for connected TM1 instances. Opens automatically after connecting and replaces the previous row of inline icons with a clean, organized webview UI. Tiles are grouped into four categories: Develop, Monitor, Deploy, and Connection.
- **Keyboard Shortcuts**: Six new global shortcuts for quick access to common actions:
  - `Ctrl+Alt+F` / `⌘+⌥+F` — Search Processes
  - `Ctrl+Alt+N` / `⌘+⌥+N` — New Process
  - `Ctrl+Alt+P` / `⌘+⌥+P` — Pull All from Server
  - `Ctrl+Alt+L` / `⌘+⌥+L` — Server Log
  - `Ctrl+Alt+T` / `⌘+⌥+T` — Thread Viewer
  - `Ctrl+Alt+D` / `⌘+⌥+D` — Deployment Assistant
- **Platform-Aware Shortcut Labels**: The Hub panel dynamically displays macOS symbols (`⌘+⌥`) or Windows/Linux keys (`Ctrl+Alt`) based on the user's operating system.
- **Material Design Icons**: All Hub tiles use official Google Material Symbols for a clean, professional look.

### Language Improvements
- **Comment Toggle**: Added `#` as TM1 line comment character. Use `Ctrl+#` (or `Cmd+#` on Mac) to toggle comments in `.ti`, `.pro`, and `.rux` files.
- **German Special Characters**: Syntax highlighting now correctly handles umlauts and ß (ö, ä, ü, Ö, Ä, Ü, ß) in rule definitions and variable names.

### UI Cleanup
- **Streamlined Inline Icons**: Connected instances in the tree view now show only Hub, Search, Clear (when filtered), and Disconnect as inline icons. All other actions (Pull, Log, Threads, Config, Deploy) are accessible via the Hub panel, keyboard shortcuts, or the right-click context menu.

## [2.0.1] - 2026-05-21

### Bug Fixes
- **Corporate Proxy Support**: The extension now respects VS Code's `http.proxy` setting and the `NO_PROXY` environment variable. Users behind corporate forward proxies no longer receive 400 "Request Error (invalid_request)" errors. When no proxy is configured, behavior is unchanged.

## [2.0.0] - 2026-05-20

### Deployment Assistant
- **Cross-Environment Transport**: New Deployment Assistant panel for transporting TI processes and rules between TM1 instances. Accessible via the rocket icon on connected instances or the Command Palette (`Deployment Assistant`).
- **Mixed Object Selection**: Select both TI processes and rules in a single deployment session. Objects are color-coded — blue tags for processes (TI), orange tags for rules (RX) — for instant visual distinction.
- **Search & Multi-Select**: Search-as-you-type widget with keyboard navigation (arrow keys + Enter). Switch the type dropdown to add processes and rules freely; selections are preserved across type switches.
- **Target Existence Check**: Before deploying, the assistant checks each object on the target instance and shows its status — "Create" (new) or "Update" (exists) — with colored badges.
- **Compare Before Deploy**: Click "Compare" on any existing object to open VS Code's native diff editor showing the target (left) vs. source (right) side by side.
- **Deploy with Progress**: One-click deployment with a progress notification showing each object as it's transported. Processes are created or updated; rules are patched on the target cube.
- **Transport Logging**: Optional JSON log files recording every deployment with timestamp, source/target, object details, and full before & after code. Configure directly in the panel's collapsible "Transport Log Settings" section (toggle + directory path).

### Bug Fixes
- **Fixed Edge SSO Login (about:blank)**: Resolved an issue where the Edge browser opened with `about:blank` instead of navigating to the Cognos login page. The login URL is now passed as a positional argument in Edge's launch args, with a fallback explicit navigation if the initial page doesn't load.
- **Fixed Edge SSO Redirect**: Edge no longer redirects to the default homepage during SSO login. Launches without `--app` mode with `msEdgeRedirect` disabled.
- **Browser Selection for CAM Login**: The CAM login panel shows two buttons — "Login with Edge" and "Login with Chrome" — allowing users to choose their preferred browser for SSO authentication.

## [1.7.1] - 2026-05-19

### Quickfix
- **Fixed Edge SSO Redirect**: Resolved an issue where Edge in `--app` mode would redirect to the default homepage during SSO login instead of following the authentication flow. Edge now launches without `--app` mode and uses `page.goto()` with `msEdgeRedirect` disabled.
- **Browser Selection for CAM Login**: The CAM login panel now shows two buttons — "Login with Edge" and "Login with Chrome" — allowing users to choose their preferred browser for SSO authentication.

## [1.7.0] - 2026-05-19

### Thread Viewer
- **Thread Monitoring Panel**: New webview panel showing all active TM1 threads in a real-time table with auto-refresh every 3 seconds. Accessible via the list icon on connected instances in the PA Code Explorer.
- **Sortable & Filterable**: Click column headers to sort by any field (ID, Name, State, Type, Function, Elapsed, Context). Use the search box to filter threads across all columns.
- **Kill Threads**: Cancel any thread directly — either click the "✖ Kill" button in its row, or enter a Thread ID manually and press "✕ Kill Thread".
- **ISO Duration Parsing**: Wait and Elapsed columns automatically parse TM1's ISO 8601 duration format (`P0DT00H00M00S`) into human-readable seconds.

### Process Execution Enhancements
- **Live Timer**: The execution notification now shows a real-time elapsed timer (e.g., `0:05`, `1:30`) that updates every second while the process runs.
- **Cancel Running Process**: The execution notification includes a cancel button. Clicking it aborts the HTTP request and sends `tm1.CancelOperation` to the server to terminate the running thread.
- **Execution Duration in Results**: Success, warning, and error messages now include total execution time (e.g., "Process 'X' successfully executed. (12s)").

### Syntax Error Navigation
- **Jump to Error Line**: When saving a TI process with a syntax error, the editor automatically jumps to the offending line and highlights it briefly.
- **Inline Diagnostics**: Syntax errors appear as red squiggly underlines in the editor with entries in the Problems panel. Diagnostics clear automatically on successful save.

### Bug Fixes
- **Server Configuration Parameter Updates**: Fixed an issue where parameters in nested sub-sections (e.g., `TI.EnableTIDebugging`) could not be updated. The extension now correctly handles dot-separated parameter paths and builds proper nested PATCH bodies.

## [1.6.0] - 2026-05-13

### TM1 Function Reference
- **Function Reference Panel**: New "TM1 Function Reference" sidebar panel in the Explorer view listing all TI and Rule functions organized by category (200+ functions across 20+ categories).
- **Click-to-Insert Snippets**: Click any function in the panel to insert it at the cursor position with a full snippet including tab-stop parameters for quick editing.
- **Search & Filter**: Use the search icon in the panel title bar to filter functions by name. Clear the filter with the clear icon to restore the full list.
- **IntelliSense Snippets**: Typing a function name (minimum 2 characters) in `.ti`, `.pro`, or `.rux` files triggers IntelliSense suggestions with full syntax snippets — complements the existing dynamic server-based autocomplete.
- **Context-Aware Completions**: Function suggestions are filtered by file type — TI-only functions appear in `.ti`/`.pro` files, Rule-only functions in `.rux` files, and shared functions in both.
- **Rich Tooltips**: Hover over any function in the reference panel to see its full syntax and description in a formatted tooltip.

## [1.5.0] - 2026-05-07

### TI Process Debugger
- **Native TI Debugging**: Full-featured TurboIntegrator process debugger using VS Code's built-in Debug UI and the TM1 REST API's native debug endpoints (`ProcessDebugContexts`).
- **Breakpoints**: Set breakpoints by clicking in the gutter. Supports all four procedure sections (Prolog, Metadata, Data, Epilog).
- **Step Controls**: Continue (F5), Step Over (F10), Step Into (F11), and Step Out (Shift+F11). Step Into follows `ExecuteProcess` calls into sub-processes.
- **Variables Panel**: Live variable inspection in the Run & Debug sidebar — see all TI variables and their current values update after every step.
- **Call Stack**: Full call stack display showing current procedure section and sub-process hierarchy when stepping into child processes.
- **Debug CodeLens**: A `$(bug) Debug` button appears next to the existing `Run` button at the top of every `.ti` file.
- **Auto-Enable TI Debugging**: If `EnableTIDebugging` is not active on the server, the extension offers to enable it automatically before starting the debug session.

### Server Configuration Management
- **Configuration Panel**: New webview panel to view and edit all TM1 server configuration parameters (`StaticConfiguration`). Accessible via the gear icon on connected instances in the PA Code Explorer.
- **Searchable Parameter Table**: Filter parameters by name with a real-time search box. Each parameter shows its name, current value, and data type (bool/number/string).
- **Inline Editing**: Click "Edit" on any parameter to change its value via a modal dialog with type-appropriate controls (dropdown for booleans, number input for numerics, text input for strings).
- **Auto Section Discovery**: Parameters are automatically mapped to their correct configuration section for updates, even for parameters using default values that don't appear in the config file.

## [1.4.2] - 2026-05-05

### Quickfix
- **Fixed Browser Launch Issue**: Added fallback paths to find Chrome/Edge in the user's `AppData\Local` directory, resolving "Failed to launch browser" errors in corporate environments.
- **SSL Certificate Bypass**: Automatically bypasses "Your connection is not private" (ERR_CERT_AUTHORITY_INVALID) warnings during the CAM login flow.

## [1.4.1] - 2026-05-04

### Authentication & API
- **Fixed CAM SSO Authentication**: Re-implemented the connection handshake to use protected endpoints (`/api/v1/ActiveUser`), ensuring that the "Connected" status is only granted if the CAM passport is actually valid.
- **Improved Error Visibility**: Added user-facing error notifications (popups) for all TM1 API failures. If a process or cube fails to load, the extension now displays the exact HTTP error and response body.
- **Raw Token Handling**: Optimized the CAM passport extraction to use raw URL-encoded tokens, fixing authentication issues on older Cognos/TM1 versions.

### UI & UX
- **Refined Syntax Highlighting**: Completely overhauled the TM1/TI syntax highlighting to provide a premium, high-contrast look.
  - **Colors**: Green comments, bright yellow functions, orange strings, purple keywords, and blue variables.
  - **Theming**: Implemented hardcoded token color overrides to guarantee consistent colors across all VS Code themes.

## [1.4.0] - 2026-04-29

### TM1 Rules Support
- **Syntax Highlighting for .rux files**: Full support for TM1 Rules with highlighting for Rule Qualifiers (`N:`, `C:`, `S:`), Section Keywords (`SKIPCHECK`, `FEEDSTRINGS`, `FEEDERS`), and area notations (`['Area']`, `!Dimension`).
- **Comprehensive Rule Functions**: Added highlighting for all standard Rule functions:
  - **Cube/Data**: `DB`, `ConsolidateChildren`.
  - **Logic**: `CONTINUE`, `STET`, `UNDEFVALS`.
  - **Math**: `ABS`, `MAX`, `MIN`, `MOD`, `ROUND`, `ROUNDP`, `SIGN`, `SQRT`, `EXP`, `LOG`, `SIN`, `COS`, `TAN`.
  - **String**: `CAPIT`, `LOWER`, `UPPER`, `SUBST`, `TRIM`, `STR`, `NUMBR`, `INSRT`.
  - **Date/Time**: `NOW`, `DAYNO`, `TIMST`, `TIMVL`.
  - **Metadata**: `DIMNM`, `DIMIX`, `DIMSZ`, `DNLEV`, `ELCOMP`, `ELCOMPN`, `ELISCOMP`, `ELISANC`, `ELPAR`, `ELLEV`, `ELWEIGHT`, `ATTRN`, `ATTRS`.

### Intelligent Development Features
- **Intelligent IntelliSense & Autocomplete**: Complete overhaul of the autocompletion engine.
  - **Full Function Library**: Support for all TI and Rule functions with detailed syntax tooltips.
  - **Dynamic Object Autocomplete**: Intelligent completion for Cubes, Dimensions, and Subsets directly from the server.
  - **Element Autocomplete**: Deep integration for element-level autocomplete within functions like `SubsetElementInsert` and `CellGet/CellPut`.
- **TurboIntegrator Code Formatter**: Standardized formatting for TI scripts. Automatically cleans up indentation, casing, and spacing across all procedure sections (Prolog, Metadata, Data, Epilog) with a press of Shift+ALT+F.

### Authentication & UI
- **CAM SSO / MFA Browser Login**: Integrated an interactive browser-based login for TM1 instances using Security Mode 5 (CAM). Supports corporate SSO redirects and multi-factor authentication (MFA).
- **Cognos/CAM Configuration**: Added dedicated fields for **Cognos URL** and **CAM Namespace** to ensure reliable redirection to corporate login portals.
- **Automatic CAM Detection**: The extension automatically detects CAM security and prompts for browser login when necessary.

## [1.3.0] - 2026-04-27

- Feature: **Process Parameter Popup** - When executing a TM1 process that has parameters defined, a webview panel now appears allowing you to set parameter values before running. Input fields are rendered per parameter type (Numeric/String) and styled using the active VS Code theme.
- Feature: **Push to TM1 Server (Create from Local File)** - Right-click any `.ti` file in the Explorer to push it directly to the connected TM1 server. If the process does not yet exist on the server, you are prompted to create it. The same prompt also appears automatically if you save a `.ti` file whose process cannot be found on the server (e.g. after copying and renaming a file).
- Feature: **Control Objects in Tree View** - Control objects (names starting with `}`) are now visible in dedicated **Control Processes** and **Control Cubes** folders in the PA Code Explorer, separate from normal objects.
- Feature: **Control Object Sync Selection** - When using "Pull All from Server", you can now choose whether to include Control Objects in the sync. If included, control processes are saved to a local `Control Processes` folder and control rules to a `Control Rules` folder, keeping them cleanly separated from normal objects.
- Feature: **Single Instance Connection Type** - A new "Single Instance (Host + Port)" option has been added to the Environment settings. This allows you to connect directly to a specific TM1 instance by host and HTTP port, bypassing the Admin Server discovery entirely. The Environment Name is used as the instance label in the Tree View.
- Feature: **TM1 Line Tracker (Status Bar)** - When a `.ti` file is open, the bottom status bar now shows the TM1-relative line number and procedure section for the current cursor position (e.g. `TM1: Prolog · Line 21`). The tracker correctly identifies `#JSON_PROPERTIES` as a separate block and does not count it as part of the Epilog.
- Feature: **Go to TM1 Line** - Click the TM1 status bar item (or run `Go to TM1 Line...` from the Command Palette) to jump directly to a specific line within a TM1 procedure section. After jumping, the target line is briefly highlighted using the editor's find-match color for easy visual confirmation.


## [1.2.8]
- Fix: **Settings Environments** - Replaced standard webview dialogs with native VS Code modals. This fixes an issue where the environment 'Delete' button and missing field warnings were silently ignored.

## [1.2.7]
- Feature: **Cloud Authentication Profiles** - Added an Authentication Method dropdown for Custom REST URL configurations. Simply set it up once as `IBM Cloud (Non-Interactive LDAP)` or `API Key / Token` in VSCode Workspace Settings, and let the extension automatically route, bypass the dialogs, and configure proper Cloud namespaces automatically.
- UI Enhancement: **Styled Settings Dropdowns** - Updated the dropdowns in the PA Code environments configuration panel to inherit the active VS Code theme colors (dark grey backgrounds, native borders), matching the rest of the native VS Code aesthetic perfectly.

## [1.2.6]
- Fix: **Custom REST URL Timeout** - Increased the connection timeout for checking TM1 instances via REST (including CAM security check) from 5 seconds to 15 seconds to be more robust. Also, fixed an issue where trailing slashes or `/api/v1` were improperly appended to URLs when calculating the REST endpoint, which resolves some connection failures.


## [1.2.5]
- Feature: **TM1 Cloud Connections** - Connect to IBM Cloud, AWS, and Azure TM1 instances using Custom REST API URLs with seamless API Key authentication support.
- Feature: **Inline Process Execution** - Run TM1 processes directly from the editor using the new inline "Run" CodeLens button.
- Feature: **Instance-Scoped Search** - The process and cube search button has been moved to the connect instance inline actions to improve search speeds and isolate results to a single TM1 server.
- Feature: **Clear Search** - When a search filter is active, a new "Clear Search" icon appears next to the instance, and the instance description updates to show the active filter string.

## [1.2.4] - 2026-03-04
### Added
- **Live TM1 Server Log Viewer**: View the live `tm1server.log` directly in a temporary VSCode tab by clicking the new output icon next to your connected TM1 instance in the tree view. The log updates automatically as new entries are written.

## [Unreleased]

- Initial release
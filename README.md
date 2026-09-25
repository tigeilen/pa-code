# PA-Code

**The Modern IDE for IBM Planning Analytics / TM1**

**Author: Tim Geilen**

PA-Code brings the power of a modern code editor to TM1 development. If you've been working in Architect or PAW to write TI processes and rules, PA Code gives you a faster, more organized workflow — with autocomplete, debugging, version control, and multi-instance management built right in.

No prior VS Code experience required. This guide will get you up and running.

---

## Getting Started

### What You Need

1. **VS Code** — Download free from [code.visualstudio.com](https://code.visualstudio.com/)
2. **PA Code Extension** — Install from the VS Code Marketplace (search "PA Code")
3. **Network access** to your TM1 server(s) (REST API port must be reachable)

Optional:
- **Git** — For version control and team collaboration ([git-scm.com](https://git-scm.com/))

### Step 1: Install PA Code

1. Open VS Code
2. Click the **Extensions** icon in the left sidebar (or press `Ctrl+Shift+X`)
3. Search for **"PA Code"**
4. Click **Install**

After installation, you'll see a new **PA Code icon** in the left activity bar — that's your main entry point.

### Step 2: Open a Folder for Your Local Files

PA Code stores every process and rule you pull as a **local file** on your computer, so VS Code needs an **open folder** to put them in. This step is easy to miss if you're new to VS Code — do it **before** configuring a connection.

1. Create an empty folder on your machine (e.g. `C:\TM1-Projects\MyModel`).
2. In VS Code, choose **File → Open Folder…** and select that folder.
3. VS Code reloads with your folder open — its name now appears in the **Explorer** on the left.

> **Why this matters**: Without an open folder, PA Code has nowhere to save the pulled `.ti` / `.rux` files, so pulling and opening won't work. Tip: use one folder per model/project and initialize Git in it for version control.

### Step 3: Configure Your TM1 Connection

1. Click the **PA Code icon** in the activity bar (left side)
2. In the sidebar that opens, click the **⚙️ gear icon** at the top
3. The Settings panel opens — here you add your TM1 environments:
   - **Name**: A label like `DEV` or `PROD`
   - **Connection Type**: Choose how to connect:
     - *Admin Host*: Auto-discovers all TM1 instances on a host
     - *Single Instance*: Direct connection to one server (URL + port)
     - *v12 Tenant*: For IBM Planning Analytics as a Service
   - **SSL**: Enable if your server uses HTTPS
   - **Authentication Method**: Basic, CAM Browser SSO, **Integrated Login (Windows / Security Mode 3)**, IBM Cloud, API Key or OAuth
   - **Request Timeout (ms)**: Increase for slow connections — default `15000` (15s); e.g. `30000` for 30s
4. Click **Save**

> **Tip**: You can configure multiple environments (DEV, TEST, PROD) to manage all your servers in one place.

### Step 4: Connect to Your Server

1. In the PA Code sidebar, expand your environment
2. You'll see your TM1 server(s) listed
3. Click the **plug icon** (or right-click → Connect)
4. Enter your credentials:
   - **Native Security**: Username + Password
   - **CAM Security**: Namespace + Username + Password
   - **Integrated Login (Security Mode 2/3)**: Windows Integrated auth — uses Kerberos SSO from your current Windows session (like Architect), with NTLM fallback using `DOMAIN\user` or `user@domain`
5. Once connected, the server icon turns green ✓

You're now connected! Your processes and rules are listed in the tree below.

---

## Your First Steps

### Opening a Process or Rule

Click any process name in the tree to open it. PA Code downloads the code from the server and opens it in the editor. You'll see:
- All four procedure sections (`Prolog`, `Metadata`, `Data`, `Epilog`) in one file
- Syntax highlighting for all TI functions
- A `► Run` and `🐛 Debug` button at the top (CodeLens)

### Editing and Saving

1. Make your changes in the editor
2. Press `Ctrl+S` to save

That's it. PA Code automatically:
- Saves the file locally on your disk
- Pushes the change to the TM1 server
- Validates the syntax and shows errors inline (red underline with message)

### Running a Process

Three ways to run a process:

1. **CodeLens button**: Click `► Run` at the top of the `.ti` file
2. **Tree view**: Right-click a process → Execute
3. **Recently Used**: Click the ► icon on any previously-run process in the sidebar

If the process has parameters, a form appears where you can fill them in. PA Code remembers your last used values.

### Debugging a Process

1. Click `🐛 Debug` at the top of a `.ti` file
2. Set parameter values if prompted
3. The debugger starts and pauses at the first line
4. Use the debug toolbar:
   - **F5** — Continue
   - **F10** — Step Over (next line)
   - **F11** — Step Into (sub-process)
   - **Shift+F5** — Stop
5. Watch variables update in real-time in the left panel

> Requires `EnableTIDebugging=T` on the server. PA Code will offer to enable it for you.

---

## The PA Code Sidebar

The sidebar (click the PA Code icon in the activity bar) is your central navigation:

| Section | What it does |
|---------|-------------|
| **Connections** | All your environments and servers. Connect, disconnect, browse objects. |
| **Recently Used** | Last opened processes/rules. Quick re-access and re-execution. |
| **Favorites** | Pin processes you use daily (click the ⭐ in the editor title bar). |
| **Quick Actions** | One-click access to Search, Server Log, Thread Viewer, Deployment, and more. |
| **TM1 Function Reference** | Searchable list of all 200+ TI/Rule functions. Click to insert. |

---

## Key Features

### IntelliSense & Autocomplete

As you type, PA Code suggests:
- All TI and Rule functions with syntax tooltips
- Cube names, dimension names, subsets, and elements from your server
- Variable names from your current file

### Server Log (Live)

Click the **📋 icon** next to a connected server to stream the `tm1server.log` in real-time. Use the "Load More" button in the status bar to scroll further back in history.

### Thread Viewer

Monitor all active TM1 threads with auto-refresh. See what's running, filter by user or function, and kill threads directly.

### Chore Manager

View and manage all scheduled chores in a table:
- Toggle active/inactive
- Execute on demand
- Create, edit, delete chores
- View execution history with duration and status

### Security Manager

Manage security groups and user assignments with a visual matrix table. Toggle memberships by clicking cells.

### MDX Wizard

Build MDX statements visually:
- **Subset Builder**: Pattern filters, attribute filters, set operations, sorting
- **View Builder**: Cube selection, axis assignment, per-dimension subsets

### Deployment Assistant

Transport processes and rules between instances (e.g., DEV → PROD):
1. Select source and target server
2. Search and select objects to deploy
3. Review changes with diff comparison
4. Deploy with one click

### Bulk Delete

Delete multiple objects at once (views, subsets, processes). Includes a Global Pattern Search to find objects matching wildcards across all cubes and dimensions.

### File Manager

Browse server files (Applications, Blobs, logs) via the REST API. Download files directly.

### TI Code Formatter

Press `Shift+Alt+F` to auto-format your TI code with consistent indentation, casing, and spacing.

---

## Keyboard Shortcuts

| Action | Windows/Linux | macOS |
|--------|---------------|-------|
| Search Processes | `Ctrl+Alt+F` | `⌘+⌥+F` |
| New Process | `Ctrl+Alt+N` | `⌘+⌥+N` |
| Pull All from Server | `Ctrl+Alt+P` | `⌘+⌥+P` |
| Server Log | `Ctrl+Alt+L` | `⌘+⌥+L` |
| Thread Viewer | `Ctrl+Alt+T` | `⌘+⌥+T` |
| Deployment Assistant | `Ctrl+Alt+D` | `⌘+⌥+D` |
| Format Code | `Shift+Alt+F` | `⇧+⌥+F` |
| Toggle Comment | `Ctrl+#` | `⌘+#` |
| Save (& push to server) | `Ctrl+S` | `⌘+S` |

---

## Working with Git (Optional)

PA Code works perfectly without Git — you can just connect, edit, and save. But if you want version control and team collaboration, Git adds:

- **History**: See who changed what and when
- **Branching**: Work on features without affecting others
- **Code Review**: Merge Requests before deploying to production
- **CI/CD**: Automated deployments via GitLab/GitHub pipelines

### Basic Git Workflow

```bash
# Create a branch for your task
git checkout -b feature/new-calculation

# After making changes, commit them
git add .
git commit -m "Added margin calculation to Finance cube"
git push
```

Then create a Merge Request in your Git platform to deploy to the next environment.

---

## AI Support

PA Code works with any AI coding assistant available in VS Code:
- **GitHub Copilot** — Code completion and generation for TI/Rules
- **Other AI providers** — Any VS Code-compatible AI extension

The AI understands TM1 syntax and can help you write processes, debug issues, and generate boilerplate code.

### Built-in MCP Server (live model context for AI tools)

PA Code ships a built-in, **read-only** [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI agents live context about your connected TM1 model (cubes, dimensions, processes, rules) — 23 tools, `tm1://` resources and ready-made prompts. It runs in-process and reuses your existing authenticated connection.

- **GitHub Copilot (Agent mode)** — works out of the box once `PA Code › Mcp Server: Enabled` is on; the TM1 tools appear automatically.
- **Other AI tools** (Claude Code / Claude Desktop, Codex, Cline, Continue, Cursor, …) — run **`PA Code: Show MCP Endpoint (for external AI tools)`** from the Command Palette to copy a ready-to-use config (HTTP `mcpServers` JSON, a Claude Code CLI command, or a stdio-bridge command for stdio-only clients).

For a stable URL to configure once, set a fixed port via `PA Code › Mcp Server: Port` (e.g. `3900`). The server always binds to `127.0.0.1` only and requires a bearer token on every request.

---

## Security & Privacy

PA Code is built for corporate environments:
- **Zero telemetry** — No data leaves your machine
- **Zero credential storage** — Passwords are never saved to disk
- **Local only** — All communication goes directly from your machine to your TM1 server

For full details, see our [Security & Privacy Policy](https://github.com/tigeilen/pa-code/blob/main/SECURITY.md).

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Can't connect to server | Check that the REST API port is reachable from your machine. Verify SSL settings match your server. |
| Save fails with 404 | Server may be unreachable or the object was deleted/renamed. |
| No processes visible | Make sure you're connected (green icon). Try right-click → Refresh. |
| Debugger won't start | Ensure `EnableTIDebugging=T` is set in the server configuration. |
| Autocomplete not showing server objects | You need an active connection. Disconnect and reconnect if needed. |

---

## Support

For questions, bug reports, or feature requests, please contact the author or open an issue on the project repository.

---

## Contributing

PA Code is an open-source **community project** — contributions are very welcome!
See [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started (build, test, and the
lightweight **DCO** sign-off we use instead of a CLA).

## License

PA Code is licensed under the **[Apache License 2.0](LICENSE)** — a permissive,
enterprise-friendly license that includes an explicit patent grant. This means
you (and your company) can freely use, review, and build on the extension; see
[LICENSE](LICENSE) and [NOTICE](NOTICE) for details.

Copyright 2026 Tim Geilen and the PA Code contributors.


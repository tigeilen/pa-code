# pa-code
**DevOps Platform for IBM Planning Analytics**

**Author: Tim Geilen**

This project provides a complete integrated development environment (IDE) and deployment pipeline for IBM Planning Analytics (TM1). It enables versioned development (Git), multi-instance management, and automated deployments (CI/CD).

---

## 🚀 Features

### VS Code Extension (pa-code)
*   **Instance Hub**: Tile-based navigation panel for connected instances — opens automatically after connecting. Organized into Develop, Monitor, Deploy, Administration, and Connection categories with Google Material icons and keyboard shortcuts.
*   **PA Code Sidebar**: Dedicated activity bar with organized sections — Connections, Recently Used, Favorites, Quick Actions, and TM1 Function Reference. Quick Actions provide one-click access to all major features.
*   **Live Connection**: Support for multiple TM1 instances (Native & CAM Security). On Premises, Cloud & v12 Tenant (Multi-Database) connections.
*   **Settings UI**: Easily configure and manage all your TM1 instances through a user-friendly Webview panel (accessible via the ⚙️ gear icon).
*   **Object Explorer**: Tree view for instances, processes, rules, and control objects — organized in dedicated folders with inline search per folder.
*   **Execute Processes**: Run TI processes directly from the explorer tree or with the inline `► Run` CodeLens button inside local `.ti` files. Supports process parameters via an interactive popup. Shows a real-time elapsed timer during execution with a cancel button to abort running processes. Automatically fetches and opens `TM1ProcessError*.log` files if errors or warnings occur! Previously executed processes appear in the "Recently Used" sidebar — processes with parameters show a ► icon to re-run with the last used values.
*   **Chore Manager**: Full-featured panel for managing TM1 scheduled chores. View all chores in a sortable table, toggle active status, execute on-demand, and create/edit/delete chores with a modal dialog. Supports ISO 8601 frequency configuration, task management with parameter editing, and execution history tracking.
*   **Security Manager**: Manage TM1 security groups and user assignments with a user-group matrix table. Toggle group membership by clicking cells, create/delete groups and users, and filter by name.
*   **MDX Wizard**: Visual MDX builder with two modes — Subset Builder and View Builder. Build MDX subsets with pattern filters, attribute filters, set operations, and sorting. Build MDX views with cube selection, axis assignment (drag & drop), per-dimension subset definitions, and Suppress Zeroes. Live MDX preview.
*   **File Manager**: Browse TM1 server files via REST API. Navigate Applications, Blobs, model_upload, and logs folders with breadcrumb-style navigation. View and download files.
*   **Bulk Delete**: Bulk-delete TM1 objects (Processes, Views, Subsets) with object type selection, search, sort, and checkbox-based multi-select.
*   **Favorites**: Pin frequently-used processes to the Favorites sidebar section for quick access.
*   **TI Process Debugger**: Full-featured native debugger using VS Code's Debug UI. Set breakpoints, step through code (Step Over, Step Into, Step Out, Continue), inspect variables in real time, and view the call stack — all powered by the TM1 REST API's debug endpoints. Click the `🐛 Debug` CodeLens button to start.
*   **Server Configuration**: View and edit TM1 server configuration parameters directly from VS Code. Accessible via the gear icon on connected instances. Search, filter, and modify parameters with type-appropriate controls.
*   **Deployment Assistant**: Transport TI processes and rules between TM1 instances with a guided 3-step wizard. Select source and target from connected instances, search and multi-select objects (blue tags for processes, orange for rules), review Create/Update status on the target with line-level diff statistics, compare code side-by-side in VS Code's diff editor, and deploy with one click. Optional transport logging saves full before & after code to JSON files.
*   **Thread Viewer**: Real-time thread monitoring panel showing all active TM1 threads with auto-refresh (3s). Sortable columns, search/filter, and kill threads directly — either via a per-row kill button or by entering a thread ID manually.
*   **IntelliSense & Autocomplete**: Full function library for all TI and Rule functions with detailed syntax tooltips, plus dynamic autocomplete for Cubes, Dimensions, Subsets, and Elements directly from the server.
*   **TM1 Function Reference Panel**: Searchable sidebar panel listing all TI and Rule functions organized by category (200+ functions across 20+ categories). Click any function to insert it at the cursor with a ready-to-use snippet including tab-stop parameters. Use the search icon to filter by name.
*   **TI Code Formatter**: Standardized formatting for TI scripts. Automatically cleans up indentation, casing, and spacing across all procedure sections with `Shift+Alt+F`.
*   **Rules Support**: Full syntax highlighting for `.rux` files including Rule Qualifiers, Section Keywords, area notations, and all standard Rule functions. Automatic syntax checking via `tm1.CheckRules` on save with inline error diagnostics.
*   **Variable Hover**: Hovering over a variable in a `.ti` file shows all assignments with source line and line number. Click "Go to definition" to jump to the assignment with a brief line highlight.
*   **Live Server Logs**: View the `tm1server.log` live in VSCode! Click the output icon next to any connected instance to stream logs dynamically.
*   **Comment Toggle**: Use `Ctrl+#` (or `Cmd+#` on Mac) to toggle line comments in TM1 files.
*   **Hot-Path**: Saving (`Ctrl+S`) immediately sends changes to the connected server (including syntax checks). On syntax errors, the editor jumps directly to the offending line with inline error diagnostics.
*   **Push to TM1**: Right-click any `.ti` file in the Explorer to push it to the server. If the process doesn't exist, you're prompted to create it.
*   **Local Workspace**: Synchronizes TM1 objects into a clean folder structure (`/Processes`, `/Rules`, `/Control Processes`, `/Control Rules`).
*   **TM1 Line Tracker**: Status bar shows the TM1-relative line number and procedure section for the current cursor position (e.g. `TM1: Prolog · Line 21`). Click it to jump to a specific TM1 line.

### AI Support - use your favorite AI provider in VSCode (e.g. GitHub Copilot, OpenAI, etc.)
*   **Code Completion**: Get code completion suggestions for TM1 processes and rules.
*   **Code Generation**: Generate code for TM1 processes and rules.
*   **Debugging Support**: Debug code for TM1 processes and rules.

### Git Support - use your favorite Git provider (e.g. GitLab, GitHub, etc.)
*   **Versioning**: Full version control of TI processes and rules.
*   **Feature-Branch Workflow**: Supports modern branching strategies.
*   **CI/CD Pipeline (GitLab/GitHub)**: Automated deployments to Dev, Test, and Prod.
*   **Intelligent Deployment**:
    *   *Selective*: Detects modified instances.
    *   *Upsert*: Creates or updates objects and manages parameters/datasources.

---

## 🛡️ Enterprise Security & Compliance
PA-Code is built for corporate environments with **zero telemetry** and **zero credential storage**. For full details and information on corporate audits, please review our [Security & Privacy Policy](https://github.com/tigeilen/pa-code/blob/main/SECURITY.md).

---


## 🛠 Installation & Setup

### Prerequisites
*   [VS Code](https://code.visualstudio.com/)
*   [Git](https://git-scm.com/)
*   Access to your Git repository

### 1. Install Extension from marketplace

### 2. Clone Repository (Optional)
Open a terminal and clone the project:

```bash
git clone <REPOSITORY_URL>
cd <REPOSITORY_NAME>
code .
```

### Configuration (Environments)
Click on the **⚙️ Settings Gear** icon in the "PA Code" extension view header to open the Configuration UI. Here you configure the top-level **Environments** (e.g. `DEV`, `PROD`).
*(Alternatively, you can manually create/edit the `tm1-project.json` file in the root directory).*

```json
{
  "environments": [
    {
      "name": "DEV",
      "folder": "DEV_Workspace",
      "adminHost": "your-admin-host.com",
      "port": 5898,
      "ssl": true
    }
  ]
}
```

### Dynamic Server Discovery & Login
Once an environment is configured, the extension **automatically queries the Admin Host** to discover all running TM1 Server instances (e.g., `24_retail`, `Finance`) underneath it.
1. Expand the Environment in the `PA Code` tree view to list all discovered servers.
2. Right-click a specific server and select **Connect**.
3. The extension dynamically detects the authentication mode:
   * **Native Security**: Prompts for `Username` and `Password`.
   * **CAM Security**: Explicitly prompts for your `Namespace` first, followed by `Username` and `Password`.

### Local File Structure
When you download or sync files, `PA Code` automatically creates a structured local folder hierarchy based on the target system:
`Workspace Root` / `Environment Folder` / `Server Name` / `Processes` (or `Rules`).

---

## 💻 Daily Workflow

### 1. Connect & Synchronize
1.  Click the **Connect Icon** (plug) next to your instance in the **TM1 Extension Sidebar** (left).
2.  Enter your User and Password.
3.  *(Optional)* Right-click the instance -> **"Pull All from Server"** to update your local workspace with the latest state from TM1.

### 2. Develop
Create a new branch for your task:

```bash
git checkout -b feature/my-new-feature
```

1.  Open a process or a rule from the tree view.
2.  Edit the code.
3.  Press `Ctrl + S`.
    *   ✅ **Extension**: Immediately saves to the server and validates syntax.
    *   ✅ **File**: Saves changes locally to your hard drive.

### 3. Process Execution & Debugging
**Run** a process by clicking the **► Run** CodeLens button at the top of a `.ti` file or the Play button in the tree view. If the process has parameters, a popup appears to set their values.
If the process fails, the extension automatically retrieves the error log from the TM1 server and opens it in a tab.

**Debug** a process by clicking the **🐛 Debug** CodeLens button at the top of a `.ti` file:
1.  Set parameter values (if any) in the popup.
2.  The debug session starts and pauses at the first line.
3.  Open the **Run & Debug** sidebar (`Ctrl+Shift+D`) to see:
    *   **Variables**: All TI variables with live values.
    *   **Call Stack**: Current procedure section and sub-process hierarchy.
    *   **Breakpoints**: Manage all your breakpoints.
4.  Use the debug toolbar: **Continue** (F5), **Step Over** (F10), **Step Into** (F11), **Step Out** (Shift+F11), or **Stop** (Shift+F5).
5.  Set breakpoints by clicking in the gutter (left of line numbers).

> **Note**: TI debugging requires `EnableTIDebugging=T` on the server. The extension will offer to enable it automatically if needed.

### 4. Instance Hub & Keyboard Shortcuts
After connecting to an instance, the **Instance Hub** opens automatically. It provides quick access to all instance actions via tiles. You can also use global keyboard shortcuts:

| Action | Windows/Linux | macOS |
|---|---|---|
| Search Processes | `Ctrl+Alt+F` | `⌘+⌥+F` |
| New Process | `Ctrl+Alt+N` | `⌘+⌥+N` |
| Pull All from Server | `Ctrl+Alt+P` | `⌘+⌥+P` |
| Server Log | `Ctrl+Alt+L` | `⌘+⌥+L` |
| Thread Viewer | `Ctrl+Alt+T` | `⌘+⌥+T` |
| Deployment Assistant | `Ctrl+Alt+D` | `⌘+⌥+D` |

### 5. Server Configuration
Click the **⚙️ gear icon** on a connected instance in the PA Code Explorer to open the **Server Configuration** panel. Here you can view, search, and edit all TM1 server parameters (e.g., `EnableTIDebugging`, `MaximumViewSize`, `MTQ`).

### 6. Deployment (GitLab/GitHub)
Commit your changes:

```bash
git add .
git commit -m "Logic for new calculation added"
git push origin feature/my-new-feature
```

1.  Create a **Merge Request** in GitLab targeting `dev` (or `test`).
2.  Once merged, the **Pipeline** will automatically start and deploy the changes.

---

## 📂 Project Structure

The repository is organized by environments and their discovered servers:

```text
/ (Root)
├── tm1-project.json       # PA Code configuration file
├── .gitlab-ci.yml         # Pipeline definitions (Optional)
├── scripts/               # Python deployment logic (Optional)
│   └── deploy_processes.py
│
└── DEV_Workspace/         # Folder for Environment (e.g. DEV)
    ├── Finance/           # Folder for Server "Finance"
    │   ├── Processes/     # All .ti files for this server
    │   │   └── Update_Dim.ti
    │   └── Rules/         # All .rux files for this server
    │       └── Revenue.rux
    │
    └── HR/                # Folder for Server "HR"
        ├── Processes/
        └── Rules/
```

---

## ❓ Troubleshooting

*   **Extension won't connect**: Check the Settings UI (or `tm1-project.json`) for correct ports and SSL settings.
*   **Save failed (404)**: The server might be unreachable or the object was deleted.

---


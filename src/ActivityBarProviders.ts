import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export class ActivityBarItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly itemPath: string,
        public readonly instanceName: string,
        public readonly itemType: 'process' | 'rule',
        public readonly timestamp?: number,
        public readonly hasLastParams?: boolean
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        const serverName = instanceName.split('_').slice(1).join('_') || instanceName;
        let envName = instanceName.split('_')[0];
        try {
            const config = ConfigManager.getConfig();
            for (const env of config.environments || []) {
                if (instanceName.startsWith(env.name + '_')) {
                    envName = env.name;
                    break;
                }
            }
        } catch { /* config not available */ }
        const resolvedServerName = instanceName.substring(envName.length + 1);
        this.description = resolvedServerName || serverName;
        this.tooltip = `${label} (${serverName})`;
        this.iconPath = itemType === 'process'
            ? new vscode.ThemeIcon('file-code')
            : new vscode.ThemeIcon('law');
        this.contextValue = hasLastParams ? 'recentItem_hasParams' : 'recentItem';

        this.command = {
            command: 'pa-code.openProcess',
            title: 'Open',
            arguments: [envName, instanceName, label as string]
        };
    }
}

// ---- RECENTLY USED ----

export class RecentItemsProvider implements vscode.TreeDataProvider<ActivityBarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActivityBarItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: { label: string; path: string; instanceName: string; type: 'process' | 'rule'; timestamp: number }[] = [];
    private lastParamsMap: { [key: string]: any[] } = {};
    private static readonly MAX_ITEMS = 25;
    private context: vscode.ExtensionContext | undefined;

    setContext(ctx: vscode.ExtensionContext) {
        this.context = ctx;
        this.items = ctx.globalState.get<typeof this.items>('pa-code.recentItems') || [];
        this.lastParamsMap = ctx.globalState.get<typeof this.lastParamsMap>('pa-code.recentLastParams') || {};
    }

    addItem(label: string, filePath: string, instanceName: string, type: 'process' | 'rule' = 'process') {
        // Remove duplicate if exists
        this.items = this.items.filter(i => !(i.label === label && i.instanceName === instanceName));
        // Add to front
        this.items.unshift({ label, path: filePath, instanceName, type, timestamp: Date.now() });
        // Trim
        if (this.items.length > RecentItemsProvider.MAX_ITEMS) {
            this.items = this.items.slice(0, RecentItemsProvider.MAX_ITEMS);
        }
        this._persist();
        this._onDidChangeTreeData.fire();
    }

    clear() {
        this.items = [];
        this.lastParamsMap = {};
        this._persist();
        this._onDidChangeTreeData.fire();
    }

    saveLastParams(processName: string, instanceName: string, params: any[]) {
        const key = `${instanceName}::${processName}`;
        this.lastParamsMap[key] = params;
        this._persist();
        this._onDidChangeTreeData.fire();
    }

    getLastParams(processName: string, instanceName: string): any[] | undefined {
        const key = `${instanceName}::${processName}`;
        return this.lastParamsMap[key];
    }

    private _persist() {
        if (this.context) {
            this.context.globalState.update('pa-code.recentItems', this.items);
            this.context.globalState.update('pa-code.recentLastParams', this.lastParamsMap);
        }
    }

    getTreeItem(element: ActivityBarItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<ActivityBarItem[]> {
        if (this.items.length === 0) {
            const empty = new vscode.TreeItem('No recent items');
            empty.iconPath = new vscode.ThemeIcon('history');
            return [empty as any];
        }
        return this.items.map(i => {
            const key = `${i.instanceName}::${i.label}`;
            const hasParams = !!this.lastParamsMap[key];
            return new ActivityBarItem(i.label, i.path, i.instanceName, i.type, i.timestamp, hasParams);
        });
    }
}

// ---- FAVORITES ----

export class FavoritesProvider implements vscode.TreeDataProvider<ActivityBarItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ActivityBarItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private items: { label: string; path: string; instanceName: string; type: 'process' | 'rule' }[] = [];
    private context: vscode.ExtensionContext | undefined;

    setContext(ctx: vscode.ExtensionContext) {
        this.context = ctx;
        this.items = ctx.globalState.get<typeof this.items>('pa-code.favorites') || [];
    }

    addItem(label: string, filePath: string, instanceName: string, type: 'process' | 'rule' = 'process') {
        if (this.items.some(i => i.label === label && i.instanceName === instanceName)) return;
        this.items.push({ label, path: filePath, instanceName, type });
        this.items.sort((a, b) => a.label.localeCompare(b.label));
        this._persist();
        this._onDidChangeTreeData.fire();
    }

    removeItem(label: string, instanceName: string) {
        this.items = this.items.filter(i => !(i.label === label && i.instanceName === instanceName));
        this._persist();
        this._onDidChangeTreeData.fire();
    }

    private _persist() {
        if (this.context) {
            this.context.globalState.update('pa-code.favorites', this.items);
        }
    }

    getTreeItem(element: ActivityBarItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<ActivityBarItem[]> {
        if (this.items.length === 0) {
            const empty = new vscode.TreeItem('No favorites yet — right-click a process to add');
            empty.iconPath = new vscode.ThemeIcon('star-empty');
            return [empty as any];
        }
        return this.items.map(i => new ActivityBarItem(i.label, i.path, i.instanceName, i.type));
    }
}

// ---- QUICK ACTIONS ----

class QuickActionItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly actionCommand: string,
        icon: string,
        description?: string,
        shortcut?: string
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon(icon);
        this.description = shortcut || '';
        this.tooltip = description || label;
        this.command = { command: actionCommand, title: label };
    }
}

export class QuickActionsProvider implements vscode.TreeDataProvider<QuickActionItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<QuickActionItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh() { this._onDidChangeTreeData.fire(); }

    getTreeItem(element: QuickActionItem): vscode.TreeItem { return element; }

    async getChildren(): Promise<QuickActionItem[]> {
        const connected = TM1Service.getInstance().getConnectedInstanceNames();
        if (connected.length === 0) {
            const empty = new vscode.TreeItem('Connect to an instance first');
            empty.iconPath = new vscode.ThemeIcon('plug');
            return [empty as any];
        }

        const svc = TM1Service.getInstance();
        const impersonating = connected.some(n => !!svc.getImpersonation(n));
        return [
            new QuickActionItem('Search Objects', 'pa-code.shortcutSearch', 'search', 'Search for a process', 'Ctrl+Alt+F'),
            new QuickActionItem('Create Process', 'pa-code.shortcutCreateProcess', 'add', 'Create a new TI process', 'Ctrl+Alt+N'),
            new QuickActionItem('Pull All from Server', 'pa-code.shortcutPullAll', 'cloud-download', 'Sync all processes locally', 'Ctrl+Alt+P'),
            new QuickActionItem('Deployment Assistant', 'pa-code.shortcutDeployment', 'rocket', 'Open cross-environment deployment', 'Ctrl+Alt+D'),
            new QuickActionItem('Server Log', 'pa-code.shortcutServerLog', 'output', 'View TM1 server log', 'Ctrl+Alt+L'),
            new QuickActionItem('Thread Viewer', 'pa-code.shortcutThreadViewer', 'pulse', 'View active threads', 'Ctrl+Alt+T'),
            new QuickActionItem('TI Console', 'pa-code.shortcutTiConsole', 'terminal', 'Run a one-liner TI statement'),
            new QuickActionItem('Impersonate User', 'pa-code.impersonateUser', 'account', 'View TM1 as another user (admin, v11)'),
            ...(impersonating ? [new QuickActionItem('Stop Impersonating', 'pa-code.stopImpersonating', 'debug-stop', 'Return to your own session')] : []),
            new QuickActionItem('Bulk Delete', 'pa-code.bulkDelete', 'trash', 'Bulk delete processes, views or subsets'),
            new QuickActionItem('Security Manager', 'pa-code.securityPanel', 'shield', 'Manage user-group assignments'),
            new QuickActionItem('MDX Wizard', 'pa-code.mdxWizard', 'symbol-misc', 'Visual MDX query builder'),
            new QuickActionItem('Chore Manager', 'pa-code.choreManager', 'clock', 'Manage scheduled chores'),
            new QuickActionItem('Settings', 'pa-code.manageSettings', 'gear', 'Edit environment configuration'),
        ];
    }
}

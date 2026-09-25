import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export class TM1TreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'environment' | 'instance' | 'folder' | 'process' | 'cube'
            | 'dimension' | 'hierarchy' | 'subset' | 'view' | 'subfolder',
        public readonly environmentName: string,
        public readonly instanceName: string,
        public contextValue: string,
        public readonly serverPort?: number,
        public readonly serverSsl?: boolean,
        public readonly cubeName?: string,
        public readonly dimensionName?: string,
        public readonly hierarchyName?: string,
        public readonly subsetName?: string
    ) {
        super(label, collapsibleState);
    }
}

export class ProcessProvider implements vscode.TreeDataProvider<TM1TreeItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<TM1TreeItem | undefined | null | void> = new vscode.EventEmitter<TM1TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TM1TreeItem | undefined | null | void> = this._onDidChangeTreeData.event;
    private filters: Map<string, string> = new Map();
    private folderFilters: Map<string, string> = new Map();

    constructor() { }
    refresh(): void { this._onDidChangeTreeData.fire(); }

    private getInstanceIcon(instanceId: string): vscode.ThemeIcon {
        const tm1 = TM1Service.getInstance();
        if (!tm1.isConnected(instanceId)) {
            return new vscode.ThemeIcon('circle-outline');
        }
        return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    }

    private getAdminBadge(instanceId: string, connectionType: string): string {
        const tm1 = TM1Service.getInstance();
        if (!tm1.isConnected(instanceId) || !tm1.getAdminStatus(instanceId)) {
            return '';
        }
        return connectionType === 'v12Tenant' ? '✦' : '★';
    }

    setFilter(instanceName: string, text: string): void {
        this.filters.set(instanceName, text);
        this.refresh();
    }
    getInstanceFilter(instanceName: string): string {
        return this.filters.get(instanceName) || '';
    }
    setFolderFilter(instanceName: string, folderLabel: string, text: string): void {
        const key = `${instanceName}|${folderLabel}`;
        if (text) {
            this.folderFilters.set(key, text);
        } else {
            this.folderFilters.delete(key);
        }
        this.refresh();
    }
    getFolderFilter(instanceName: string, folderLabel: string): string {
        return this.folderFilters.get(`${instanceName}|${folderLabel}`) || '';
    }
    // Per-folder filter keys for the Views/Subsets subfolders. Scoped by cube (or
    // dim+hier) so each folder searches independently. Used by the search commands.
    static viewsFilterKey(cube: string): string { return `cube_views\u0000${cube}`; }
    static subsetsFilterKey(dim: string, hier: string): string { return `hierarchy_subsets\u0000${dim}\u0000${hier}`; }
    getTreeItem(element: TM1TreeItem): vscode.TreeItem { return element; }

    private makeDimensionItem(environmentName: string, instanceName: string, dimName: string): TM1TreeItem {
        const item = new TM1TreeItem(dimName, vscode.TreeItemCollapsibleState.Collapsed, 'dimension', environmentName, instanceName, 'tm1dimension', undefined, undefined, undefined, dimName);
        item.iconPath = new vscode.ThemeIcon('symbol-class');
        item.command = { command: 'pa-code.subsetEditor', title: 'Open in Subset Editor', arguments: [item] };
        return item;
    }

    private makeCubeItem(environmentName: string, instanceName: string, cubeName: string): TM1TreeItem {
        const item = new TM1TreeItem(cubeName, vscode.TreeItemCollapsibleState.Collapsed, 'cube', environmentName, instanceName, 'tm1cube', undefined, undefined, cubeName);
        item.iconPath = new vscode.ThemeIcon('package');
        return item;
    }

    private makeProcessItem(environmentName: string, instanceName: string, processName: string): TM1TreeItem {
        const item = new TM1TreeItem(processName, vscode.TreeItemCollapsibleState.None, 'process', environmentName, instanceName, 'tm1process');
        item.iconPath = new vscode.ThemeIcon('gear');
        item.command = { command: 'pa-code.openProcess', title: 'Open', arguments: [environmentName, instanceName, processName] };
        return item;
    }

    async getChildren(element?: TM1TreeItem): Promise<TM1TreeItem[]> {
        const tm1 = TM1Service.getInstance();

        // LEVEL 1: ENVIRONMENTS
        if (!element) {
            if (!vscode.workspace.workspaceFolders) return [];
            try {
                const config = ConfigManager.getConfig();
                return (config.environments || []).map((env: any) => {
                    const item = new TM1TreeItem(
                        env.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'environment',
                        env.name,
                        '',
                        'tm1environment'
                    );
                    item.iconPath = new vscode.ThemeIcon('server');
                    return item;
                });
            } catch (e) { return []; }
        }

        // LEVEL 2: SERVERS (Instances)
        if (element.type === 'environment') {
            try {
                const config = ConfigManager.getConfig();
                const env = config.environments.find(e => e.name === element.environmentName);
                if (!env) return [];

                if (env.connectionType === 'customUrl') {
                    const instanceName = env.name;
                    const instanceId = `${env.name}_${instanceName}`;
                    const isConnected = tm1.isConnected(instanceId);
                    const item = new TM1TreeItem(
                        instanceName,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'instance',
                        env.name,
                        instanceId,
                        isConnected ? 'tm1instance_connected' : 'tm1instance_disconnected'
                    );

                    const activeFilter = this.filters.get(instanceId);
                    const badge = this.getAdminBadge(instanceId, env.connectionType);
                    if (activeFilter && isConnected) {
                        item.description = `${badge} (Filtered: ${activeFilter})`.trim();
                        item.contextValue = 'tm1instance_connected_filtered';
                    } else if (badge) {
                        item.description = badge;
                    }

                    item.iconPath = this.getInstanceIcon(instanceId);
                    return [item];
                } else if (env.connectionType === 'singleInstance') {
                    const instanceName = env.name;
                    const instanceId = `${env.name}_${instanceName}`;
                    const isConnected = tm1.isConnected(instanceId);
                    const item = new TM1TreeItem(
                        instanceName,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'instance',
                        env.name,
                        instanceId,
                        isConnected ? 'tm1instance_connected' : 'tm1instance_disconnected',
                        env.port,
                        env.ssl !== false
                    );
                    
                    const activeFilter = this.filters.get(instanceId);
                    const badge = this.getAdminBadge(instanceId, env.connectionType);
                    if (activeFilter && isConnected) {
                        item.description = `${badge} (Filtered: ${activeFilter})`.trim();
                        item.contextValue = 'tm1instance_connected_filtered';
                    } else if (badge) {
                        item.description = badge;
                    }

                    item.iconPath = this.getInstanceIcon(instanceId);
                    return [item];
                } else if (env.connectionType === 'v12Tenant') {
                    const instanceId = `${env.name}_${env.name}`;
                    const isConnected = tm1.isConnected(instanceId);
                    const item = new TM1TreeItem(
                        env.name,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'instance',
                        env.name,
                        instanceId,
                        isConnected ? 'tm1instance_connected' : 'tm1instance_disconnected'
                    );

                    const activeFilter = this.filters.get(instanceId);
                    const badge = this.getAdminBadge(instanceId, env.connectionType);
                    if (activeFilter && isConnected) {
                        item.description = `${badge} (Filtered: ${activeFilter})`.trim();
                        item.contextValue = 'tm1instance_connected_filtered';
                    } else if (badge) {
                        item.description = badge;
                    }

                    item.iconPath = this.getInstanceIcon(instanceId);
                    return [item];
                } else {
                    let servers: { Name: string, Port: number, SSL: boolean }[] = [];
                    try {
                        servers = await tm1.getServersFromAdminHost(env.adminHost || '', env.port || 5898, env.ssl !== false);
                    } catch {
                        // Admin host unreachable — show a placeholder, don't spam error messages
                        const placeholder = new TM1TreeItem(
                            '(Admin Host unreachable — click to retry)',
                            vscode.TreeItemCollapsibleState.None,
                            'instance',
                            env.name,
                            '',
                            'tm1instance_disconnected'
                        );
                        placeholder.iconPath = new vscode.ThemeIcon('warning');
                        return [placeholder];
                    }
                    return servers.map(s => {
                        const instanceId = `${env.name}_${s.Name}`;
                        const isConnected = tm1.isConnected(instanceId);
                        const item = new TM1TreeItem(
                            s.Name,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            'instance',
                            env.name,
                            instanceId,
                            isConnected ? 'tm1instance_connected' : 'tm1instance_disconnected',
                            s.Port,
                            s.SSL
                        );

                        const activeFilter = this.filters.get(instanceId);
                        const badge = this.getAdminBadge(instanceId, env.connectionType);
                        if (activeFilter && isConnected) {
                            item.description = `${badge} (Filtered: ${activeFilter})`.trim();
                            item.contextValue = 'tm1instance_connected_filtered';
                        } else if (badge) {
                            item.description = badge;
                        }

                        item.iconPath = this.getInstanceIcon(instanceId);

                        return item;
                    });
                }
            } catch (e: any) {
                // Silently handle — admin host errors already handled above
                return [];
            }
        }

        // LEVEL 3: ORDNER (standard TM1 developer layout)
        if (element.type === 'instance') {
            if (!tm1.isConnected(element.instanceName)) return [];

            const folders: { label: string; contextValue: string; icon: string }[] = [
                { label: 'Cubes', contextValue: 'folder_cubes', icon: 'package' },
                { label: 'Dimensions', contextValue: 'folder_dimensions', icon: 'type-hierarchy' },
                { label: 'Processes', contextValue: 'folder_processes', icon: 'gear' },
                { label: 'Chores', contextValue: 'folder_chores', icon: 'watch' },
                { label: 'Control Objects', contextValue: 'folder_control', icon: 'settings-gear' }
            ];

            return folders.map(f => {
                const folderFilter = this.getFolderFilter(element.instanceName, f.label);
                const item = new TM1TreeItem(f.label, vscode.TreeItemCollapsibleState.Collapsed, 'folder', element.environmentName, element.instanceName, f.contextValue);
                item.iconPath = new vscode.ThemeIcon(f.icon);
                if (folderFilter) {
                    item.description = `🔍 ${folderFilter}`;
                    item.contextValue = f.contextValue + '_filtered';
                }
                return item;
            });
        }

        // CONTROL OBJECTS -> Cubes / Dimensions / Processes
        if (element.type === 'folder' && (element.label as string) === 'Control Objects') {
            const mk = (label: string, ctx: string, icon: string) => {
                const it = new TM1TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, 'subfolder', element.environmentName, element.instanceName, ctx);
                it.iconPath = new vscode.ThemeIcon(icon);
                const ff = this.getFolderFilter(element.instanceName, ctx);
                if (ff) {
                    it.description = `🔍 ${ff}`;
                    it.contextValue = ctx + '_filtered';
                }
                return it;
            };
            return [
                mk('Cubes', 'control_cubes', 'package'),
                mk('Dimensions', 'control_dimensions', 'type-hierarchy'),
                mk('Processes', 'control_processes', 'gear')
            ];
        }

        // LEVEL 3: ITEMS
        if (element.type === 'folder') {
            const instanceName = element.instanceName;
            const folderLabel = element.label as string;
            const instanceFilter = this.filters.get(instanceName) || '';
            const folderFilter = this.getFolderFilter(instanceName, folderLabel);
            const combinedFilter = folderFilter || instanceFilter;

            if (folderLabel === 'Processes') {
                try {
                    const procs = await tm1.getProcesses(instanceName, 'normal');
                    let filtered = procs;
                    if (combinedFilter) {
                        filtered = procs.filter(p => p.Name.toLowerCase().includes(combinedFilter.toLowerCase()));
                    }
                    return filtered.map(p => this.makeProcessItem(element.environmentName, instanceName, p.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch processes: ${error.message}`);
                    return [];
                }
            }
            else if (folderLabel === 'Cubes') {
                try {
                    const cubes = await tm1.getCubes(instanceName, 'normal');
                    let filtered = cubes;
                    if (combinedFilter) {
                        filtered = cubes.filter(c => c.Name.toLowerCase().includes(combinedFilter.toLowerCase()));
                    }
                    return filtered.map(c => this.makeCubeItem(element.environmentName, instanceName, c.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch cubes: ${error.message}`);
                    return [];
                }
            }
            else if (folderLabel === 'Dimensions') {
                try {
                    const dims = await tm1.getDimensions(instanceName);
                    let filtered = dims.filter(d => !d.Name.startsWith('}'));
                    if (combinedFilter) {
                        filtered = filtered.filter(d => d.Name.toLowerCase().includes(combinedFilter.toLowerCase()));
                    }
                    return filtered.map(d => this.makeDimensionItem(element.environmentName, instanceName, d.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch dimensions: ${error.message}`);
                    return [];
                }
            }
            else if (folderLabel === 'Chores') {
                try {
                    const chores = await tm1.getChores(instanceName);
                    let filtered = chores;
                    if (combinedFilter) {
                        filtered = chores.filter((c: any) => (c.Name || '').toLowerCase().includes(combinedFilter.toLowerCase()));
                    }
                    return filtered.map((c: any) => {
                        const item = new TM1TreeItem(c.Name, vscode.TreeItemCollapsibleState.None, 'process', element.environmentName, instanceName, 'tm1chore');
                        item.iconPath = new vscode.ThemeIcon('watch');
                        item.command = { command: 'pa-code.choreManager', title: 'Open Chore Manager', arguments: [element] };
                        return item;
                    });
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch chores: ${error.message}`);
                    return [];
                }
            }
        }

        // LEVEL 4: CUBE CHILDREN (Dimensions / Views / Rules)
        if (element.type === 'cube') {
            const cubeName = element.cubeName || (element.label as string);
            const dimsFolder = new TM1TreeItem('Dimensions', vscode.TreeItemCollapsibleState.Collapsed, 'subfolder', element.environmentName, element.instanceName, 'cube_dimensions', undefined, undefined, cubeName);
            dimsFolder.iconPath = new vscode.ThemeIcon('type-hierarchy');
            const viewsFolder = new TM1TreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed, 'subfolder', element.environmentName, element.instanceName, 'cube_views', undefined, undefined, cubeName);
            viewsFolder.iconPath = new vscode.ThemeIcon('table');
            const vFilt = this.getFolderFilter(element.instanceName, ProcessProvider.viewsFilterKey(cubeName));
            if (vFilt) { viewsFolder.contextValue = 'cube_views_filtered'; viewsFolder.description = `(Filtered: ${vFilt})`; }
            const rulesItem = new TM1TreeItem(cubeName, vscode.TreeItemCollapsibleState.None, 'view', element.environmentName, element.instanceName, 'tm1rule', undefined, undefined, cubeName);
            rulesItem.iconPath = new vscode.ThemeIcon('symbol-ruler');
            rulesItem.description = 'Rules';
            rulesItem.command = { command: 'pa-code.openRule', title: 'Open Rule', arguments: [element.environmentName, element.instanceName, cubeName] };
            return [dimsFolder, viewsFolder, rulesItem];
        }

        // LEVEL 5: SUBFOLDER CONTENTS
        if (element.type === 'subfolder') {
            const instanceName = element.instanceName;
            // Control subfolders carry a per-category search filter keyed by their
            // base contextValue (so it never collides with the top-level folders).
            const baseCtx = (element.contextValue || '').replace(/_filtered$/, '');
            const instanceFilter = this.filters.get(instanceName) || '';
            const controlFilter = (this.getFolderFilter(instanceName, baseCtx) || instanceFilter).toLowerCase();
            // Control Objects -> Cubes
            if (baseCtx === 'control_cubes') {
                try {
                    const cubes = await tm1.getCubes(instanceName, 'control');
                    const filtered = controlFilter ? cubes.filter(c => c.Name.toLowerCase().includes(controlFilter)) : cubes;
                    return filtered.map(c => this.makeCubeItem(element.environmentName, instanceName, c.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch control cubes: ${error.message}`);
                    return [];
                }
            }
            // Control Objects -> Dimensions
            if (baseCtx === 'control_dimensions') {
                try {
                    const dims = await tm1.getDimensions(instanceName);
                    let filtered = dims.filter(d => d.Name.startsWith('}'));
                    if (controlFilter) filtered = filtered.filter(d => d.Name.toLowerCase().includes(controlFilter));
                    return filtered.map(d => this.makeDimensionItem(element.environmentName, instanceName, d.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch control dimensions: ${error.message}`);
                    return [];
                }
            }
            // Control Objects -> Processes
            if (baseCtx === 'control_processes') {
                try {
                    const procs = await tm1.getProcesses(instanceName, 'control');
                    const filtered = controlFilter ? procs.filter(p => p.Name.toLowerCase().includes(controlFilter)) : procs;
                    return filtered.map(p => this.makeProcessItem(element.environmentName, instanceName, p.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch control processes: ${error.message}`);
                    return [];
                }
            }
            // Cube -> Dimensions
            if (baseCtx === 'cube_dimensions' && element.cubeName) {
                try {
                    const dims = await tm1.getCubeDimensions(instanceName, element.cubeName);
                    return dims.map(d => this.makeDimensionItem(element.environmentName, instanceName, d.Name));
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch cube dimensions: ${error.message}`);
                    return [];
                }
            }
            // Cube -> Views
            if (baseCtx === 'cube_views' && element.cubeName) {
                try {
                    const views = await tm1.getViews(instanceName, element.cubeName);
                    const vFilter = this.getFolderFilter(instanceName, ProcessProvider.viewsFilterKey(element.cubeName)).toLowerCase();
                    const filtered = vFilter ? views.filter(v => v.Name.toLowerCase().includes(vFilter)) : views;                    return filtered.map(v => {
                        const item = new TM1TreeItem(v.Name, vscode.TreeItemCollapsibleState.None, 'view', element.environmentName, instanceName, 'tm1view', undefined, undefined, element.cubeName);
                        item.iconPath = new vscode.ThemeIcon(v.isPrivate ? 'lock' : 'preview');
                        if (v.isPrivate) { item.description = 'private'; }
                        item.command = { command: 'pa-code.openCubeView', title: 'Open View', arguments: [element.environmentName, instanceName, element.cubeName, v.Name] };
                        return item;
                    });
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch views: ${error.message}`);
                    return [];
                }
            }
            // Hierarchy -> Subsets
            if (baseCtx === 'hierarchy_subsets' && element.dimensionName && element.hierarchyName) {
                try {
                    const subsets = await tm1.getHierarchySubsets(instanceName, element.dimensionName, element.hierarchyName);
                    const sFilter = this.getFolderFilter(instanceName, ProcessProvider.subsetsFilterKey(element.dimensionName, element.hierarchyName)).toLowerCase();
                    const filtered = sFilter ? subsets.filter(s => s.Name.toLowerCase().includes(sFilter)) : subsets;
                    return filtered.map(s => {
                        const item = new TM1TreeItem(s.Name, vscode.TreeItemCollapsibleState.None, 'subset', element.environmentName, instanceName, 'tm1subset', undefined, undefined, undefined, element.dimensionName, element.hierarchyName, s.Name);
                        item.iconPath = new vscode.ThemeIcon('list-flat');
                        item.command = { command: 'pa-code.subsetEditor', title: 'Open Subset', arguments: [item] };
                        return item;
                    });
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Failed to fetch subsets: ${error.message}`);
                    return [];
                }
            }
            return [];
        }

        // LEVEL: DIMENSION -> HIERARCHIES
        if (element.type === 'dimension') {
            const dimName = element.dimensionName || (element.label as string);
            try {
                const hiers = await tm1.getHierarchies(element.instanceName, dimName);
                // If only one hierarchy with the same name, jump straight to its Subsets folder
                return hiers.map(h => {
                    const item = new TM1TreeItem(h.Name, vscode.TreeItemCollapsibleState.Collapsed, 'hierarchy', element.environmentName, element.instanceName, 'tm1hierarchy', undefined, undefined, undefined, dimName, h.Name);
                    item.iconPath = new vscode.ThemeIcon('type-hierarchy');
                    item.command = { command: 'pa-code.subsetEditor', title: 'Open in Subset Editor', arguments: [item] };
                    return item;
                });
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to fetch hierarchies: ${error.message}`);
                return [];
            }
        }

        // LEVEL: HIERARCHY -> Subsets folder
        if (element.type === 'hierarchy') {
            const subsetsFolder = new TM1TreeItem('Subsets', vscode.TreeItemCollapsibleState.Collapsed, 'subfolder', element.environmentName, element.instanceName, 'hierarchy_subsets', undefined, undefined, undefined, element.dimensionName, element.hierarchyName);
            subsetsFolder.iconPath = new vscode.ThemeIcon('list-tree');
            const sFilt = this.getFolderFilter(element.instanceName, ProcessProvider.subsetsFilterKey(element.dimensionName || '', element.hierarchyName || ''));
            if (sFilt) { subsetsFolder.contextValue = 'hierarchy_subsets_filtered'; subsetsFolder.description = `(Filtered: ${sFilt})`; }
            return [subsetsFolder];
        }
        return [];
    }
}
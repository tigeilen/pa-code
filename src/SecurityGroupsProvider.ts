import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';

export class SecurityTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly itemType: 'instance' | 'group' | 'user',
        public readonly instanceName: string,
        public readonly groupName?: string
    ) {
        super(label, collapsibleState);

        if (itemType === 'instance') {
            this.iconPath = new vscode.ThemeIcon('server');
            this.contextValue = 'securityInstance';
        } else if (itemType === 'group') {
            this.iconPath = new vscode.ThemeIcon('organization');
            this.contextValue = 'securityGroup';
        } else {
            this.iconPath = new vscode.ThemeIcon('person');
            this.contextValue = 'securityUser';
        }
    }
}

export class SecurityGroupsProvider implements vscode.TreeDataProvider<SecurityTreeItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<SecurityTreeItem | undefined | null | void> = new vscode.EventEmitter<SecurityTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<SecurityTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private cache: Map<string, { Name: string; Users: { Name: string; FriendlyName?: string }[] }[]> = new Map();

    refresh(): void {
        this.cache.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: SecurityTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: SecurityTreeItem): Promise<SecurityTreeItem[]> {
        const tm1 = TM1Service.getInstance();

        // Root level: list connected instances
        if (!element) {
            const connected = tm1.getConnectedInstanceNames();
            if (connected.length === 0) {
                return [new SecurityTreeItem('No connected instances', vscode.TreeItemCollapsibleState.None, 'instance', '')];
            }
            return connected.map(name =>
                new SecurityTreeItem(name, vscode.TreeItemCollapsibleState.Collapsed, 'instance', name)
            );
        }

        // Instance level: list security groups
        if (element.itemType === 'instance') {
            try {
                let groups = this.cache.get(element.instanceName);
                if (!groups) {
                    groups = await tm1.getSecurityGroups(element.instanceName);
                    this.cache.set(element.instanceName, groups);
                }
                return groups.map(g => {
                    const userCount = g.Users ? g.Users.length : 0;
                    const item = new SecurityTreeItem(
                        g.Name,
                        userCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        'group',
                        element.instanceName,
                        g.Name
                    );
                    item.description = `${userCount} user${userCount !== 1 ? 's' : ''}`;
                    return item;
                });
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to load security groups: ${err.message}`);
                return [];
            }
        }

        // Group level: list users
        if (element.itemType === 'group' && element.groupName) {
            const groups = this.cache.get(element.instanceName);
            if (groups) {
                const group = groups.find(g => g.Name === element.groupName);
                if (group && group.Users) {
                    return group.Users
                        .sort((a, b) => a.Name.localeCompare(b.Name))
                        .map(u => {
                            const item = new SecurityTreeItem(
                                u.Name,
                                vscode.TreeItemCollapsibleState.None,
                                'user',
                                element.instanceName,
                                element.groupName
                            );
                            if (u.FriendlyName && u.FriendlyName !== u.Name) {
                                item.description = u.FriendlyName;
                            }
                            return item;
                        });
                }
            }
            return [];
        }

        return [];
    }
}

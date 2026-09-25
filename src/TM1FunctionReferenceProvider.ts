import * as vscode from 'vscode';
import { TM1_FUNCTION_DATABASE, TM1FunctionCategory, TM1Function } from './TM1FunctionDatabase';

export class TM1FunctionReferenceProvider implements vscode.TreeDataProvider<FunctionTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<FunctionTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private filterText = '';

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    setFilter(text: string): void {
        this.filterText = text.toLowerCase();
        this.refresh();
    }

    clearFilter(): void {
        this.filterText = '';
        this.refresh();
    }

    getTreeItem(element: FunctionTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: FunctionTreeItem): FunctionTreeItem[] {
        if (!element) {
            // Root level: show categories
            const categories = TM1_FUNCTION_DATABASE.filter(cat => {
                if (!this.filterText) return true;
                // Show category if its name matches or any function matches
                return cat.name.toLowerCase().includes(this.filterText) ||
                    cat.functions.some(f => f.name.toLowerCase().includes(this.filterText));
            });
            return categories.map(cat => new FunctionTreeItem(
                cat.name,
                `${cat.description} [${cat.context.toUpperCase()}]`,
                vscode.TreeItemCollapsibleState.Collapsed,
                'category',
                undefined,
                cat
            ));
        }

        if (element.type === 'category' && element.category) {
            let functions = element.category.functions;
            if (this.filterText) {
                functions = functions.filter(f => f.name.toLowerCase().includes(this.filterText));
            }
            return functions.map(fn => new FunctionTreeItem(
                fn.name,
                fn.syntax,
                vscode.TreeItemCollapsibleState.None,
                'function',
                fn,
                undefined
            ));
        }

        return [];
    }
}

export class FunctionTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly detail: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'category' | 'function',
        public readonly func?: TM1Function,
        public readonly category?: TM1FunctionCategory
    ) {
        super(label, collapsibleState);

        if (type === 'category' && category) {
            this.tooltip = `${category.description}\nContext: ${category.context === 'ti' ? 'TurboIntegrator' : category.context === 'rule' ? 'Rules' : 'Both'}`;
            this.description = `(${category.functions.length})`;
            this.iconPath = new vscode.ThemeIcon('symbol-class');
            this.contextValue = 'tm1FunctionCategory';
        } else if (type === 'function' && func) {
            this.tooltip = new vscode.MarkdownString(
                `**${func.name}**\n\n\`\`\`\n${func.syntax}\n\`\`\`\n\n${func.description}\n\n*Context: ${func.context === 'ti' ? 'TI Only' : func.context === 'rule' ? 'Rules Only' : 'TI & Rules'}*`
            );
            this.description = func.syntax.replace(func.name, '').replace(/^\(/, '(');
            this.iconPath = new vscode.ThemeIcon('symbol-function');
            this.contextValue = 'tm1Function';
            // Click inserts the snippet
            this.command = {
                command: 'pa-code.insertFunction',
                title: 'Insert Function',
                arguments: [func]
            };
        }
    }
}

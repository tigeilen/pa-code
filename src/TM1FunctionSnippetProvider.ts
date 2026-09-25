import * as vscode from 'vscode';
import { TM1_FUNCTION_DATABASE, TM1Function } from './TM1FunctionDatabase';

/**
 * Provides snippet-based completions for TM1 functions.
 * When the user types a partial function name (e.g., "AttrP"),
 * this provider suggests matching functions with full syntax as snippets.
 */
export class TM1FunctionSnippetProvider implements vscode.CompletionItemProvider {

    private allFunctions: TM1Function[];
    private completionItems: vscode.CompletionItem[];

    constructor() {
        // Flatten all functions from all categories
        this.allFunctions = [];
        for (const category of TM1_FUNCTION_DATABASE) {
            for (const fn of category.functions) {
                this.allFunctions.push(fn);
            }
        }

        // Pre-build completion items
        this.completionItems = this.allFunctions.map(fn => {
            const item = new vscode.CompletionItem(fn.name, vscode.CompletionItemKind.Function);
            item.detail = fn.syntax;
            item.documentation = new vscode.MarkdownString(
                `${fn.description}\n\n**Context:** ${fn.context === 'ti' ? 'TurboIntegrator' : fn.context === 'rule' ? 'Rules' : 'TI & Rules'}`
            );
            item.insertText = new vscode.SnippetString(fn.snippet);
            item.sortText = `0_${fn.name}`; // Sort functions first
            return item;
        });
    }

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken,
        _context: vscode.CompletionContext
    ): vscode.CompletionItem[] | undefined {
        // Only activate for TM1 files
        if (!document.fileName.endsWith('.ti') && !document.fileName.endsWith('.pro') && !document.fileName.endsWith('.rux')) {
            return undefined;
        }

        const lineText = document.lineAt(position).text;
        const textBefore = lineText.substring(0, position.character);

        // Don't trigger inside strings (let the existing completion provider handle that)
        const singleQuoteCount = (textBefore.match(/'/g) || []).length;
        if (singleQuoteCount % 2 !== 0) {
            return undefined;
        }

        // Don't trigger inside comments
        if (textBefore.trimStart().startsWith('#')) {
            return undefined;
        }

        // Get the word being typed
        const wordMatch = textBefore.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
        if (!wordMatch || wordMatch[0].length < 2) {
            return undefined;
        }

        // Filter by file type context
        const isRule = document.fileName.endsWith('.rux');
        const isTI = document.fileName.endsWith('.ti') || document.fileName.endsWith('.pro');

        if (isRule) {
            return this.completionItems.filter(item => {
                const fn = this.allFunctions.find(f => f.name === item.label);
                return fn && (fn.context === 'rule' || fn.context === 'both');
            });
        } else if (isTI) {
            return this.completionItems.filter(item => {
                const fn = this.allFunctions.find(f => f.name === item.label);
                return fn && (fn.context === 'ti' || fn.context === 'both');
            });
        }

        return this.completionItems;
    }
}

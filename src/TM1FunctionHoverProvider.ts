import * as vscode from 'vscode';
import { TM1_FUNCTION_DATABASE, TM1Function } from './TM1FunctionDatabase';

/**
 * Hover documentation for TM1 functions in TI (.ti/.pro) and Rules (.rux) files:
 * hovering a known function name shows its syntax, description and context.
 */
export class TM1FunctionHoverProvider implements vscode.HoverProvider {
    private byName = new Map<string, TM1Function[]>();

    constructor() {
        for (const cat of TM1_FUNCTION_DATABASE) {
            for (const fn of cat.functions) {
                const key = fn.name.toLowerCase();
                const list = this.byName.get(key) || [];
                list.push(fn);
                this.byName.set(key, list);
            }
        }
    }

    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
        const name = document.fileName;
        if (!name.endsWith('.ti') && !name.endsWith('.pro') && !name.endsWith('.rux')) return undefined;

        const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!range) return undefined;
        const word = document.getText(range);
        const list = this.byName.get(word.toLowerCase());
        if (!list || !list.length) return undefined;

        const isRule = name.endsWith('.rux');
        const wanted = isRule ? 'rule' : 'ti';
        const fn = list.find(f => f.context === wanted) || list.find(f => f.context === 'both') || list[0];

        const ctx = fn.context === 'ti' ? 'TI only' : fn.context === 'rule' ? 'Rules only' : 'TI & Rules';
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${fn.name}**\n\n`);
        md.appendCodeblock(fn.syntax, 'tm1');
        md.appendMarkdown(`\n${fn.description}\n\n*Context: ${ctx}*`);
        return new vscode.Hover(md, range);
    }
}

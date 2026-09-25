import * as vscode from 'vscode';
import { TM1_FUNCTION_DATABASE, TM1Function } from './TM1FunctionDatabase';

/**
 * Shows the signature (parameter list) of the TM1 function whose call the cursor
 * is inside, with the current argument highlighted. Works in both TI (.ti/.pro)
 * and Rules (.rux) files, driven by the shared function database.
 */
export class TM1SignatureHelpProvider implements vscode.SignatureHelpProvider {
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

    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.SignatureHelp | undefined {
        const name = document.fileName;
        if (!name.endsWith('.ti') && !name.endsWith('.pro') && !name.endsWith('.rux')) return undefined;

        // Scan the statement text before the cursor to find the enclosing call.
        const start = new vscode.Position(Math.max(0, position.line - 40), 0);
        const text = document.getText(new vscode.Range(start, position));
        const call = this.findEnclosingCall(text);
        if (!call) return undefined;

        const fn = this.pickFunction(call.name, name.endsWith('.rux'));
        if (!fn) return undefined;

        const params = this.parseParams(fn.syntax);
        const sig = new vscode.SignatureInformation(
            fn.syntax.replace(/;\s*$/, ''),
            new vscode.MarkdownString(`${fn.description}\n\n*Context: ${fn.context === 'ti' ? 'TI only' : fn.context === 'rule' ? 'Rules only' : 'TI & Rules'}*`)
        );
        sig.parameters = params.map(p => new vscode.ParameterInformation(p));

        const help = new vscode.SignatureHelp();
        help.signatures = [sig];
        help.activeSignature = 0;
        help.activeParameter = params.length ? Math.min(call.argIndex, params.length - 1) : 0;
        return help;
    }

    // Forward-scan the window, tracking strings/comments and a stack of open
    // calls, so the top of the stack at the cursor is the enclosing call.
    private findEnclosingCall(text: string): { name: string; argIndex: number } | undefined {
        const stack: { name: string; commas: number }[] = [];
        let inString = false, inComment = false;
        let ident = '', lastIdent = '', gapOnlySpace = true;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inComment) { if (ch === '\n') inComment = false; continue; }
            if (inString) { if (ch === "'") inString = false; continue; }
            if (ch === "'") { inString = true; lastIdent = ''; ident = ''; continue; }
            if (ch === '#') { inComment = true; continue; }
            if (/[A-Za-z0-9_]/.test(ch)) { ident += ch; continue; }
            if (ident) { lastIdent = ident; ident = ''; gapOnlySpace = true; }
            if (ch === '(') {
                stack.push({ name: gapOnlySpace ? lastIdent : '', commas: 0 });
                lastIdent = '';
            } else if (ch === ')') {
                stack.pop();
            } else if (ch === ',') {
                if (stack.length) stack[stack.length - 1].commas++;
            } else if (ch === ';') {
                stack.length = 0; lastIdent = '';
            }
            if (ch !== ' ' && ch !== '\t' && ch !== '\r' && ch !== '\n') gapOnlySpace = false;
        }
        const top = stack[stack.length - 1];
        if (!top || !top.name) return undefined;
        return { name: top.name, argIndex: top.commas };
    }

    private pickFunction(name: string, isRule: boolean): TM1Function | undefined {
        const list = this.byName.get(name.toLowerCase());
        if (!list || !list.length) return undefined;
        const wanted = isRule ? 'rule' : 'ti';
        return list.find(f => f.context === wanted) || list.find(f => f.context === 'both') || list[0];
    }

    // Extract the comma-separated parameter labels from a syntax string like
    // "DB(CubeName, El1, El2, ...ElN);".
    private parseParams(syntax: string): string[] {
        const open = syntax.indexOf('(');
        if (open < 0) return [];
        let depth = 0, inner = '';
        for (let i = open; i < syntax.length; i++) {
            const ch = syntax[i];
            if (ch === '(') { depth++; if (depth === 1) continue; }
            else if (ch === ')') { depth--; if (depth === 0) break; }
            inner += ch;
        }
        inner = inner.trim();
        if (!inner) return [];
        const parts: string[] = [];
        let buf = '', d = 0;
        for (const ch of inner) {
            if (ch === '[' || ch === '(') d++;
            else if (ch === ']' || ch === ')') d--;
            if (ch === ',' && d === 0) { parts.push(buf.trim()); buf = ''; }
            else buf += ch;
        }
        if (buf.trim()) parts.push(buf.trim());
        return parts;
    }
}

import * as vscode from 'vscode';

/**
 * Hover provider for TI (.ti) files.
 * Shows how a variable was defined/assigned in the current script.
 */
export class TM1HoverProvider implements vscode.HoverProvider {

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {
        // Only for .ti files
        if (!document.fileName.endsWith('.ti')) return undefined;

        // Get the word under cursor
        const wordRange = document.getWordRangeAtPosition(position, /[a-zA-ZäöüÄÖÜß_][a-zA-ZäöüÄÖÜß0-9_]*/);  
        if (!wordRange) return undefined;
        const word = document.getText(wordRange);

        // Skip section headers and very short tokens
        if (word.length < 2) return undefined;
        if (/^(SECTION|JSON_PROPERTIES|Prolog|Metadata|Data|Epilog)$/i.test(word)) return undefined;

        // Scan document for assignments to this variable
        const assignmentPattern = new RegExp(
            `^\\s*${this._escapeRegex(word)}\\s*=\\s*(.+)`,
            'i'
        );

        const assignments: { line: number; text: string }[] = [];
        for (let i = 0; i < document.lineCount; i++) {
            const lineText = document.lineAt(i).text;
            const match = lineText.match(assignmentPattern);
            if (match) {
                // Make sure it's the exact variable name, not a substring
                const beforeEq = lineText.substring(0, lineText.indexOf('=')).trim();
                if (beforeEq.toLowerCase() === word.toLowerCase()) {
                    assignments.push({ line: i + 1, text: lineText.trim() });
                }
            }
        }

        if (assignments.length === 0) return undefined;

        // Don't show hover if cursor is on the only definition line itself (left side of =)
        const cursorLine = document.lineAt(position.line).text;
        const eqIndex = cursorLine.indexOf('=');
        if (eqIndex > 0 && position.character < eqIndex) {
            const leftSide = cursorLine.substring(0, eqIndex).trim();
            if (leftSide.toLowerCase() === word.toLowerCase() && assignments.length === 1) {
                return undefined;
            }
        }

        const md = new vscode.MarkdownString();
        md.isTrusted = true;

        if (assignments.length === 1) {
            const a = assignments[0];
            const jumpArgs = encodeURIComponent(JSON.stringify(a.line - 1));
            md.appendCodeblock(a.text, 'tm1');
            md.appendMarkdown(`[Line ${a.line} — Go to definition](command:pa-code.jumpToLine?${jumpArgs})`);
        } else {
            for (const a of assignments) {
                const jumpArgs = encodeURIComponent(JSON.stringify(a.line - 1));
                md.appendCodeblock(a.text, 'tm1');
                md.appendMarkdown(`[Line ${a.line} — Go to definition](command:pa-code.jumpToLine?${jumpArgs})\n\n`);
            }
        }

        return new vscode.Hover(md, wordRange);
    }

    private _escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

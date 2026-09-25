import * as vscode from 'vscode';

/**
 * Suggests the process' own variables while typing in TI code (.ti/.pro) — the
 * identifiers assigned earlier in the code, plus parameters and datasource
 * variables from #JSON_PROPERTIES — mirroring the variable list PAW offers.
 */
export class TM1VariableCompletionProvider implements vscode.CompletionItemProvider {

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] | undefined {
        const name = document.fileName;
        if (!name.endsWith('.ti') && !name.endsWith('.pro')) return undefined;

        const before = document.lineAt(position).text.substring(0, position.character);
        // Not inside a string or a comment line.
        if ((before.match(/'/g) || []).length % 2 !== 0) return undefined;
        if (before.trimStart().startsWith('#')) return undefined;
        // Only while typing an identifier.
        if (!/[A-Za-z_]\w*$/.test(before)) return undefined;

        const vars = TM1VariableCompletionProvider.collectVariables(document.getText());
        if (!vars.length) return undefined;
        return vars.map(v => {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.Variable);
            item.detail = v.value ? `= ${v.value}` : 'TI variable';
            item.documentation = new vscode.MarkdownString(v.value ? `Process variable\n\n\`${v.name} = ${v.value}\`` : 'Process variable / parameter');
            item.insertText = v.name;
            item.sortText = `0_${v.name}`; // list variables before functions
            return item;
        });
    }

    // Collect assigned variables (name + first assigned value), parameters and
    // datasource variables. Assignments are `identifier = …` (not ==, >=, etc.).
    private static collectVariables(text: string): { name: string; value?: string }[] {
        const map = new Map<string, string | undefined>();
        const jsonIdx = text.search(/#JSON_PROPERTIES/i);
        const codePart = jsonIdx >= 0 ? text.slice(0, jsonIdx) : text;
        for (const raw of codePart.split('\n')) {
            if (raw.trimStart().startsWith('#')) continue;
            const m = /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*(.*?)\s*;?\s*$/.exec(raw);
            if (m) {
                const value = (m[2] || '').trim();
                if (!map.has(m[1])) map.set(m[1], value || undefined);
            }
        }
        const jsonMatch = text.match(/#JSON_PROPERTIES\s*([\s\S]*?)$/i);
        if (jsonMatch) {
            try {
                const props = JSON.parse(jsonMatch[1].trim());
                for (const p of props.Parameters || []) if (p?.Name && !map.has(p.Name)) map.set(p.Name, undefined);
                for (const v of props.Variables || []) if (v?.Name && !map.has(v.Name)) map.set(v.Name, undefined);
            } catch { /* ignore malformed JSON */ }
        }
        return [...map.entries()].map(([name, value]) => ({ name, value }));
    }
}

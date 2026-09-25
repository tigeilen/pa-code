import * as vscode from 'vscode';

export class TM1Formatter implements vscode.DocumentFormattingEditProvider {

    provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
        const original = document.getText();
        const formatted = this.format(original);
        if (original === formatted) return [];
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(original.length)
        );
        return [vscode.TextEdit.replace(fullRange, formatted)];
    }

    private format(text: string): string {
        const lines = text.split(/\r?\n/);
        const result: string[] = [];
        let indentLevel = 0;
        let inJsonBlock = false;
        let lastWasBlank = false;

        for (const rawLine of lines) {
            const trimmed = rawLine.trim();

            // JSON block - preserve exactly as-is
            if (/^#JSON_PROPERTIES/i.test(trimmed)) {
                inJsonBlock = true;
                while (result.length > 0 && result[result.length - 1].trim() === '') {
                    result.pop();
                }
                result.push('');
                result.push(trimmed);
                lastWasBlank = false;
                continue;
            }
            if (inJsonBlock) {
                result.push(rawLine);
                continue;
            }

            // Section headers - no indentation, reset indent
            if (/^#SECTION\s+/i.test(trimmed)) {
                while (result.length > 0 && result[result.length - 1].trim() === '') {
                    result.pop();
                }
                if (result.length > 0) result.push('');
                result.push(trimmed);
                result.push('');
                indentLevel = 0;
                lastWasBlank = true;
                continue;
            }

            // Empty line - max 1 consecutive blank
            if (trimmed === '') {
                if (!lastWasBlank) {
                    result.push('');
                    lastWasBlank = true;
                }
                continue;
            }
            lastWasBlank = false;

            const upper = trimmed.toUpperCase();
            // Strip trailing semicolons/whitespace for keyword detection only
            const stripped = upper.replace(/;+\s*$/, '').trim();

            // --- Dedent BEFORE adding these closing keywords ---
            if (/^ENDIF\b/.test(stripped) ||
                /^NEXT(\s*\(|\s*$)/.test(stripped) ||
                /^END\s*$/.test(stripped)) {
                indentLevel = Math.max(0, indentLevel - 1);
            } else if (/^ELSE(IF\s*\(|IF\b|\s*$)/.test(stripped)) {
                // ELSE and ELSEIF both dedent before and indent after
                indentLevel = Math.max(0, indentLevel - 1);
            }

            // Add line with current indentation
            result.push('  '.repeat(indentLevel) + trimmed);

            // --- Indent AFTER these opening keywords ---
            if (/^IF\s*\(/.test(stripped)) {
                indentLevel++;
            } else if (/^ELSE(IF\s*\(|IF\b|\s*$)/.test(stripped)) {
                indentLevel++;
            } else if (/^FOR\s+\w+/.test(stripped)) {
                indentLevel++;
            } else if (/^WHILE\s*\(/.test(stripped)) {
                indentLevel++;
            }
        }

        return result.join('\n');
    }
}

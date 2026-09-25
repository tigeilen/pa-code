import * as vscode from 'vscode';

/**
 * Folding for pa-code TI (.ti) process files.
 *
 * Provides two kinds of foldable ranges:
 *  1. The top-level process sections written by pa-code:
 *     `#SECTION Prolog`, `#SECTION Metadata`, `#SECTION Data`,
 *     `#SECTION Epilog` and the trailing `#JSON_PROPERTIES` block
 *     (parameters / data source / variables).
 *  2. `#Region ... #EndRegion` blocks (case-insensitive), mirroring the
 *     foldable regions users know from Planning Analytics Workspace. These
 *     nest correctly inside the sections.
 */
export class TM1FoldingProvider implements vscode.FoldingRangeProvider {
    private static readonly SECTION_RE = /^\s*#SECTION\b|^\s*#JSON_PROPERTIES\b/i;
    private static readonly REGION_START_RE = /^\s*#region\b/i;
    private static readonly REGION_END_RE = /^\s*#endregion\b/i;
    // TM1 / PAW generated code blocks: "#****Begin: …" … "#****End: …"
    private static readonly GEN_START_RE = /^\s*#\*+\s*Begin:/i;
    private static readonly GEN_END_RE = /^\s*#\*+\s*End:/i;

    provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        _token: vscode.CancellationToken
    ): vscode.FoldingRange[] {
        const ranges: vscode.FoldingRange[] = [];
        const sectionStarts: number[] = [];
        const regionStack: number[] = [];
        let genStart: number | undefined;
        const lineCount = document.lineCount;

        for (let i = 0; i < lineCount; i++) {
            const text = document.lineAt(i).text;
            if (TM1FoldingProvider.SECTION_RE.test(text)) {
                sectionStarts.push(i);
            }
            if (TM1FoldingProvider.REGION_START_RE.test(text)) {
                regionStack.push(i);
            } else if (TM1FoldingProvider.REGION_END_RE.test(text)) {
                const start = regionStack.pop();
                if (start !== undefined && i > start) {
                    ranges.push(new vscode.FoldingRange(start, i, vscode.FoldingRangeKind.Region));
                }
            }

            // Generated-statements blocks (single level; a Begin is closed by the next End).
            if (TM1FoldingProvider.GEN_START_RE.test(text)) {
                genStart = i;
            } else if (TM1FoldingProvider.GEN_END_RE.test(text) && genStart !== undefined) {
                if (i > genStart) {
                    ranges.push(new vscode.FoldingRange(genStart, i, vscode.FoldingRangeKind.Region));
                }
                genStart = undefined;
            }
        }

        // Each section folds from its marker to the line before the next marker
        // (or the end of the document for the last one).
        for (let s = 0; s < sectionStarts.length; s++) {
            const start = sectionStarts[s];
            const end = s + 1 < sectionStarts.length ? sectionStarts[s + 1] - 1 : lineCount - 1;
            if (end > start) {
                ranges.push(new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Region));
            }
        }

        return ranges;
    }
}

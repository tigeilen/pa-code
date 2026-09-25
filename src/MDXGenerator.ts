// ============================================================
// MDXGenerator — Builds MDX strings from UI configuration
// ============================================================

export interface FilterConfig {
    type: 'pattern' | 'attribute' | 'value';
    pattern?: string;
    attributeName?: string;
    operator?: '=' | '<>' | 'CONTAINS';
    value?: string;
    // value filter specific
    cube?: string;
    measure?: string;  // kept for backwards compat
    tupleElements?: { dimension: string; element: string }[];
    valueOperator?: '>' | '<' | '>=' | '<=' | '=' | '<>';
    threshold?: string;
    thresholdType?: 'numeric' | 'string';
}

export interface SortConfig {
    type: 'none' | 'alphabetic' | 'hierarchic' | 'byvalue' | 'byindex' | 'byattribute';
    direction: 'ASC' | 'DESC' | 'BASC' | 'BDESC';
    cube?: string;
    measure?: string;
    attributeName?: string;
}

export interface HeadTailConfig {
    type: 'none' | 'head' | 'tail';
    count: number;
}

export interface SetOperationConfig {
    type: 'union' | 'intersect' | 'except';
    operandType: 'existing' | 'expression';
    existingSubset?: string;
    expression?: string;
}

export interface SubsetConfig {
    dimension: string;
    hierarchy: string;
    baseSelection: 'all' | 'leaves' | 'level' | 'members';
    levelIndex?: number;
    selectedMembers?: string[];
    structureType: 'none' | 'descendants' | 'children' | 'drilldown' | 'drilldownlevel';
    structureElement?: string;
    filters: FilterConfig[];
    sorting: SortConfig;
    headTail?: HeadTailConfig;
    topBottom?: TopBottomConfig;
    subsetRange?: SubsetRangeConfig;
    setOperations?: SetOperationConfig[];
}

export interface SubsetRangeConfig {
    enabled: boolean;
    start: number;
    count: number;
}

export interface TopBottomConfig {
    type: 'none' | 'topcount' | 'bottomcount';
    count: number;
    cube: string;
    measure: string;
}

export interface CalculatedMemberConfig {
    name: string;
    dimension: string;
    hierarchy: string;
    expression: string;
    solveOrder?: number;
    formatString?: string;
}

export interface AxisDimConfig {
    dimension: string;
    hierarchy: string;
    subsetType: 'all' | 'existing' | 'custom' | 'drilldown' | 'members';
    drilldownElement?: string;
    existingSubset?: string;
    customConfig?: SubsetConfig;
    selectedMembers?: string[];
    topBottom?: TopBottomConfig;
    properties?: string[];
}

export interface TitleDimConfig {
    dimension: string;
    hierarchy: string;
    selectedElement?: string;
}

export interface ViewConfig {
    cube: string;
    rows: AxisDimConfig[];
    columns: AxisDimConfig[];
    titles: TitleDimConfig[];
    suppressZeroesRows: boolean;
    suppressZeroesCols: boolean;
    calculatedMembers?: CalculatedMemberConfig[];
}

export class MDXGenerator {

    /** Dimension.Hierarchy reference */
    private static dh(dim: string, hier: string): string {
        return `[${dim}].[${hier}]`;
    }

    // -------------------------------------------------------
    // SUBSET MDX
    // -------------------------------------------------------
    public static generateSubsetMDX(c: SubsetConfig): string {
        if (!c.dimension || !c.hierarchy) return '';
        const dh = this.dh(c.dimension, c.hierarchy);

        // 1. Base set — structure type determines the starting set
        let expr: string;

        // Special case: explicit member picks
        if (c.baseSelection === 'members' && c.selectedMembers && c.selectedMembers.length > 0) {
            expr = `{${c.selectedMembers.map(m => `${dh}.[${m}]`).join(', ')}}`;
        } else if (c.structureType === 'descendants' && c.structureElement) {
            expr = `{DESCENDANTS(${dh}.[${c.structureElement}])}`;
        } else if (c.structureType === 'children' && c.structureElement) {
            expr = `{${dh}.[${c.structureElement}].Children}`;
        } else if (c.structureType === 'drilldown' && c.structureElement) {
            expr = `{TM1DRILLDOWNMEMBER({${dh}.[${c.structureElement}]}, ALL, RECURSIVE)}`;
        } else if (c.structureType === 'drilldownlevel' && c.structureElement) {
            expr = `{DRILLDOWNLEVEL({${dh}.[${c.structureElement}]})}`;
        } else {
            expr = `{${dh}.Members}`;
        }

        // 2. Level filter (skip for explicit member picks)
        if (c.baseSelection !== 'members') {
            if (c.baseSelection === 'leaves') {
                expr = `TM1FILTERBYLEVEL(\n  ${expr},\n  0\n)`;
            } else if (c.baseSelection === 'level' && c.levelIndex !== undefined && c.levelIndex >= 0) {
                expr = `TM1FILTERBYLEVEL(\n  ${expr},\n  ${c.levelIndex}\n)`;
            }
        }

        // 3. Filters (applied sequentially — each wraps the previous)
        for (const f of c.filters) {
            if (f.type === 'pattern' && f.pattern) {
                expr = `TM1FILTERBYPATTERN(\n  ${expr},\n  "${f.pattern}"\n)`;
            } else if (f.type === 'attribute' && f.attributeName && f.value !== undefined) {
                if (f.operator === 'CONTAINS') {
                    expr = `FILTER(\n  ${expr},\n  INSTR(${dh}.CurrentMember.Properties("${f.attributeName}"), "${f.value}") > 0\n)`;
                } else {
                    expr = `FILTER(\n  ${expr},\n  ${dh}.CurrentMember.Properties("${f.attributeName}") ${f.operator || '='} "${f.value}"\n)`;
                }
            } else if (f.type === 'value' && f.cube && f.threshold) {
                // Build tuple from dimension.element pairs
                let tupleStr: string;
                if (f.tupleElements && f.tupleElements.length > 0) {
                    const parts = f.tupleElements
                        .filter(te => te.dimension && te.element)
                        .map(te => `[${te.dimension}].[${te.element}]`);
                    tupleStr = `[${f.cube}].(${parts.join(', ')})`;
                } else if (f.measure) {
                    // Legacy: single measure without dimension context
                    tupleStr = `[${f.cube}].([${f.measure}])`;
                } else {
                    continue;
                }
                const thresholdVal = f.thresholdType === 'string' ? `"${f.threshold}"` : f.threshold;
                expr = `FILTER(\n  ${expr},\n  ${tupleStr} ${f.valueOperator || '>'} ${thresholdVal}\n)`;
            }
        }

        // 4. Sorting
        if (c.sorting && c.sorting.type !== 'none') {
            if (c.sorting.type === 'alphabetic') {
                expr = `ORDER(\n  ${expr},\n  ${dh}.CurrentMember.Name,\n  ${c.sorting.direction}\n)`;
            } else if (c.sorting.type === 'hierarchic') {
                expr = `TM1SORT(\n  ${expr},\n  ${c.sorting.direction}\n)`;
            } else if (c.sorting.type === 'byindex') {
                expr = `TM1SORTBYINDEX(\n  ${expr},\n  ${c.sorting.direction}\n)`;
            } else if (c.sorting.type === 'byvalue' && c.sorting.cube && c.sorting.measure) {
                expr = `ORDER(\n  ${expr},\n  [${c.sorting.cube}].([${c.sorting.measure}]),\n  ${c.sorting.direction}\n)`;
            } else if (c.sorting.type === 'byattribute' && c.sorting.attributeName) {
                expr = `ORDER(\n  ${expr},\n  ${dh}.[${c.sorting.attributeName}],\n  ${c.sorting.direction}\n)`;
            }
        }

        // 5. TopCount / BottomCount
        if (c.topBottom && c.topBottom.type !== 'none' && c.topBottom.count > 0 && c.topBottom.measure) {
            const fn = c.topBottom.type === 'topcount' ? 'TOPCOUNT' : 'BOTTOMCOUNT';
            expr = `${fn}(\n  ${expr},\n  ${c.topBottom.count},\n  [${c.topBottom.cube}].([${c.topBottom.measure}])\n)`;
        }

        // 6. Head / Tail — limit result count
        if (c.headTail && c.headTail.type !== 'none' && c.headTail.count > 0) {
            const fn = c.headTail.type === 'head' ? 'HEAD' : 'TAIL';
            expr = `${fn}(\n  ${expr},\n  ${c.headTail.count}\n)`;
        }

        // 7. Subset range — pagination (start, count)
        if (c.subsetRange && c.subsetRange.enabled && c.subsetRange.count > 0) {
            expr = `SUBSET(\n  ${expr},\n  ${c.subsetRange.start},\n  ${c.subsetRange.count}\n)`;
        }

        // 8. Set operations (UNION, INTERSECT, EXCEPT)
        if (c.setOperations && c.setOperations.length > 0) {
            for (const op of c.setOperations) {
                let operandExpr = '';
                if (op.operandType === 'existing' && op.existingSubset) {
                    operandExpr = `{TM1SubsetToSet(${dh}, "${op.existingSubset}")}`;
                } else if (op.operandType === 'expression' && op.expression) {
                    operandExpr = op.expression;
                }
                if (operandExpr) {
                    if (op.type === 'union') {
                        expr = `UNION(\n  ${expr},\n  ${operandExpr}\n)`;
                    } else if (op.type === 'intersect') {
                        expr = `INTERSECT(\n  ${expr},\n  ${operandExpr}\n)`;
                    } else if (op.type === 'except') {
                        expr = `EXCEPT(\n  ${expr},\n  ${operandExpr}\n)`;
                    }
                }
            }
        }

        return expr;
    }

    // -------------------------------------------------------
    // VIEW MDX
    // -------------------------------------------------------
    public static generateViewMDX(c: ViewConfig): string {
        if (!c.cube || (c.rows.length === 0 && c.columns.length === 0)) return '';

        const colSets = c.columns.map(d => this.buildAxisSet(d));
        const rowSets = c.rows.map(d => this.buildAxisSet(d));

        let colExpr = colSets.length === 1 ? colSets[0] : this.crossjoin(colSets);
        let rowExpr = rowSets.length === 1 ? rowSets[0] : this.crossjoin(rowSets);

        if (c.suppressZeroesCols && colExpr) colExpr = `NON EMPTY ${colExpr}`;
        if (c.suppressZeroesRows && rowExpr) rowExpr = `NON EMPTY ${rowExpr}`;

        // Collect DIMENSION PROPERTIES for each axis
        const colProps = this.collectProperties(c.columns);
        const rowProps = this.collectProperties(c.rows);

        const lines: string[] = [];

        // WITH clause — calculated members
        if (c.calculatedMembers && c.calculatedMembers.length > 0) {
            for (let i = 0; i < c.calculatedMembers.length; i++) {
                const cm = c.calculatedMembers[i];
                if (cm.name && cm.expression) {
                    const memberRef = cm.dimension && cm.hierarchy
                        ? `${this.dh(cm.dimension, cm.hierarchy)}.[${cm.name}]`
                        : `[Measures].[${cm.name}]`;
                    const withPrefix = i === 0 ? 'WITH' : '    ';
                    lines.push(`${withPrefix} MEMBER ${memberRef} AS`);
                    lines.push(`    ${cm.expression.replace(/\n/g, '\n    ')}${cm.solveOrder || cm.formatString ? ',' : ''}`);
                    if (cm.solveOrder !== undefined && cm.solveOrder !== null) {
                        lines.push(`    SOLVE_ORDER = ${cm.solveOrder}${cm.formatString ? ',' : ''}`);
                    }
                    if (cm.formatString) {
                        lines.push(`    FORMAT_STRING = '${cm.formatString}'`);
                    }
                }
            }
        }

        lines.push('SELECT');
        // Assign axes contiguously from axis 0 so a single populated axis always
        // lands on COLUMNS — TM1 rejects an ON ROWS with no ON COLUMNS
        // ("Sequence gap in selection axes").
        const axisList: { expr: string; props: string }[] = [];
        if (colExpr) { axisList.push({ expr: colExpr, props: colProps }); }
        if (rowExpr) { axisList.push({ expr: rowExpr, props: rowProps }); }
        const axisNames = ['COLUMNS', 'ROWS'];
        axisList.forEach((a, i) => {
            let line = `  ${a.expr} ON ${axisNames[i]}`;
            if (a.props) { line += `\n  ${a.props}`; }
            if (i < axisList.length - 1) { line += ','; }
            lines.push(line);
        });
        lines.push(`FROM [${c.cube}]`);

        const whereMembers = c.titles
            .filter(t => t.selectedElement)
            .map(t => `${this.dh(t.dimension, t.hierarchy)}.[${t.selectedElement}]`);
        if (whereMembers.length > 0) {
            lines.push(`WHERE (${whereMembers.join(', ')})`);
        }

        return lines.join('\n');
    }

    // -------------------------------------------------------
    // Helpers
    // -------------------------------------------------------
    private static buildAxisSet(d: AxisDimConfig): string {
        let expr: string;
        if (d.subsetType === 'existing' && d.existingSubset) {
            expr = `{TM1SubsetToSet(${this.dh(d.dimension, d.hierarchy)}, "${d.existingSubset}")}`;
        } else if (d.subsetType === 'custom' && d.customConfig) {
            expr = this.generateSubsetMDX(d.customConfig);
        } else if (d.subsetType === 'members' && d.selectedMembers && d.selectedMembers.length > 0) {
            expr = `{${d.selectedMembers.map(m => `${this.dh(d.dimension, d.hierarchy)}.[${m}]`).join(', ')}}`;
        } else if (d.subsetType === 'drilldown' && d.drilldownElement) {
            expr = `{DRILLDOWNMEMBER({${this.dh(d.dimension, d.hierarchy)}.[${d.drilldownElement}]}, {${this.dh(d.dimension, d.hierarchy)}.[${d.drilldownElement}]})}`;
        } else {
            expr = `{${this.dh(d.dimension, d.hierarchy)}.Members}`;
        }

        // TopCount / BottomCount wrapper
        if (d.topBottom && d.topBottom.type !== 'none' && d.topBottom.count > 0 && d.topBottom.measure) {
            const fn = d.topBottom.type === 'topcount' ? 'TOPCOUNT' : 'BOTTOMCOUNT';
            const measureRef = `[${d.topBottom.cube || ''}].([${d.topBottom.measure}])`;
            expr = `${fn}(\n  ${expr},\n  ${d.topBottom.count},\n  ${measureRef}\n)`;
        }

        return expr;
    }

    private static collectProperties(dims: AxisDimConfig[]): string {
        const propRefs: string[] = [];
        for (const d of dims) {
            if (d.properties && d.properties.length > 0) {
                for (const p of d.properties) {
                    propRefs.push(`${this.dh(d.dimension, d.hierarchy)}.[${p}]`);
                }
            }
        }
        return propRefs.length > 0 ? `DIMENSION PROPERTIES ${propRefs.join(', ')}` : '';
    }

    private static crossjoin(sets: string[]): string {
        if (sets.length <= 1) return sets[0] || '';
        let result = sets[0];
        for (let i = 1; i < sets.length; i++) {
            result = `${result} * ${sets[i]}`;
        }
        return result;
    }
}

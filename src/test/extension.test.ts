import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { MDXGenerator, ViewConfig, SubsetConfig } from '../MDXGenerator';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

// ---------------------------------------------------------------------------
// MDXGenerator — axis contiguity fix (single populated axis must be COLUMNS,
// otherwise TM1 rejects with "Sequence gap in selection axes").
// ---------------------------------------------------------------------------
suite('MDXGenerator axis contiguity', () => {
	test('only rows → single axis lands ON COLUMNS (no ON ROWS)', () => {
		const cfg: ViewConfig = {
			cube: 'Sales',
			columns: [],
			rows: [{ dimension: 'Month', hierarchy: 'Month', subsetType: 'members', selectedMembers: ['Jan', 'Feb'] }],
			titles: [],
			suppressZeroesRows: false,
			suppressZeroesCols: false,
			calculatedMembers: []
		};
		const mdx = MDXGenerator.generateViewMDX(cfg);
		assert.ok(/ON COLUMNS/.test(mdx), 'single axis should be ON COLUMNS');
		assert.ok(!/ON ROWS/.test(mdx), 'must not emit ON ROWS when columns are empty');
		assert.ok(/FROM \[Sales\]/.test(mdx));
	});

	test('rows + columns → COLUMNS and ROWS, plus WHERE from titles', () => {
		const cfg: ViewConfig = {
			cube: 'Sales',
			columns: [{ dimension: 'Region', hierarchy: 'Region', subsetType: 'all' }],
			rows: [{ dimension: 'Month', hierarchy: 'Month', subsetType: 'all' }],
			titles: [{ dimension: 'Year', hierarchy: 'Year', selectedElement: '2025' }],
			suppressZeroesRows: false,
			suppressZeroesCols: false,
			calculatedMembers: []
		};
		const mdx = MDXGenerator.generateViewMDX(cfg);
		assert.ok(/ON COLUMNS/.test(mdx));
		assert.ok(/ON ROWS/.test(mdx));
		assert.ok(mdx.includes('WHERE ([Year].[Year].[2025])'), 'context member should be in WHERE');
	});

	test('empty view (no rows/columns) → empty string', () => {
		const cfg: ViewConfig = {
			cube: 'Sales', columns: [], rows: [], titles: [],
			suppressZeroesRows: false, suppressZeroesCols: false, calculatedMembers: []
		};
		assert.strictEqual(MDXGenerator.generateViewMDX(cfg), '');
	});
});

suite('MDXGenerator subset MDX', () => {
	test('explicit members', () => {
		const cfg: SubsetConfig = {
			dimension: 'Month', hierarchy: 'Month', baseSelection: 'members',
			selectedMembers: ['Jan', 'Feb'], structureType: 'none', filters: [],
			sorting: { type: 'none', direction: 'ASC' } as any
		};
		const mdx = MDXGenerator.generateSubsetMDX(cfg);
		assert.ok(mdx.includes('[Month].[Month].[Jan]'));
		assert.ok(mdx.includes('[Month].[Month].[Feb]'));
	});

	test('all members fallback', () => {
		const cfg: SubsetConfig = {
			dimension: 'Month', hierarchy: 'Month', baseSelection: 'all',
			structureType: 'none', filters: [], sorting: { type: 'none', direction: 'ASC' } as any
		};
		const mdx = MDXGenerator.generateSubsetMDX(cfg);
		assert.ok(/Members|TM1SUBSETALL/i.test(mdx), 'should produce an all-members set');
	});
});

// ---------------------------------------------------------------------------
// Pure UI predicates shared across panels (control-object filter, level clamp).
// These mirror the logic embedded in the webview scripts.
// ---------------------------------------------------------------------------
suite('Object list predicates', () => {
	const isControl = (n: string) => n.charAt(0) === '}';
	const visible = (list: string[], showControl: boolean) => showControl ? list : list.filter(n => !isControl(n));

	test('control filter hides }-prefixed names unless enabled', () => {
		const list = ['Sales', '}Clients', 'Budget', '}StatsByCube'];
		assert.deepStrictEqual(visible(list, false), ['Sales', 'Budget']);
		assert.deepStrictEqual(visible(list, true), list);
	});

	const clampLevel = (raw: string, max: number) => {
		let v = String(raw).replace(/[^0-9]/g, '');
		if (v.length > 2) { v = v.slice(0, 2); }
		if (v !== '' && parseInt(v) > max) { v = String(max); }
		return v;
	};

	test('level clamp: strips non-digits, caps length and max', () => {
		assert.strictEqual(clampLevel('05', 50), '05');
		assert.strictEqual(clampLevel('999', 50), '50');
		assert.strictEqual(clampLevel('7a', 50), '7');
		assert.strictEqual(clampLevel('80', 50), '50');
		assert.strictEqual(clampLevel('12', 8), '8');
	});
});

// ---------------------------------------------------------------------------
// Webview template escaping smoke test: the embedded <script> template
// literals must evaluate to syntactically valid JS. This guards the recurring
// backslash-escaping bug class in the panel scripts.
// ---------------------------------------------------------------------------
suite('Webview script templates', () => {
	const root = path.resolve(__dirname, '..', '..');
	const specs: [string, string, string][] = [
		['MDXWizardPanel.ts', 'export function mdxBuilderScript(): string {', 'return `'],
		['LogViewerPanel.ts', 'private _script(): string {', 'return /* js */ `'],
		['CubeViewerPanel.ts', 'function CUBE_VIEWER_SCRIPT', 'return /* js */ `'],
		['SubsetEditorPanel.ts', 'function SUBSET_EDITOR_SCRIPT(): string {', 'return /* js */ `'],
	];

	for (const [file, startMarker, retMarker] of specs) {
		test(`${file} embedded script is valid JS`, function () {
			const full = path.join(root, 'src', file);
			if (!fs.existsSync(full)) { this.skip(); return; }
			const s = fs.readFileSync(full, 'utf8');
			const i = s.indexOf(startMarker);
			assert.ok(i >= 0, `start marker not found in ${file}`);
			const rt = s.indexOf(retMarker, i) + retMarker.length;
			const end = s.indexOf('`;', rt);
			const body = s.slice(rt, end);
			// Neutralise ${...} interpolations (allow one nested {...}) then evaluate
			// the template literal so \\ -> \ etc. produce the real runtime JS.
			const neutral = body.replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/g, '0');
			const runtime = eval('`' + neutral + '`');
			assert.ok(runtime.length > 100, 'runtime script should be non-trivial');
			// eslint-disable-next-line no-new-func
			assert.doesNotThrow(() => new Function(runtime), `${file} script should parse`);
		});
	}
});

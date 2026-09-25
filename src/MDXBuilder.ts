import * as vscode from 'vscode';
import { TM1Service } from './TM1Service';
import { MDXGenerator, SubsetConfig, ViewConfig } from './MDXGenerator';

/**
 * Shared backend for the MDX Builder webview UI. The same builder markup/JS is
 * hosted both by the standalone MDX Wizard panel and, embedded, by the Cube
 * Viewer's MDX dock. This routes the builder's data-fetch / generate / execute
 * messages to TM1 so both hosts behave identically.
 *
 * Returns a message to post back to the webview, or `null` when the command was
 * handled with no reply, or `undefined` when the command is not a builder
 * backend command (the host handles it — e.g. `insertMDX`).
 */
export async function handleMdxBuilderBackend(
    instanceName: string,
    msg: any
): Promise<{ command: string; data: any } | null | undefined> {
    const tm1 = TM1Service.getInstance();
    switch (msg.command) {
        case 'getDimensions': {
            const dims = await tm1.getDimensions(instanceName);
            return { command: 'dimensions', data: { dimensions: dims.map(d => d.Name) } };
        }
        case 'getCubes': {
            const cubes = await tm1.getCubes(instanceName, 'all');
            return { command: 'cubes', data: { cubes: cubes.map(c => c.Name) } };
        }
        case 'getHierarchies': {
            const hiers = await tm1.getHierarchies(instanceName, msg.dimension);
            return { command: 'hierarchies', data: { dimension: msg.dimension, hierarchies: hiers.map(h => h.Name) } };
        }
        case 'getHierarchyMeta': {
            const [attrs, levelCount, consolidatedEls, subsets] = await Promise.all([
                tm1.getHierarchyAttributes(instanceName, msg.dimension, msg.hierarchy),
                tm1.getHierarchyLevelCount(instanceName, msg.dimension, msg.hierarchy),
                tm1.getConsolidatedElements(instanceName, msg.dimension, msg.hierarchy),
                tm1.getHierarchySubsets(instanceName, msg.dimension, msg.hierarchy)
            ]);
            return {
                command: 'hierarchyMeta',
                data: {
                    dimension: msg.dimension,
                    hierarchy: msg.hierarchy,
                    attributes: attrs,
                    levelCount,
                    consolidatedElements: consolidatedEls.map(e => e.Name),
                    subsets: subsets.map(s => s.Name)
                }
            };
        }
        case 'getElements': {
            const elements = await tm1.getHierarchyElements(instanceName, msg.dimension, msg.hierarchy);
            return { command: 'elements', data: { dimension: msg.dimension, hierarchy: msg.hierarchy, elements } };
        }
        case 'getCubeDimensions': {
            const dims = await tm1.getCubeDimensions(instanceName, msg.cube);
            return { command: 'cubeDimensions', data: { cube: msg.cube, dimensions: dims } };
        }
        case 'generateMDX': {
            let mdx = '';
            if (msg.mode === 'subset') {
                mdx = MDXGenerator.generateSubsetMDX(msg.config as SubsetConfig);
            } else {
                mdx = MDXGenerator.generateViewMDX(msg.config as ViewConfig);
            }
            return { command: 'mdxResult', data: { mdx } };
        }
        case 'copyMDX': {
            await vscode.env.clipboard.writeText(msg.mdx);
            vscode.window.showInformationMessage('MDX copied to clipboard.');
            return null;
        }
        case 'executeMDX': {
            try {
                if (msg.mode === 'subset') {
                    const members = await tm1.executeMDXSet(instanceName, msg.mdx, msg.dimension);
                    return { command: 'executeMDXResult', data: { members } };
                }
                const result = await tm1.executeMDXView(instanceName, msg.mdx);
                const axes = result.Axes || [];
                const memberNames: string[] = [];
                if (axes.length > 0 && axes[0].Tuples) {
                    for (const tuple of axes[0].Tuples) {
                        const names = tuple.Members.map((m: any) => m.Name);
                        memberNames.push(names.join(' | '));
                    }
                }
                return { command: 'executeMDXResult', data: { members: memberNames } };
            } catch (err: any) {
                return { command: 'executeMDXResult', data: { error: err.message } };
            }
        }
        default:
            return undefined;
    }
}

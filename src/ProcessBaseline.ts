import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { TM1ProcessContent } from './TM1Service';

export type SyncKind = 'process' | 'rule';

/** Per-object sync baseline: server-source hash + local-file-text hash. */
export interface BaselineEntry {
    /** Hash of the server source at last sync — detects server-side changes on SAVE (push). */
    s: string;
    /** Hash of the local file text at last sync — detects local edits on PULL. */
    l: string;
}

/**
 * Tracks per-object sync baselines for two-way conflict protection of both TI
 * processes (.ti) and cube rules (.rux):
 *  - On SAVE (push): compares the current server source against `s` to detect
 *    that someone changed the object on the server since the last sync.
 *  - On PULL: compares the current local file against `l` to detect local edits
 *    that would otherwise be silently overwritten.
 *
 * Baselines live in workspaceState (project-scoped, survive reloads).
 */
export class ProcessBaseline {
    constructor(private readonly ctx: vscode.ExtensionContext) { }

    private baseKey(kind: SyncKind, inst: string, name: string): string {
        return `pa-code.baseline.${kind}.${inst}\u0000${name}`;
    }
    private offlineKey(kind: SyncKind, inst: string, name: string): string {
        return `pa-code.offline.${kind}.${inst}\u0000${name}`;
    }

    static hashText(text: string): string {
        // Normalise line endings before hashing: Git (via .gitattributes eol=lf)
        // checks files out as LF while TM1 returns CRLF, so an unchanged file must
        // not look "modified" just because of its EOL style.
        const normalized = (text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return createHash('sha256').update(normalized, 'utf8').digest('hex');
    }
    static hashProcess(content: TM1ProcessContent): string {
        return ProcessBaseline.hashText(
            [content.Prolog, content.Metadata, content.Data, content.Epilog, ProcessBaseline.canonicalProperties(content.PropertiesJSON)].join('\u0000')
        );
    }

    /**
     * Content-only hash of a process for deciding "is the local file really
     * different from the server?". Ignores line-ending style, trailing
     * whitespace and the volatile server-managed `Variables`/JSON key order, so
     * a process pulled from Git isn't flagged as a conflict just because TM1
     * reformatted its properties. Both sides must be run through this function.
     */
    static canonicalProcessHash(content: { Prolog: string; Metadata: string; Data: string; Epilog: string; PropertiesJSON: string }): string {
        const norm = (s: string) => (s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+$/gm, '').trim();
        return ProcessBaseline.hashText(
            [norm(content.Prolog), norm(content.Metadata), norm(content.Data), norm(content.Epilog), ProcessBaseline.canonicalProperties(content.PropertiesJSON)].join('\u0000')
        );
    }

    /** Content-only hash of rule text (EOL/trailing-whitespace-independent). */
    static canonicalTextHash(text: string): string {
        return ProcessBaseline.hashText((text ?? '').replace(/[ \t]+$/gm, '').trim());
    }

    /**
     * Normalise a process' PropertiesJSON for stable conflict hashing.
     * The server auto-manages datasource-derived `Variables` that PAW hides and
     * silently regenerates (order/fields), which otherwise made an untouched
     * process look changed on the server. We drop `Variables` and canonicalise
     * key order so only meaningful changes (parameters, datasource, security)
     * affect the hash. Falls back to the raw string if it isn't valid JSON.
     */
    private static canonicalProperties(propertiesJSON: string | undefined): string {
        if (!propertiesJSON) return '';
        try {
            const obj = JSON.parse(propertiesJSON);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) delete (obj as any).Variables;
            return ProcessBaseline.stableStringify(obj);
        } catch {
            return propertiesJSON.trim();
        }
    }

    private static stableStringify(value: any): string {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(v => ProcessBaseline.stableStringify(v)).join(',') + ']';
        const keys = Object.keys(value).sort();
        return '{' + keys.map(k => JSON.stringify(k) + ':' + ProcessBaseline.stableStringify(value[k])).join(',') + '}';
    }

    get(kind: SyncKind, inst: string, name: string): BaselineEntry | undefined {
        return this.ctx.workspaceState.get<BaselineEntry>(this.baseKey(kind, inst, name));
    }
    set(kind: SyncKind, inst: string, name: string, entry: BaselineEntry): Thenable<void> {
        return this.ctx.workspaceState.update(this.baseKey(kind, inst, name), entry);
    }
    clear(kind: SyncKind, inst: string, name: string): Thenable<void> {
        return this.ctx.workspaceState.update(this.baseKey(kind, inst, name), undefined);
    }

    /** Offline flag: when set, Pull All never overwrites this object's local file. */
    isOffline(kind: SyncKind, inst: string, name: string): boolean {
        return this.ctx.workspaceState.get<boolean>(this.offlineKey(kind, inst, name)) === true;
    }
    setOffline(kind: SyncKind, inst: string, name: string, on: boolean): Thenable<void> {
        return this.ctx.workspaceState.update(this.offlineKey(kind, inst, name), on ? true : undefined);
    }
}

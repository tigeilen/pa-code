import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface TM1EnvironmentConfig {
    name: string;
    description?: string;
    connectionType: 'onPremise' | 'customUrl' | 'singleInstance' | 'v12Tenant';
    // Unified Authentication Method
    // 'Prompt' (Default)
    // 'Basic' (User + Password + Optional Namespace)
    // 'CAM Browser SSO' (New webview-based flow)
    // 'IBM Cloud' (Non-Interactive LDAP)
    // 'API Key' (Cloud/Custom)
    // 'OAuth' (PAW OAuth 2.0 authorization code flow)
    // 'Integrated Login' (TM1 IntegratedSecurityMode 2/3 — Windows/AD credentials via NTLM/Negotiate)
    authMethod?: 'Prompt' | 'Basic' | 'CAM Browser SSO' | 'IBM Cloud' | 'API Key' | 'OAuth' | 'Integrated Login';
    camUrl?: string;
    namespace?: string;
    // Per-environment REST request timeout in milliseconds (default 15000).
    // Increase for slow connections.
    timeout?: number;
    // For On-Premise / Single Instance:
    adminHost?: string;
    port?: number;
    ssl?: boolean;
    // For Cloud / Custom URL:
    restUrl?: string;
    // For OAuth (PAW). The client secret is NOT stored here — it lives in
    // VS Code SecretStorage under key `pa-code.oauth.secret.<name>`.
    oauthPawUrl?: string;        // PAW base URL, e.g. https://<paw-host>
    oauthClientId?: string;
    oauthRedirectPort?: number;  // local loopback callback port (default 53173)
    oauthTenantId?: string;      // optional PA SaaS tenant/environment id
    oauthDatabase?: string;      // optional TM1 server/database; blank = discover
    folder: string;
    // Where this connection is stored: 'workspace' (this VS Code workspace),
    // 'global' (all workspaces for this user), or 'file' (legacy tm1-project.json).
    scope?: 'workspace' | 'global' | 'file';
    // Whether "Pull All from Server" writes process/rule files to disk for this
    // environment. Default true. Set false for Test/Prod you only want to browse
    // and analyse (e.g. a repo that should hold only Dev files).
    storeFilesLocally?: boolean;
    // What happens after connecting: 'ask' (default) prompts, 'auto' pulls all
    // silently, 'never' skips it (e.g. when files come from Git).
    pullOnConnect?: 'auto' | 'ask' | 'never';
}

export interface FeatureSettings {
    enableElementCompletion: boolean;
}

export const DEFAULT_FEATURE_SETTINGS: FeatureSettings = {
    enableElementCompletion: false,
};

export interface TM1ProjectConfig {
    environments: TM1EnvironmentConfig[];
    featureSettings?: FeatureSettings;
}

export class ConfigManager {
    private static ctx: vscode.ExtensionContext | undefined;
    private static readonly STORE_KEY = 'pa-code.connections';
    private static readonly FEATURE_KEY = 'pa-code.featureSettings';

    /** Must be called once at activation so VS Code storage is available. */
    static init(context: vscode.ExtensionContext): void {
        this.ctx = context;
    }

    /** Default scope for connections that don't specify one. */
    private static defaultScope(): 'workspace' | 'global' {
        return vscode.workspace.getConfiguration('pa-code').get<string>('connections.defaultScope', 'workspace') === 'global'
            ? 'global' : 'workspace';
    }

    static getConfigPath(): string | null {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return null;
        }
        const rootPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
        // Optional custom location so the legacy project file can live outside the
        // git repo. A value ending in ".json" is used as the file path; otherwise
        // it's treated as a directory.
        const custom = (vscode.workspace.getConfiguration('pa-code').get<string>('projectFile.location', '') || '').trim();
        if (custom) {
            let target = custom;
            if (!path.isAbsolute(target)) target = path.join(rootPath, target);
            return target.toLowerCase().endsWith('.json') ? target : path.join(target, 'tm1-project.json');
        }
        return path.join(rootPath, 'tm1-project.json');
    }

    private static getLegacyConfigPath(): string | null {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            return null;
        }
        return path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'tm1-project.json');
    }

    /** Resolves the readable legacy project-file path, if any exists. */
    private static resolveFilePath(): string | null {
        const p = this.getConfigPath();
        if (p && fs.existsSync(p)) return p;
        const legacy = this.getLegacyConfigPath();
        if (legacy && legacy !== p && fs.existsSync(legacy)) return legacy;
        return null;
    }

    private static readFile(): { environments: TM1EnvironmentConfig[]; featureSettings?: FeatureSettings } | null {
        const readPath = this.resolveFilePath();
        if (!readPath) return null;
        try {
            const parsed = JSON.parse(fs.readFileSync(readPath, 'utf8'));
            const envs: TM1EnvironmentConfig[] = (parsed.environments || []).map((e: TM1EnvironmentConfig) => ({ ...e, scope: 'file' as const }));
            return { environments: envs, featureSettings: parsed.featureSettings };
        } catch (e: any) {
            console.error(`Error reading tm1-project.json: ${e.message}`);
            return null;
        }
    }

    static getConfig(): TM1ProjectConfig {
        const global = (this.ctx?.globalState.get<TM1EnvironmentConfig[]>(ConfigManager.STORE_KEY) || [])
            .map(e => ({ ...e, scope: 'global' as const }));
        const workspace = (this.ctx?.workspaceState.get<TM1EnvironmentConfig[]>(ConfigManager.STORE_KEY) || [])
            .map(e => ({ ...e, scope: 'workspace' as const }));
        const file = this.readFile();
        const fileEnvs = file?.environments || [];

        // Merge with de-duplication by name; workspace overrides global overrides file.
        const byName = new Map<string, TM1EnvironmentConfig>();
        for (const e of [...fileEnvs, ...global, ...workspace]) {
            if (e && e.name) byName.set(e.name, e);
        }
        const environments = [...byName.values()];
        const featureSettings = this.ctx?.globalState.get<FeatureSettings>(ConfigManager.FEATURE_KEY)
            || file?.featureSettings
            || { ...DEFAULT_FEATURE_SETTINGS };
        return { environments, featureSettings };
    }

    static saveConfig(config: TM1ProjectConfig): void {
        const def = this.defaultScope();
        const global: TM1EnvironmentConfig[] = [];
        const workspace: TM1EnvironmentConfig[] = [];
        const fileEnvs: TM1EnvironmentConfig[] = [];
        for (const env of config.environments || []) {
            const scope = env.scope || def;
            const clean: TM1EnvironmentConfig = { ...env };
            delete clean.scope; // the scope tag is not persisted inside the entry
            if (scope === 'global') global.push(clean);
            else if (scope === 'file') fileEnvs.push(clean);
            else workspace.push(clean);
        }

        // VS Code storage (the new default).
        this.ctx?.globalState.update(ConfigManager.STORE_KEY, global);
        this.ctx?.workspaceState.update(ConfigManager.STORE_KEY, workspace);
        if (config.featureSettings) this.ctx?.globalState.update(ConfigManager.FEATURE_KEY, config.featureSettings);

        // Legacy project file: only touched when there are file-scoped connections
        // OR the file already exists (so migrations that empty it don't leave stale
        // entries that would reappear). A brand-new install never creates the file.
        const p = this.getConfigPath();
        const existing = this.resolveFilePath();
        if (p && (fileEnvs.length > 0 || existing)) {
            const targetPath = existing || p;
            try {
                const dir = path.dirname(targetPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(targetPath, JSON.stringify({ environments: fileEnvs, featureSettings: config.featureSettings }, null, 4), 'utf8');
            } catch (e: any) {
                throw new Error(`Failed to save tm1-project.json: ${e.message}`);
            }
        }
    }

    /** Deletes the legacy project file(s), if present. Used after migration. */
    static deleteProjectFile(): void {
        for (const p of [this.getConfigPath(), this.getLegacyConfigPath()]) {
            try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch { /* ignore */ }
        }
    }

    /** True when a legacy project file with connections currently exists. */
    static hasProjectFile(): boolean {
        const f = this.readFile();
        return !!(f && f.environments.length > 0);
    }
}

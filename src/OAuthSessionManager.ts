import * as vscode from 'vscode';
import { PawOAuthService, PawOAuthToken, PawOAuthOptions } from './PawOAuthService';
import { TM1Service } from './TM1Service';
import { ConfigManager } from './ConfigManager';

export interface PawDatabase { Name: string; AcceptingClients: boolean; }

/** The OAuth fields of an environment config that the session needs. */
export interface OAuthEnvironment {
    name: string;
    oauthPawUrl?: string;
    oauthClientId?: string;
    oauthRedirectPort?: number;
}

/**
 * One PAW OAuth session per environment. A single sign-in serves every TM1
 * database of the tenant: the session holds the bearer token and the list of
 * databases it can reach (`GET /api/v1/tm1/Servers`), and renews the token
 * shortly before it expires on every connected database of the environment.
 *
 * Refresh tokens are rotated by PA SaaS on every refresh, so token requests are
 * serialized per environment and the new refresh token is stored at once.
 */
export class OAuthSessionManager implements vscode.Disposable {
    private static instance: OAuthSessionManager | undefined;
    private static readonly RENEW_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

    private readonly tokens = new Map<string, PawOAuthToken>();
    private readonly databases = new Map<string, PawDatabase[]>();
    private readonly sessionSecrets = new Map<string, string>();   // secrets the user chose not to save
    private readonly pending = new Map<string, Promise<string>>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly silentTried = new Set<string>();

    private constructor(private readonly context: vscode.ExtensionContext) { }

    public static init(context: vscode.ExtensionContext): OAuthSessionManager {
        const manager = new OAuthSessionManager(context);
        OAuthSessionManager.instance = manager;
        // A 401 on an OAuth connection forces one silent refresh and a retry
        TM1Service.getInstance().setOAuthRenewer(async envName => {
            const env = (ConfigManager.getConfig().environments || []).find((e: any) => e.name === envName);
            if (!env) throw new Error(`OAuth environment ${envName} not found.`);
            return manager.getAuthHeader(env, { interactive: false, forceRefresh: true });
        });
        return manager;
    }

    public static getInstance(): OAuthSessionManager {
        if (!OAuthSessionManager.instance) throw new Error('OAuthSessionManager is not initialized.');
        return OAuthSessionManager.instance;
    }

    private static refreshKey(envName: string) { return `pa-code.oauth.refresh.${envName}`; }
    private static secretKey(envName: string) { return `pa-code.oauth.secret.${envName}`; }
    private static header(token: PawOAuthToken) { return `${token.tokenType || 'Bearer'} ${token.accessToken}`; }

    /** Databases listed at the last sign-in, or undefined when not signed in. */
    public getDatabases(envName: string): PawDatabase[] | undefined {
        return this.databases.get(envName);
    }

    /** Interactive sign-in (browser if needed) followed by database discovery. */
    public async signIn(env: OAuthEnvironment, progress?: vscode.Progress<{ message?: string }>): Promise<PawDatabase[]> {
        const header = await this.getAuthHeader(env, { interactive: true, progress });
        progress?.report({ message: 'Listing databases…' });
        return this.loadDatabases(env, header);
    }

    /**
     * Restores a session from a stored refresh token without any browser or
     * prompt, once per environment and VS Code session. Returns undefined when
     * that is not possible, so the tree can offer an explicit sign-in instead.
     */
    public async trySilentSignIn(env: OAuthEnvironment): Promise<PawDatabase[] | undefined> {
        if (this.silentTried.has(env.name)) return undefined;
        this.silentTried.add(env.name);
        if (!await this.context.secrets.get(OAuthSessionManager.refreshKey(env.name))) return undefined;
        try {
            const header = await this.getAuthHeader(env, { interactive: false });
            return await this.loadDatabases(env, header);
        } catch {
            return undefined;
        }
    }

    /**
     * Returns a valid bearer header: a cached access token, a silent refresh, or
     * (interactive only) a browser sign-in. Concurrent callers share one request.
     */
    public async getAuthHeader(
        env: OAuthEnvironment,
        opts: { interactive: boolean; forceRefresh?: boolean; progress?: vscode.Progress<{ message?: string }> }
    ): Promise<string> {
        const running = this.pending.get(env.name);
        if (running) {
            try { return await running; } catch (e) { if (!opts.interactive) throw e; }
        }
        const request = this.obtainToken(env, opts).finally(() => this.pending.delete(env.name));
        this.pending.set(env.name, request);
        return request;
    }

    /** Forgets the session (token, databases, unsaved secret) of an environment. */
    public signOut(envName: string): void {
        this.tokens.delete(envName);
        this.databases.delete(envName);
        this.sessionSecrets.delete(envName);
        this.silentTried.delete(envName);
        const timer = this.timers.get(envName);
        if (timer) clearTimeout(timer);
        this.timers.delete(envName);
    }

    public dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }

    private async loadDatabases(env: OAuthEnvironment, header: string): Promise<PawDatabase[]> {
        const list = await TM1Service.getInstance().getPawServers(env.oauthPawUrl || '', header);
        list.sort((a, b) => a.Name.localeCompare(b.Name));
        this.databases.set(env.name, list);
        return list;
    }

    private async obtainToken(
        env: OAuthEnvironment,
        opts: { interactive: boolean; forceRefresh?: boolean; progress?: vscode.Progress<{ message?: string }> }
    ): Promise<string> {
        if (!env.oauthPawUrl || !env.oauthClientId) {
            throw new Error(`OAuth environment ${env.name} is missing the PAW Base URL or Client ID. Open Settings to configure it.`);
        }

        const cached = this.tokens.get(env.name);
        if (!opts.forceRefresh && cached?.expiresAt && cached.expiresAt > Date.now() + 60000) {
            return OAuthSessionManager.header(cached);
        }

        const refreshToken = cached?.refreshToken || await this.context.secrets.get(OAuthSessionManager.refreshKey(env.name));
        if (refreshToken) {
            try {
                opts.progress?.report({ message: 'Refreshing session…' });
                const token = await PawOAuthService.refresh(await this.options(env, false), refreshToken);
                return await this.store(env, token);
            } catch (e) {
                if (!opts.interactive) throw e;
                // Refresh failed (expired/revoked) — fall through to interactive login
            }
        }

        if (!opts.interactive) throw new Error(`Sign-in required for ${env.name}.`);
        opts.progress?.report({ message: 'Signing in…' });
        const token = await PawOAuthService.authenticate(await this.options(env, true));
        return this.store(env, token);
    }

    private async store(env: OAuthEnvironment, token: PawOAuthToken): Promise<string> {
        this.tokens.set(env.name, token);
        // The previous refresh token is invalid as soon as a new one is issued
        if (token.refreshToken) await this.context.secrets.store(OAuthSessionManager.refreshKey(env.name), token.refreshToken);
        const header = OAuthSessionManager.header(token);
        TM1Service.getInstance().updateOAuthAuthHeader(env.name, header);
        this.scheduleRenewal(env.name, token);
        return header;
    }

    private scheduleRenewal(envName: string, token: PawOAuthToken): void {
        const old = this.timers.get(envName);
        if (old) clearTimeout(old);
        this.timers.delete(envName);
        if (!token.expiresAt) return;
        const delay = Math.max(token.expiresAt - Date.now() - OAuthSessionManager.RENEW_BEFORE_EXPIRY_MS, 30000);
        this.timers.set(envName, setTimeout(() => this.renewInBackground(envName), delay));
    }

    /** Renews the token while databases of the environment are connected; otherwise lets it lapse. */
    private async renewInBackground(envName: string): Promise<void> {
        this.timers.delete(envName);
        if (!TM1Service.getInstance().hasOAuthConnections(envName)) return;
        const env = (ConfigManager.getConfig().environments || []).find((e: any) => e.name === envName);
        if (!env) return;
        try {
            await this.getAuthHeader(env, { interactive: false, forceRefresh: true });
        } catch (e: any) {
            const choice = await vscode.window.showWarningMessage(
                `The OAuth session for ${envName} could not be renewed (${e.message}). Sign in again to keep working.`,
                'Sign In'
            );
            if (choice === 'Sign In') vscode.commands.executeCommand('pa-code.oauthSignIn', envName);
        }
    }

    private async options(env: OAuthEnvironment, interactive: boolean): Promise<PawOAuthOptions> {
        return {
            pawBaseUrl: env.oauthPawUrl || '',
            clientId: env.oauthClientId || '',
            clientSecret: await this.clientSecret(env.name, interactive),
            redirectPort: env.oauthRedirectPort || 53173,
            scope: 'v0userContext'
        };
    }

    /** Client secret from SecretStorage or this session; prompts once when interactive. */
    private async clientSecret(envName: string, interactive: boolean): Promise<string | undefined> {
        const inSession = this.sessionSecrets.get(envName);
        if (inSession !== undefined) return inSession || undefined;
        const stored = await this.context.secrets.get(OAuthSessionManager.secretKey(envName));
        if (stored) return stored;
        if (!interactive) return undefined;

        const entered = await vscode.window.showInputBox({
            prompt: `OAuth Client Secret for ${envName}`,
            password: true, ignoreFocusOut: true,
            placeHolder: 'Leave blank if your PAW OAuth client has no secret'
        });
        if (entered === undefined) throw new Error('Sign-in cancelled.');
        if (entered) {
            const save = await vscode.window.showQuickPick(['Yes', 'No'], { placeHolder: 'Save this client secret securely for next time?' });
            if (save === 'Yes') {
                await this.context.secrets.store(OAuthSessionManager.secretKey(envName), entered);
                return entered;
            }
        }
        this.sessionSecrets.set(envName, entered);
        return entered || undefined;
    }
}

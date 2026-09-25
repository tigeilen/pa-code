import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import axios from 'axios';
import * as https from 'https';

export interface PawOAuthToken {
    accessToken: string;
    tokenType: string;
    expiresAt?: number;   // epoch ms
    refreshToken?: string;
}

export interface PawOAuthOptions {
    pawBaseUrl: string;       // e.g. https://<paw-host>
    clientId: string;
    clientSecret?: string;
    redirectPort?: number;    // default 53173
    scope?: string;           // default v0userContext
}

/**
 * Implements the IBM Planning Analytics Workspace (PAW) OAuth 2.0 authorization
 * code flow. Opens the system browser for login, receives the code on a local
 * loopback callback, and exchanges it for a bearer token.
 */
export class PawOAuthService {
    private static readonly DEFAULT_PORT = 53173;
    private static readonly DEFAULT_SCOPE = 'v0userContext';
    private static readonly httpsAgent = new https.Agent({ rejectUnauthorized: false });

    /** Runs the full authorization code flow and returns a bearer token. */
    public static async authenticate(opts: PawOAuthOptions): Promise<PawOAuthToken> {
        const pawBaseUrl = (opts.pawBaseUrl || '').trim().replace(/\/+$/, '');
        if (!pawBaseUrl) throw new Error('PAW base URL is required for OAuth.');
        if (!opts.clientId) throw new Error('OAuth Client ID is required.');

        const port = opts.redirectPort || PawOAuthService.DEFAULT_PORT;
        const scope = opts.scope || PawOAuthService.DEFAULT_SCOPE;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        const state = crypto.randomBytes(16).toString('hex');

        // 1. Wait for the authorization code on a local loopback server
        const codePromise = PawOAuthService.listenForCode(port, state);

        // 2. Open the authorization URL in the external browser
        const authUrl = `${pawBaseUrl}/oauth2/authorize`
            + `?response_type=code`
            + `&client_id=${encodeURIComponent(opts.clientId)}`
            + `&redirect_uri=${encodeURIComponent(redirectUri)}`
            + `&scope=${encodeURIComponent(scope)}`
            + `&state=${encodeURIComponent(state)}`;
        await vscode.env.openExternal(vscode.Uri.parse(authUrl));

        const code = await codePromise;

        // 3. Exchange the code for a token
        const tokenUrl = `${pawBaseUrl}/oauth2/token`;
        const body = new URLSearchParams();
        body.set('grant_type', 'authorization_code');
        body.set('code', code);
        body.set('redirect_uri', redirectUri);
        body.set('client_id', opts.clientId);
        if (opts.clientSecret) body.set('client_secret', opts.clientSecret);

        try {
            const resp = await axios.post(tokenUrl, body.toString(), {
                httpsAgent: PawOAuthService.httpsAgent,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'application/json'
                },
                timeout: 30000
            });
            const data = resp.data || {};
            const accessToken = data.access_token;
            if (!accessToken) throw new Error('Token response did not contain an access_token.');
            const expiresIn = Number(data.expires_in);
            return {
                accessToken,
                tokenType: data.token_type || 'Bearer',
                expiresAt: isNaN(expiresIn) ? undefined : Date.now() + expiresIn * 1000,
                refreshToken: data.refresh_token
            };
        } catch (error: any) {
            const detail = error.response?.data?.error_description || error.response?.data?.error || error.message;
            throw new Error(`OAuth token exchange failed: ${detail}`);
        }
    }

    /** Convenience: returns an "Authorization" header value ("Bearer <token>"). */
    public static async getAuthHeader(opts: PawOAuthOptions): Promise<string> {
        const token = await PawOAuthService.authenticate(opts);
        return `${token.tokenType || 'Bearer'} ${token.accessToken}`;
    }

    /**
     * Refreshes an access token using a stored refresh token (OAuth
     * `grant_type=refresh_token`), avoiding a new browser login.
     */
    public static async refresh(opts: PawOAuthOptions, refreshToken: string): Promise<PawOAuthToken> {
        const pawBaseUrl = (opts.pawBaseUrl || '').trim().replace(/\/+$/, '');
        if (!pawBaseUrl) throw new Error('PAW base URL is required for OAuth refresh.');
        if (!refreshToken) throw new Error('No refresh token available.');

        const tokenUrl = `${pawBaseUrl}/oauth2/token`;
        const body = new URLSearchParams();
        body.set('grant_type', 'refresh_token');
        body.set('refresh_token', refreshToken);
        body.set('client_id', opts.clientId);
        if (opts.clientSecret) body.set('client_secret', opts.clientSecret);
        if (opts.scope) body.set('scope', opts.scope);

        try {
            const resp = await axios.post(tokenUrl, body.toString(), {
                httpsAgent: PawOAuthService.httpsAgent,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
                timeout: 30000
            });
            const data = resp.data || {};
            const accessToken = data.access_token;
            if (!accessToken) throw new Error('Refresh response did not contain an access_token.');
            const expiresIn = Number(data.expires_in);
            return {
                accessToken,
                tokenType: data.token_type || 'Bearer',
                expiresAt: isNaN(expiresIn) ? undefined : Date.now() + expiresIn * 1000,
                // Some providers rotate the refresh token; keep the new one if present, else reuse
                refreshToken: data.refresh_token || refreshToken
            };
        } catch (error: any) {
            const detail = error.response?.data?.error_description || error.response?.data?.error || error.message;
            throw new Error(`OAuth token refresh failed: ${detail}`);
        }
    }

    /** Starts a one-shot loopback HTTP server and resolves with the auth code. */
    private static listenForCode(port: number, expectedState: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const server = http.createServer((req, res) => {
                try {
                    const url = new URL(req.url || '', `http://127.0.0.1:${port}`);
                    if (url.pathname !== '/callback') {
                        res.writeHead(404); res.end('Not found'); return;
                    }
                    const code = url.searchParams.get('code');
                    const state = url.searchParams.get('state');
                    const err = url.searchParams.get('error');
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    if (err) {
                        res.end(PawOAuthService.resultPage('Authentication failed', err));
                        cleanup(); reject(new Error(`OAuth error: ${err}`)); return;
                    }
                    if (!code) {
                        res.end(PawOAuthService.resultPage('Authentication failed', 'No authorization code received.'));
                        cleanup(); reject(new Error('No authorization code received.')); return;
                    }
                    if (state !== expectedState) {
                        res.end(PawOAuthService.resultPage('Authentication failed', 'State mismatch (possible CSRF).'));
                        cleanup(); reject(new Error('OAuth state mismatch.')); return;
                    }
                    res.end(PawOAuthService.resultPage('Sign-in complete', 'You can close this tab and return to VS Code.'));
                    cleanup(); resolve(code);
                } catch (e: any) {
                    try { res.writeHead(500); res.end('Error'); } catch { /* ignore */ }
                    cleanup(); reject(e);
                }
            });

            const timeout = setTimeout(() => { cleanup(); reject(new Error('OAuth login timed out (5 minutes).')); }, 5 * 60 * 1000);
            function cleanup() { clearTimeout(timeout); try { server.close(); } catch { /* ignore */ } }

            server.on('error', (e: any) => {
                clearTimeout(timeout);
                if (e && e.code === 'EADDRINUSE') {
                    reject(new Error(`OAuth callback port ${port} is already in use. Close the other process or change the callback port.`));
                } else {
                    reject(e);
                }
            });
            server.listen(port, '127.0.0.1');
        });
    }

    private static resultPage(title: string, message: string): string {
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#1e1e1e;color:#ddd;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{text-align:center;padding:32px 40px;border:1px solid #333;border-radius:10px;background:#252526}
h1{font-size:20px;margin:0 0 8px}p{color:#aaa;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
    }
}

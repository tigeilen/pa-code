import axios from 'axios';
import * as https from 'https';
import * as http from 'http';
import * as dns from 'dns';
import { Buffer } from 'buffer';
import * as vscode from 'vscode';
import { URL } from 'url';
import { ProxyHelper } from './ProxyHelper';
// Pure-JS NTLM (NTLMv2) message builders used for Windows Integrated Login
// (TM1 IntegratedSecurityMode 2/3). js-md4 / des.js work on modern Node/OpenSSL 3.
import { createType1Message, decodeType2Message, createType3Message } from 'axios-ntlm/lib/ntlm';
// Optional native SPNEGO/Kerberos (SSO) for Kerberos-configured ISM 2/3 servers.
import { isKerberosAvailable, kerberosNegotiate } from './KerberosAuth';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export interface TM1Object { Name: string; }
export interface TM1ProcessContent { Prolog: string; Metadata: string; Data: string; Epilog: string; PropertiesJSON: string; }
export interface ProcessSyntaxError { LineNumber: number; Message: string; Procedure: string; }
interface ConnectionInfo { url: string; authHeader?: string; cookie?: string; connected: boolean; isAdmin?: boolean; extraHeaders?: Record<string, string>; timeout?: number; impersonate?: string; adminCookie?: string; }

export class TM1Service {
    private static instance: TM1Service;
    private static _proxyInterceptorInstalled = false;
    private connections: Map<string, ConnectionInfo> = new Map();
    private adminHostCache: Map<string, { servers: { Name: string, Port: number, SSL: boolean }[], timestamp: number }> = new Map();
    private httpsAgent = new https.Agent({ rejectUnauthorized: false });

    // IntelliSense caches
    private cubeCache: Map<string, string[]> = new Map();
    private dimensionCache: Map<string, string[]> = new Map();
    private elementCache: Map<string, Map<string, string[]>> = new Map();
    private subsetCache: Map<string, Map<string, string[]>> = new Map();
    private attributeCache: Map<string, Map<string, string[]>> = new Map();

    private constructor() { }
    public static getInstance(): TM1Service { if (!TM1Service.instance) TM1Service.instance = new TM1Service(); return TM1Service.instance; }

    // --- Integrated Login (Kerberos/NTLM) diagnostics ---------------------
    // A dedicated output channel makes it easy to analyse why an Integrated
    // Login attempt fell back to NTLM or was rejected. Nothing sensitive (no
    // passwords/tokens) is written — only hosts, SPNs, schemes and statuses.
    private static integratedLog: vscode.OutputChannel | undefined;
    private static logIntegrated(msg: string): void {
        if (!TM1Service.integratedLog) {
            TM1Service.integratedLog = vscode.window.createOutputChannel('PA Code (Integrated Login)');
        }
        TM1Service.integratedLog.appendLine(`[${new Date().toISOString()}] ${msg}`);
    }
    /** Reveals the Integrated Login diagnostic output channel, if any. */
    public static showIntegratedLog(): void {
        TM1Service.integratedLog?.show(true);
    }

    /**
     * Registers a global axios request interceptor that selects the correct
     * network agent (direct or proxy) for every outbound request based on the
     * VS Code proxy settings and environment variables. Call once at startup.
     */
    public static installProxyInterceptor(): void {
        if (TM1Service._proxyInterceptorInstalled) return;
        TM1Service._proxyInterceptorInstalled = true;
        axios.interceptors.request.use((config) => {
            try {
                const base = (config.baseURL || '') + (config.url || '');
                if (base) {
                    const agent = ProxyHelper.resolveAgent(base);
                    config.httpsAgent = agent;
                    config.httpAgent = agent;
                    // Our agent is authoritative — disable axios' own env proxy logic.
                    config.proxy = false;
                    // NOTE: the per-environment "Request Timeout" is intentionally NOT
                    // applied here. It is only meant for the initial login handshake of
                    // slow-to-reach environments (set explicitly in the setConnection*
                    // methods). Applying it as a floor to every request would impose a
                    // timeout on long-running operations that previously had none (e.g.
                    // saving large rules/feeders), which caused transports to fail.
                }
            } catch {
                /* never block a request because of proxy resolution */
            }
            return config;
        });
    }

    private isSslMismatchError(error: any): boolean {
        return error.code === 'EPROTO' || (error.message && error.message.includes('WRONG_VERSION_NUMBER'));
    }

    public async setConnection(instanceName: string, baseUrl: string, user: string, pass: string, namespace?: string, timeoutMs?: number): Promise<void> {
        const reqTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 15000;
        let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        if (url.toLowerCase().endsWith('/api/v1')) {
            url = url.substring(0, url.length - 7);
        }
        let authHeader = '';
        if (namespace && namespace.trim().length > 0) {
            const creds = `${user}:${pass}:${namespace}`;
            authHeader = `CAMNamespace ${Buffer.from(creds).toString('base64')}`;
        } else {
            const creds = `${user}:${pass}`;
            authHeader = `Basic ${Buffer.from(creds).toString('base64')}`;
        }
        try {
            let response;
            try {
                response = await axios.get(`${url}/api/v1/ActiveUser`, {
                    httpsAgent: this.httpsAgent, headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, timeout: reqTimeout
                });
            } catch (initialError: any) {
                if (this.isSslMismatchError(initialError) && url.startsWith('https://')) {
                    url = url.replace('https://', 'http://');
                    response = await axios.get(`${url}/api/v1/ActiveUser`, {
                        headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, timeout: reqTimeout
                    });
                    vscode.window.showWarningMessage(`Connected via HTTP (no SSL). Consider setting "ssl": false in your tm1-project.json to avoid this fallback.`);
                } else {
                    throw initialError;
                }
            }
            
            let cookie = '';
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'] as string[];
                const sessionCookie = cookies.find(c => c.startsWith('TM1SessionId='));
                if (sessionCookie) {
                    cookie = sessionCookie.split(';')[0];
                }
            }

            this.connections.set(instanceName, { url, authHeader, cookie, connected: true, timeout: reqTimeout });

            // Detect admin status
            try {
                const groupsResp = await axios.get(`${url}/api/v1/ActiveUser/Groups?$select=Name`, {
                    httpsAgent: this.httpsAgent,
                    headers: this.getHeaders(instanceName),
                    timeout: 10000
                });
                const groups = groupsResp.data?.value || [];
                this.connections.get(instanceName)!.isAdmin = groups.some((g: any) => g.Name === 'ADMIN');
            } catch { /* admin detection is optional */ }
        } catch (error: any) {
            this.connections.delete(instanceName);
            let debugMsg = error.message;
            if (error.response) {
                debugMsg += ` (Status ${error.response.status})`;
                const authHeaderResponse = error.response.headers?.['www-authenticate'];
                if (authHeaderResponse) {
                    debugMsg += `\nWWW-Authenticate: ${authHeaderResponse}`;
                }
                if (error.response.data) {
                    debugMsg += `\nData: ${typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data}`;
                }
                
                // Also log to console for debugging
                console.error('TM1 Connection Error Response:', error.response.data);
                console.error('TM1 Connection Headers:', error.response.headers);
            }
            throw new Error(`Connection failed: ${debugMsg}`);
        }
    }

    public async setConnectionWithCookie(instanceName: string, baseUrl: string, cookie: string, timeoutMs?: number): Promise<void> {
        const reqTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 15000;
        let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        if (url.toLowerCase().endsWith('/api/v1')) {
            url = url.substring(0, url.length - 7);
        }
        try {
            // Extract the raw passport string
            let passport = cookie;
            if (cookie.includes('CAMPassport=')) {
                passport = cookie.split('CAMPassport=')[1].split(';')[0].trim();
            }

            const authHeader = `CAMPassport ${passport}`;

            let response;
            try {
                response = await axios.get(`${url}/api/v1/ActiveUser`, {
                    httpsAgent: this.httpsAgent, headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, timeout: reqTimeout
                });
            } catch (initialError: any) {
                if (this.isSslMismatchError(initialError) && url.startsWith('https://')) {
                    url = url.replace('https://', 'http://');
                    response = await axios.get(`${url}/api/v1/ActiveUser`, {
                        headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, timeout: reqTimeout
                    });
                    vscode.window.showWarningMessage(`Connected via HTTP (no SSL). Consider setting "ssl": false in your tm1-project.json to avoid this fallback.`);
                } else {
                    throw initialError;
                }
            }

            let tm1Cookie = '';
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'] as string[];
                const sessionCookie = cookies.find(c => c.startsWith('TM1SessionId='));
                if (sessionCookie) {
                    tm1Cookie = sessionCookie.split(';')[0];
                }
            }

            this.connections.set(instanceName, { url, authHeader: authHeader, cookie: tm1Cookie, connected: true, timeout: reqTimeout });

            // Detect admin status
            try {
                const groupsResp = await axios.get(`${url}/api/v1/ActiveUser/Groups?$select=Name`, {
                    httpsAgent: this.httpsAgent,
                    headers: this.getHeaders(instanceName),
                    timeout: 10000
                });
                const groups = groupsResp.data?.value || [];
                this.connections.get(instanceName)!.isAdmin = groups.some((g: any) => g.Name === 'ADMIN');
            } catch { /* admin detection is optional */ }
        } catch (error: any) {
            this.connections.delete(instanceName);
            let debugMsg = error.message;
            if (error.response) {
                debugMsg += ` (Status ${error.response.status})`;
                if (error.response.data) {
                    debugMsg += `\nData: ${typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data}`;
                }
            }
            throw new Error(`SSO/Cookie connection failed: ${debugMsg}`);
        }
    }

    /**
     * Splits a login string into a Windows domain + username.
     * Accepts both `DOMAIN\user` (preferred, NetBIOS domain) and `user@domain`
     * (UPN). Returns an empty domain when none is provided.
     */
    private splitDomainUser(input: string): { domain: string; username: string } {
        const s = (input || '').trim();
        const bs = s.indexOf('\\');
        if (bs >= 0) {
            return { domain: s.substring(0, bs), username: s.substring(bs + 1) };
        }
        const at = s.lastIndexOf('@');
        if (at >= 0) {
            return { domain: s.substring(at + 1), username: s.substring(0, at) };
        }
        return { domain: '', username: s };
    }

    /** Extracts the base64 token that follows an auth scheme name in a header/message. */
    private extractSchemeToken(headerValue: string, scheme: string): string | null {
        if (!headerValue) return null;
        // A WWW-Authenticate header may list several schemes separated by commas,
        // e.g. "Negotiate abc123, NTLM". Find the part for the requested scheme.
        const parts = headerValue.split(',');
        const re = new RegExp(`^\\s*${scheme}\\b\\s*(.*)$`, 'i');
        for (const part of parts) {
            const m = re.exec(part);
            if (m) {
                const token = (m[1] || '').trim();
                return token.length > 0 ? token : '';
            }
        }
        return null;
    }

    /**
     * Resolves a host to its fully-qualified domain name for the Kerberos SPN.
     * Kerberos SPNs are registered against the FQDN, so requesting a ticket for a
     * short name (`HTTP/server`) fails with SEC_E_TARGET_UNKNOWN even when
     * `HTTP/server.domain.com` exists. If the host already contains a dot we take
     * it as-is; otherwise we resolve it (A record → reverse PTR) to the FQDN.
     */
    private async resolveSpnHost(hostname: string, log: (m: string) => void): Promise<string> {
        if (hostname.includes('.') || /^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
            return hostname; // already qualified, an IPv4, or IPv6 — use as-is
        }
        try {
            const { address } = await dns.promises.lookup(hostname);
            const ptr = await dns.promises.reverse(address).catch(() => [] as string[]);
            const fqdn = ptr.find(n => n.includes('.') && n.toLowerCase().startsWith(hostname.toLowerCase()))
                || ptr.find(n => n.includes('.'));
            if (fqdn) {
                log(`  [Kerberos] resolved FQDN '${fqdn}' from short host '${hostname}' for the SPN`);
                return fqdn;
            }
            log(`  [Kerberos] could not resolve an FQDN for '${hostname}' (no PTR); using the short name`);
        } catch (e: any) {
            log(`  [Kerberos] FQDN resolution for '${hostname}' failed: ${e?.message || e}; using the short name`);
        }
        return hostname;
    }

    /**
     * Connects to a TM1 server that uses Windows Integrated Login
     * (IntegratedSecurityMode 2/3). Such a server answers with
     * `WWW-Authenticate: Negotiate` and cannot be authenticated with HTTP Basic.
     *
     * Kerberos SSO is attempted first using the current Windows/GSSAPI session —
     * no username or password is needed (like Architect). Only if Kerberos does
     * not succeed and an NTLM fallback is possible do we ask, via
     * `credentialProvider`, for Windows/AD credentials. On success the returned
     * `TM1SessionId` cookie is stored — all further requests then use the cookie.
     */
    public async setConnectionWithIntegrated(
        instanceName: string,
        baseUrl: string,
        timeoutMs?: number,
        credentialProvider?: () => Promise<{ user: string; pass: string } | undefined>
    ): Promise<void> {
        const reqTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 15000;
        let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        if (url.toLowerCase().endsWith('/api/v1')) {
            url = url.substring(0, url.length - 7);
        }
        const log = (m: string) => TM1Service.logIntegrated(m);
        log('──────────────────────────────────────────────');
        log(`Integrated Login started for '${instanceName}'`);
        log(`  endpoint: ${url}/api/v1/ActiveUser`);
        log(`  host (for Kerberos SPN "HTTP/<host>"): ${(() => { try { return new URL(url).hostname; } catch { return '?'; } })()}`);
        log(`  timeout: ${reqTimeout}ms`);
        log(`  native Kerberos module available: ${isKerberosAvailable()}`);

        // Credentials are only needed for the NTLM fallback; requested lazily.
        let creds: { user: string; pass: string } | undefined;

        // Dedicated keep-alive client with a single socket so the multi-leg NTLM
        // handshake stays on one connection (NTLM is connection-oriented). A
        // separate axios instance also bypasses the global proxy interceptor.
        const makeClient = (secure: boolean) => {
            const agent = secure
                ? new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false })
                : new http.Agent({ keepAlive: true, maxSockets: 1 });
            const client = axios.create({
                httpsAgent: secure ? agent : undefined,
                httpAgent: secure ? undefined : agent,
                proxy: false,
                timeout: reqTimeout,
                // We inspect 401 responses ourselves during the handshake.
                validateStatus: () => true
            });
            return { client, agent };
        };

        const runHandshake = async (client: any, user: string, pass: string): Promise<{ response: any } | null> => {
            const target = `${url}/api/v1/ActiveUser`;
            const { domain, username } = this.splitDomainUser(user);
            log(`  [NTLM] using credentials username='${username}' domain='${domain || '(server-provided)'}'`);
            // Try the Negotiate scheme first (what mode-3 servers advertise), then
            // fall back to the NTLM scheme. We only send credentials (Type 3) once
            // per attempt to avoid needless failed logons (AD lockout risk).
            for (const scheme of ['Negotiate', 'NTLM']) {
                // --- Leg 1: Type 1 (negotiate) ---
                const type1 = createType1Message(undefined, '');
                const type1Token = type1.replace(/^NTLM\s+/i, '');
                const resp1 = await client.get(target, {
                    headers: { 'Authorization': `${scheme} ${type1Token}`, 'Accept': 'application/json' }
                });
                log(`  [NTLM] scheme='${scheme}' leg1 status=${resp1.status} www-authenticate='${String(resp1.headers['www-authenticate'] || '').slice(0, 40)}'`);
                if (resp1.status !== 401) {
                    // Some servers accept an unauthenticated first request or already
                    // established a session — treat a 2xx as success.
                    if (resp1.status >= 200 && resp1.status < 300) { log(`  [NTLM] scheme='${scheme}' accepted at leg1 (status ${resp1.status})`); return { response: resp1 }; }
                    continue;
                }
                const challenge = this.extractSchemeToken(resp1.headers['www-authenticate'] || '', scheme);
                if (!challenge) {
                    // Scheme not offered / no Type 2 token: try the next scheme
                    // without spending a credential attempt.
                    log(`  [NTLM] scheme='${scheme}' offered no challenge token — trying next scheme`);
                    continue;
                }
                // --- Leg 2: Type 3 (authenticate) on the same socket ---
                const type2 = decodeType2Message(challenge);
                const type3 = createType3Message(type2, username, pass, undefined, domain.length ? domain : undefined);
                const type3Token = type3.replace(/^NTLM\s+/i, '');
                const resp2 = await client.get(target, {
                    headers: { 'Authorization': `${scheme} ${type3Token}`, 'Accept': 'application/json' }
                });
                log(`  [NTLM] scheme='${scheme}' leg2 (Type3) status=${resp2.status}`);
                return { response: resp2 };
            }
            log(`  [NTLM] no scheme produced a usable challenge`);
            return null;
        };

        // Kerberos/SSPI SSO (matches Architect) — tried first on its own socket.
        // Uses the current Windows/GSSAPI session; no password. Returns a result
        // only on success, otherwise null so the NTLM handshake can try.
        const runKerberos = async (secure: boolean): Promise<{ response: any } | null> => {
            if (!isKerberosAvailable()) { log('  [Kerberos] skipped — native module not available'); return null; }
            const ctx = makeClient(secure);
            try {
                const rawHost = new URL(url).hostname;
                // An explicit SPN override wins (e.g. "HTTP/exact.spn.here"); it is
                // accepted in either "HTTP/host" or "HTTP@host" form.
                const spnOverride = (vscode.workspace.getConfiguration('pa-code').get<string>('integratedLogin.kerberosSpn', '') || '').trim();
                let spnService: string | undefined;
                if (spnOverride) {
                    spnService = spnOverride.replace('/', '@');
                    log(`  [Kerberos] using configured SPN override '${spnOverride}'`);
                } else {
                    const spnHost = await this.resolveSpnHost(rawHost, log);
                    spnService = `HTTP@${spnHost}`;
                }
                log(`  [Kerberos] attempting SSO with service '${spnService}' (KRB5 mechanism)`);
                const kres = await kerberosNegotiate(ctx.client, `${url}/api/v1/ActiveUser`, rawHost, spnService, log);
                log(`  [Kerberos] final HTTP status=${kres.status}`);
                if (kres.status >= 200 && kres.status < 300) { log('  [Kerberos] SUCCESS'); return { response: kres }; }
                log('  [Kerberos] did not succeed — will fall back to NTLM');
                return null;
            } catch (e: any) {
                // Let a TLS/protocol mismatch bubble up so the http fallback runs.
                if (this.isSslMismatchError(e)) throw e;
                log(`  [Kerberos] error: ${e?.message || e} — will fall back to NTLM`);
                return null;
            } finally {
                ctx.agent.destroy();
            }
        };

        const doAuth = async (secure: boolean, client: any): Promise<{ response: any } | null> => {
            const k = await runKerberos(secure);
            if (k) return k;
            // Kerberos SSO did not succeed → an NTLM fallback needs credentials.
            // Ask for them now (once), only if we haven't already.
            if (!creds) {
                if (!credentialProvider) { log('  [NTLM] Kerberos failed and no credential provider — cannot try NTLM'); return null; }
                log('  [NTLM] Kerberos SSO not available — requesting credentials for NTLM fallback');
                creds = await credentialProvider();
                if (!creds) { log('  [NTLM] no credentials provided — NTLM fallback skipped'); return null; }
            }
            return await runHandshake(client, creds.user, creds.pass);
        };

        let clientCtx = makeClient(url.startsWith('https://'));
        try {
            let result: { response: any } | null;
            try {
                result = await doAuth(url.startsWith('https://'), clientCtx.client);
            } catch (initialError: any) {
                if (this.isSslMismatchError(initialError) && url.startsWith('https://')) {
                    clientCtx.agent.destroy();
                    url = url.replace('https://', 'http://');
                    clientCtx = makeClient(false);
                    result = await doAuth(false, clientCtx.client);
                    vscode.window.showWarningMessage(`Connected via HTTP (no SSL). Consider setting "ssl": false in your tm1-project.json to avoid this fallback.`);
                } else {
                    throw initialError;
                }
            }

            if (!result) {
                const kerbHint = isKerberosAvailable()
                    ? `Kerberos SSO did not complete and the server did not accept NTLM.`
                    : `The server appears to require Kerberos (Negotiate) SSO, but the Kerberos component could not be loaded on this machine.`;
                throw new Error(`${kerbHint} Confirm the server runs IntegratedSecurityMode 2 or 3, that you are on a domain-joined session with a valid ticket, and that the TM1 host SPN (HTTP/<fqdn>) is registered.`);
            }
            const response = result.response;
            if (response.status === 401 || response.status === 403) {
                const wa = response.headers?.['www-authenticate'];
                let hint = `Windows Integrated Login was rejected (Status ${response.status}).`;
                if (wa && /negotiate/i.test(String(wa)) && !/ntlm/i.test(String(wa))) {
                    hint += ` The server only accepts Kerberos/Negotiate SSO and refused NTLM. Try the "DOMAIN\\\\user" form, or use a machine joined to the domain.`;
                } else {
                    hint += ` Check the credentials and use the "DOMAIN\\\\user" form (NetBIOS domain), e.g. "CONTOSO\\\\jdoe".`;
                }
                throw new Error(hint);
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error(`unexpected response (Status ${response.status}).`);
            }

            let cookie = '';
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'] as string[];
                const sessionCookie = cookies.find(c => c.startsWith('TM1SessionId='));
                if (sessionCookie) {
                    cookie = sessionCookie.split(';')[0];
                }
            }
            if (!cookie) {
                throw new Error(`login succeeded but the server did not return a TM1 session cookie.`);
            }

            // Store as a cookie-based connection (no Authorization header) — the
            // NTLM handshake only needs to happen once; the session cookie carries
            // the authenticated state for all further requests.
            this.connections.set(instanceName, { url, cookie, connected: true, timeout: reqTimeout });
            log(`Integrated Login SUCCEEDED for '${instanceName}'.`);

            // Detect admin status (optional).
            try {
                const groupsResp = await axios.get(`${url}/api/v1/ActiveUser/Groups?$select=Name`, {
                    httpsAgent: this.httpsAgent,
                    headers: this.getHeaders(instanceName),
                    timeout: 10000
                });
                const groups = groupsResp.data?.value || [];
                this.connections.get(instanceName)!.isAdmin = groups.some((g: any) => g.Name === 'ADMIN');
            } catch { /* admin detection is optional */ }
        } catch (error: any) {
            this.connections.delete(instanceName);
            let debugMsg = error.message;
            if (error.response) {
                debugMsg += ` (Status ${error.response.status})`;
            }
            log(`Integrated Login FAILED for '${instanceName}': ${debugMsg}`);
            log(`Tips: use the server FQDN (not short name); verify the SPN "HTTP/<fqdn>" is registered in AD (setspn -Q HTTP/<fqdn>); ensure you are on a domain-joined session with a valid ticket (klist).`);
            TM1Service.showIntegratedLog();
            throw new Error(`Integrated Login failed: ${debugMsg}`);
        } finally {
            clientCtx.agent.destroy();
        }
    }

    public disconnect(instanceName: string) { this.connections.delete(instanceName); }
    public isConnected(instanceName: string): boolean { return this.connections.has(instanceName) && this.connections.get(instanceName)!.connected; }
    public getAdminStatus(instanceName: string): boolean { return this.connections.get(instanceName)?.isAdmin || false; }

    // --- User impersonation (v11) ---
    /** The user currently impersonated on an instance, or undefined. */
    public getImpersonation(instanceName: string): string | undefined {
        return this.connections.get(instanceName)?.impersonate;
    }

    /** Extracts the TM1SessionId cookie from a response's Set-Cookie header. */
    private extractSessionCookie(response: any): string {
        const set = response?.headers?.['set-cookie'];
        if (Array.isArray(set)) {
            const c = set.find((x: string) => x.startsWith('TM1SessionId='));
            if (c) { return c.split(';')[0]; }
        }
        return '';
    }

    /**
     * Starts impersonating a user. Impersonation is bound at SESSION CREATION in
     * TM1 (not per request), so this mints a NEW session that carries the
     * TM1-Impersonate header — by re-authenticating with the connection's stored
     * credentials and deliberately dropping the current (admin) cookie. The
     * admin cookie is remembered so we can return to it. Returns the effective
     * ActiveUser name (should equal the impersonated user).
     */
    public async impersonate(instanceName: string, user: string): Promise<string> {
        const cfg = this.getConfig(instanceName);
        if (!cfg.authHeader) {
            throw new Error('This connection signed in via browser/SSO and has no re-usable credentials, so impersonation cannot open a new session. Use a Basic/native or API-key connection.');
        }
        const headers: any = { 'Accept': 'application/json', 'Authorization': cfg.authHeader, 'TM1-Impersonate': user };
        if (cfg.extraHeaders) { Object.assign(headers, cfg.extraHeaders); }
        // No Cookie header → TM1 mints a fresh session, and TM1-Impersonate makes it an impersonated one.
        const resp = await axios.get(`${cfg.url}/api/v1/ActiveUser?$select=Name`, {
            httpsAgent: this.httpsAgent, headers, timeout: cfg.timeout || 15000
        });
        const newCookie = this.extractSessionCookie(resp);
        const effective = resp.data?.Name || user;
        if (cfg.adminCookie === undefined) { cfg.adminCookie = cfg.cookie; }
        if (newCookie) { cfg.cookie = newCookie; }
        cfg.impersonate = user;
        return effective;
    }

    /** Stops impersonation and returns to the admin session (re-authenticates). */
    public async stopImpersonation(instanceName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        cfg.impersonate = undefined;
        try {
            if (cfg.authHeader) {
                const headers: any = { 'Accept': 'application/json', 'Authorization': cfg.authHeader };
                if (cfg.extraHeaders) { Object.assign(headers, cfg.extraHeaders); }
                const resp = await axios.get(`${cfg.url}/api/v1/ActiveUser`, { httpsAgent: this.httpsAgent, headers, timeout: cfg.timeout || 15000 });
                const adminCookie = this.extractSessionCookie(resp);
                if (adminCookie) { cfg.cookie = adminCookie; }
            } else if (cfg.adminCookie) {
                cfg.cookie = cfg.adminCookie;
            }
        } finally {
            cfg.adminCookie = undefined;
        }
    }

    /** Returns the effective ActiveUser name (reflects impersonation) — used to confirm it took effect. */
    public async getActiveUserName(instanceName: string): Promise<string> {
        const cfg = this.getConfig(instanceName);
        const response = await axios.get(`${cfg.url}/api/v1/ActiveUser?$select=Name`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000
        });
        this.updateCookieFromResponse(instanceName, response);
        return response.data?.Name || '';
    }

    public async checkSession(instanceName: string): Promise<boolean> {
        const cfg = this.connections.get(instanceName);
        if (!cfg || !cfg.connected) return false;
        try {
            const response = await axios.get(`${cfg.url}/api/v1/ActiveUser`, {
                httpsAgent: this.httpsAgent,
                headers: this.getHeaders(instanceName),
                timeout: 10000
            });
            this.updateCookieFromResponse(instanceName, response);
            return true;
        } catch (error: any) {
            if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                this.connections.delete(instanceName);
                return false;
            }
            return true;
        }
    }

    public getConnectedInstanceNames(): string[] {
        return Array.from(this.connections.entries())
            .filter(([_, v]) => v.connected)
            .map(([k]) => k);
    }
    private getConfig(instanceName: string): ConnectionInfo {
        const cfg = this.connections.get(instanceName);
        if (!cfg) throw new Error(`Instance '${instanceName}' is not connected!`);
        return cfg;
    }

    private getHeaders(instanceName: string): any {
        const cfg = this.getConfig(instanceName);
        const headers: any = {
            'Accept': 'application/json;charset=utf-8'
        };
        if (cfg.authHeader && !cfg.impersonate) {
            headers['Authorization'] = cfg.authHeader;
        }
        if (cfg.cookie) {
            headers['Cookie'] = cfg.cookie;
        }
        if (cfg.extraHeaders) {
            Object.assign(headers, cfg.extraHeaders);
        }
        // User impersonation (v11): the impersonated session cookie drives the
        // identity; we also keep the header (matches tm1py) and drop the admin
        // Authorization above so the admin identity can't take over.
        if (cfg.impersonate) {
            headers['TM1-Impersonate'] = cfg.impersonate;
        }
        // Debug logging for development
        // console.log(`[TM1Service] Headers for ${instanceName}:`, { ...headers, Authorization: headers.Authorization ? '***' : 'missing' });
        return headers;
    }

    private updateCookieFromResponse(instanceName: string, response: any) {
        if (response.headers && response.headers['set-cookie']) {
            const cookies = response.headers['set-cookie'] as string[];
            const sessionCookie = cookies.find(c => c.startsWith('TM1SessionId='));
            if (sessionCookie) {
                const cfg = this.connections.get(instanceName);
                if (cfg) {
                    cfg.cookie = sessionCookie.split(';')[0];
                }
            }
        }
    }

    private handleError(instanceName: string, action: string, error: any) {
        console.error(`[TM1 API Error] Action: ${action} for instance: ${instanceName}`);
        if (error.response) {
            console.error(`[TM1 API Error] Status: ${error.response.status}`);
            console.error(`[TM1 API Error] Body:`, error.response.data);
        } else {
            console.error(`[TM1 API Error] Message: ${error.message}`);
        }
    }

    public async getServersFromAdminHost(host: string, port: number, ssl: boolean): Promise<{ Name: string, Port: number, SSL: boolean }[]> {
        const cacheKey = `${host}:${port}`;
        const cached = this.adminHostCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp < 60000)) {
            return cached.servers;
        }

        const protocol = ssl ? 'https' : 'http';
        const url = `${protocol}://${host}:${port}`;
        const response = await axios.get(`${url}/api/v1/Servers`, {
            httpsAgent: this.httpsAgent,
            headers: { 'Accept': 'application/json;charset=utf-8', 'User-Agent': 'PACode/1.5.0' },
            timeout: 10000
        });
        const servers = (response.data.value || []).map((s: any) => ({
            Name: s.Name,
            Port: s.HTTPPortNumber,
            SSL: s.UsingSSL
        })).sort((a: any, b: any) => a.Name.localeCompare(b.Name));

        this.adminHostCache.set(cacheKey, { servers, timestamp: Date.now() });
        return servers;
    }

    public async getCamInfo(baseUrl: string): Promise<{ isCam: boolean, camUrl?: string }> {
        let url = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
        if (url.toLowerCase().endsWith('/api/v1')) {
            url = url.substring(0, url.length - 7);
        }
        try {
            const response = await axios.get(`${url}/api/v1/Configuration`, { 
                httpsAgent: this.httpsAgent, 
                timeout: 10000,
                validateStatus: (status) => status === 401 || status === 200
            });
            
            if (response.status === 200) return { isCam: false };

            const authHeader = response.headers['www-authenticate'] || '';
            const isCam = authHeader.includes('CAM');
            let camUrl: string | undefined;

            if (isCam) {
                // Try to extract from header
                const match = authHeader.match(/loginUrl="([^"]+)"/);
                if (match) {
                    camUrl = match[1];
                } else {
                    // Fallback: If it's a PA server, the dispatcher is often /ibmcognos/bi/v1/disp
                    // We can try to guess based on the host
                    const hostUrl = new URL(url);
                    camUrl = `${hostUrl.protocol}//${hostUrl.host}/ibmcognos/bi/v1/disp`;
                }
            }

            return { isCam, camUrl };
        } catch (error: any) {
            return { isCam: false };
        }
    }

    /** Turns a low-level network error into a short, user-friendly explanation. */
    private describeNetError(e: any): string {
        if (e.response) return `HTTP ${e.response.status}`;
        if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return 'host not found (check the host name)';
        if (e.code === 'ECONNREFUSED') return 'connection refused (check the port / that the server is running)';
        if (e.code === 'ETIMEDOUT' || e.code === 'ECONNABORTED') return 'timeout (check host/port/firewall)';
        if (this.isSslMismatchError(e)) return 'TLS/SSL mismatch (try toggling the SSL option)';
        return e.message || String(e);
    }

    /**
     * Validates connection parameters WITHOUT persisting anything. Picks the
     * right probe per connection type / auth method:
     *  - Admin Server  -> GET /api/v1/Servers (lists instances)
     *  - Single Instance -> GET <host:port>/api/v1/Configuration (reachability)
     *  - Cloud / v12   -> GET <restUrl>/api/v1/Configuration (reachability)
     *  - OAuth         -> GET <paw>/api/v1/tm1/Servers (expects 401 = reachable)
     * A 200/401/403 means the endpoint is reachable and the parameters are
     * structurally correct; credentials are verified later on actual connect.
     */
    public async testConnection(opts: {
        connectionType?: string;
        authMethod?: string;
        host?: string; port?: number; ssl?: boolean;
        restUrl?: string;
        oauthPawUrl?: string;
        timeoutMs?: number;
    }): Promise<{ ok: boolean; message: string }> {
        const reachable = (s: number) => s === 200 || s === 401 || s === 403;
        const reqTimeout = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 10000;

        // OAuth: verify the PAW base URL is reachable (unauthorized is expected).
        if (opts.authMethod === 'OAuth') {
            const paw = this.normalizePawHost(opts.oauthPawUrl || '');
            if (!paw) return { ok: false, message: 'PAW Base URL is required for OAuth.' };
            try {
                const resp = await axios.get(`${paw}/api/v1/tm1/Servers`, {
                    httpsAgent: this.httpsAgent, timeout: reqTimeout,
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' },
                    validateStatus: (s) => reachable(s)
                });
                return { ok: true, message: `PAW endpoint reachable (HTTP ${resp.status}). The OAuth sign-in will complete the connection.` };
            } catch (e: any) {
                return { ok: false, message: `PAW endpoint not reachable: ${this.describeNetError(e)}` };
            }
        }

        // Admin Server: list the instances it serves.
        if (opts.connectionType === 'onPremise') {
            if (!opts.host || !opts.port) return { ok: false, message: 'Admin Host and Port are required.' };
            try {
                const servers = await this.getServersFromAdminHost(opts.host, opts.port, !!opts.ssl);
                const names = servers.map(s => s.Name).slice(0, 8).join(', ');
                const more = servers.length > 8 ? ', …' : '';
                return { ok: true, message: `Admin Server reachable — ${servers.length} instance(s)${names ? `: ${names}${more}` : ''}.` };
            } catch (e: any) {
                return { ok: false, message: `Admin Server not reachable: ${this.describeNetError(e)}` };
            }
        }

        // Single Instance / Cloud / v12 Tenant: reachability probe on /Configuration.
        let base = '';
        if (opts.connectionType === 'singleInstance') {
            if (!opts.host || !opts.port) return { ok: false, message: 'Host and Port are required.' };
            base = `${opts.ssl ? 'https' : 'http'}://${opts.host}:${opts.port}`;
        } else {
            let r = (opts.restUrl || '').trim();
            if (!r) return { ok: false, message: 'Base REST API URL is required for this connection type.' };
            r = r.replace(/\/+$/, '');
            if (/\/api\/v1$/i.test(r)) r = r.replace(/\/api\/v1$/i, '');
            base = r;
        }
        try {
            const resp = await axios.get(`${base}/api/v1/Configuration`, {
                httpsAgent: this.httpsAgent, timeout: reqTimeout,
                headers: { 'Accept': 'application/json' },
                validateStatus: (s) => reachable(s)
            });
            let sec = '';
            if (resp.status === 200) {
                sec = '';
            } else {
                const wa = String(resp.headers['www-authenticate'] || '');
                if (/CAM/i.test(wa)) sec = ' — security: CAM/SSO';
                else if (/Bearer/i.test(wa)) sec = ' — security: token/OAuth';
                else if (/Basic/i.test(wa)) sec = ' — security: native/Basic';
            }
            return { ok: true, message: `TM1 endpoint reachable (HTTP ${resp.status})${sec}. Credentials are verified on connect.` };
        } catch (e: any) {
            return { ok: false, message: `TM1 endpoint not reachable: ${this.describeNetError(e)}` };
        }
    }

    // --- PROCESSES ---
    public async getProcesses(instanceName: string, type: 'all' | 'normal' | 'control' = 'normal'): Promise<TM1Object[]> {
        const cfg = this.getConfig(instanceName);
        let filterStr = '';
        if (type === 'normal') filterStr = "&$filter=not startswith(Name,'}')";
        else if (type === 'control') filterStr = "&$filter=startswith(Name,'}')";

        try {
            const response = await axios.get(`${cfg.url}/api/v1/Processes?$select=Name${filterStr}`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            this.updateCookieFromResponse(instanceName, response);
            if (!response.data || !response.data.value) {
                const responseStr = typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data);
                console.error(`[TM1 API Error] Unexpected response format for getProcesses for ${instanceName}:`, response.data);
                throw new Error(`Unexpected response from server: ${responseStr}...`);
            }
            return (response.data.value as TM1Object[]).sort((a, b) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            console.error(`[TM1 API Error] getProcesses failed for ${instanceName}:`, error.message);
            if (error.response) {
                console.error(`[TM1 API Error] Status: ${error.response.status}`);
                console.error(`[TM1 API Error] Data:`, error.response.data);
            }
            this.handleError(instanceName, 'getProcesses', error);
            throw new Error(`getProcesses failed: ${error.response?.status} - ${error.message}`);
        }
    }

    public async getProcessCode(instanceName: string, processName: string): Promise<TM1ProcessContent> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(processName).replace(/'/g, "''");
        const response = await axios.get(`${cfg.url}/api/v1/Processes('${encodedName}')?$select=PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,Parameters,DataSource,Variables,HasSecurityAccess`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        const data = response.data;
        return {
            Prolog: data.PrologProcedure || '', Metadata: data.MetadataProcedure || '', Data: data.DataProcedure || '', Epilog: data.EpilogProcedure || '',
            PropertiesJSON: JSON.stringify({ Parameters: data.Parameters || [], DataSource: data.DataSource || {}, Variables: data.Variables || [], HasSecurityAccess: data.HasSecurityAccess || false }, null, 2)
        };
    }

    // Bulk fetch of every process' code (single request) for lineage analysis.
    public async getAllProcessCode(instanceName: string): Promise<{ Name: string; code: string }[]> {
        const cfg = this.getConfig(instanceName);
        const res = await axios.get(
            `${cfg.url}/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure&$top=5000`,
            { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000 }
        );
        return (res.data.value || []).map((p: any) => ({
            Name: p.Name,
            code: [p.PrologProcedure, p.MetadataProcedure, p.DataProcedure, p.EpilogProcedure].map((x: any) => x || '').join('\n')
        }));
    }

    // Bulk fetch of every cube's rule text for lineage analysis. Uses the proven
    // per-cube Rules endpoint (bulk $expand of Rules text is rejected by some TM1
    // versions with 400), with bounded concurrency for responsiveness.
    public async getAllCubeRules(instanceName: string): Promise<{ Name: string; rules: string }[]> {
        const cubes = await this.getCubes(instanceName, 'all');
        const out: { Name: string; rules: string }[] = [];
        let idx = 0;
        const worker = async () => {
            while (idx < cubes.length) {
                const name = cubes[idx++].Name;
                try { out.push({ Name: name, rules: await this.getRuleContent(instanceName, name) }); }
                catch { out.push({ Name: name, rules: '' }); }
            }
        };
        const conc = Math.min(8, cubes.length);
        await Promise.all(Array.from({ length: conc }, () => worker()));
        return out;
    }

    public async getProcessParameters(instanceName: string, processName: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(processName).replace(/'/g, "''");
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Processes('${encodedName}')?$select=Parameters`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            return response.data.Parameters || [];
        } catch (error: any) {
            console.error(`Error fetching parameters for ${processName}:`, error.message);
            throw new Error(`Failed to fetch parameters: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getAllProcessesDetails(instanceName: string, type: 'all' | 'normal' | 'control' = 'normal'): Promise<{ Name: string, Content: TM1ProcessContent }[]> {
        const cfg = this.getConfig(instanceName);
        let filterStr = '';
        if (type === 'normal') filterStr = "&$filter=not startswith(Name,'}')";
        else if (type === 'control') filterStr = "&$filter=startswith(Name,'}')";

        const response = await axios.get(`${cfg.url}/api/v1/Processes?$select=Name,PrologProcedure,MetadataProcedure,DataProcedure,EpilogProcedure,Parameters,DataSource,Variables,HasSecurityAccess${filterStr}`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        return response.data.value.map((item: any) => ({
            Name: item.Name,
            Content: {
                Prolog: item.PrologProcedure || '', Metadata: item.MetadataProcedure || '', Data: item.DataProcedure || '', Epilog: item.EpilogProcedure || '',
                PropertiesJSON: JSON.stringify({ Parameters: item.Parameters || [], DataSource: item.DataSource || {}, Variables: item.Variables || [], HasSecurityAccess: item.HasSecurityAccess || false }, null, 2)
            }
        }));
    }

    // Normalise a process' properties before saving. Fixes two things that make
    // TM1 reject the PATCH or PAW misbehave:
    //  - ASCII datasources written with generic property names by older builds
    //    are remapped to the ascii*-prefixed names TM1 requires.
    //  - Variables are emitted with only the valid ProcessVariable properties
    //    (Name, Type, Position, StartByte, EndByte), renumbered and de-duplicated,
    //    so a hand-added variable saves and shows in PAW.
    private normalizeProcessProperties(properties: any): any {
        if (!properties || typeof properties !== 'object') return properties;
        let result = properties;

        const ds = result.DataSource;
        if (ds && typeof ds === 'object' && (ds.Type === 'ASCII' || ds.Type === 'CHARACTERDELIMITED')) {
            const fixed: any = { ...ds };
            const remap: Record<string, string> = {
                dataSourceHeaderLines: 'asciiHeaderRecords',
                dataSourceColumnDelimiter: 'asciiDelimiterChar',
                dataSourceQuoteCharacter: 'asciiQuoteCharacter',
                dataSourceDecimalSeparator: 'asciiDecimalSeparator'
            };
            for (const bad of Object.keys(remap)) {
                if (fixed[bad] !== undefined) {
                    if (fixed[remap[bad]] === undefined) fixed[remap[bad]] = fixed[bad];
                    delete fixed[bad];
                }
            }
            result = { ...result, DataSource: fixed };
        }

        if (Array.isArray(result.Variables)) {
            const seen = new Set<string>();
            const cleaned: any[] = [];
            for (const v of result.Variables) {
                if (!v || typeof v !== 'object' || v.Name == null || v.Name === '') continue;
                const key = String(v.Name).toLowerCase();
                if (seen.has(key)) continue; // dedupe by name
                seen.add(key);
                const t = String(v.Type ?? '').toLowerCase();
                const type = (t === 'n' || t === 'numeric') ? 'Numeric' : 'String';
                cleaned.push({
                    Name: String(v.Name),
                    Type: type,
                    Position: cleaned.length + 1,
                    StartByte: Number.isFinite(v.StartByte) ? v.StartByte : 0,
                    EndByte: Number.isFinite(v.EndByte) ? v.EndByte : 0
                });
            }
            result = { ...result, Variables: cleaned };
        }
        return result;
    }

    public async updateProcessCode(instanceName: string, processName: string, code: any): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(processName).replace(/'/g, "''");
        let properties: any = {};
        try { if (code.PropertiesJSON) properties = JSON.parse(code.PropertiesJSON); } catch (e) { throw new Error("JSON Syntax Error"); }
        properties = this.normalizeProcessProperties(properties);

        try {
            await axios.patch(`${cfg.url}/api/v1/Processes('${encodedName}')`, {
                PrologProcedure: code.Prolog, MetadataProcedure: code.Metadata, DataProcedure: code.Data, EpilogProcedure: code.Epilog, ...properties
            }, { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName) });
        } catch (error: any) {
            if (error.response && error.response.status === 404) {
                throw new Error("PROCESS_NOT_FOUND");
            }
            throw new Error(`Update failed: ${error.response?.data?.error?.message || error.message}`);
        }

        const cRes = await axios.post(`${cfg.url}/api/v1/Processes('${encodedName}')/tm1.Compile`, {}, { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName) });
        const errors = cRes.data.value as ProcessSyntaxError[];
        if (errors && errors.length > 0) {
            const err: any = new Error(`Syntax Error:\n${errors.map(e => `[${e.Procedure}] Line ${e.LineNumber}: ${e.Message}`).join('\n')}`);
            err.syntaxErrors = errors;
            throw err;
        }
    }

    public async createProcess(instanceName: string, processName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const url = `${cfg.url}/api/v1/Processes`;
        const payload = {
            Name: processName,
            HasSecurityAccess: false,
            PrologProcedure: "",
            MetadataProcedure: "",
            DataProcedure: "",
            EpilogProcedure: ""
        };

        try {
            await axios.post(url, payload, {
                httpsAgent: this.httpsAgent,
                headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }
            });
        } catch (error: any) {
            console.error(`Error creating process ${processName}:`, error.message);
            const tm1Error = error.response?.data?.error?.message || error.message;
            throw new Error(`Create Process failed: ${tm1Error}`);
        }
    }

    public async executeProcess(instanceName: string, processName: string, parameters: any[] = [], signal?: AbortSignal): Promise<any> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(processName).replace(/'/g, "''");
        try {
            const response = await axios.post(`${cfg.url}/api/v1/Processes('${encodedName}')/tm1.ExecuteWithReturn?$expand=ErrorLogFile`, {
                "Parameters": parameters
            }, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName),
                ...(signal ? { signal } : {})
            });
            return response.data;
        } catch (error: any) {
            if (error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
                throw new Error("PROCESS_CANCELLED");
            }
            console.error(`Error executing process ${processName}:`, error.message);
            throw new Error(`Execution failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async cancelProcessExecution(instanceName: string, processName: string): Promise<boolean> {
        const cfg = this.getConfig(instanceName);
        try {
            const threadsResponse = await axios.get(`${cfg.url}/api/v1/Threads`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            const threads = threadsResponse.data.value || [];
            const thread = threads.find((t: any) =>
                t.Function && t.Function.includes(processName) &&
                (t.Function.includes('ExecuteWithReturn') || t.Function.includes('Execute'))
            );
            if (thread) {
                await axios.post(`${cfg.url}/api/v1/Threads('${thread.ID}')/tm1.CancelOperation`, {}, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
                });
                return true;
            }
            return false;
        } catch (error: any) {
            console.error(`Error cancelling process ${processName}:`, error.message);
            throw new Error(`Cancel failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getThreads(instanceName: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Threads`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            return response.data.value || [];
        } catch (error: any) {
            throw new Error(`Failed to get threads: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async cancelThread(instanceName: string, threadId: string | number): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            await axios.post(`${cfg.url}/api/v1/Threads('${threadId}')/tm1.CancelOperation`, {}, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
        } catch (error: any) {
            throw new Error(`Failed to cancel thread ${threadId}: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getErrorLog(instanceName: string, logFileName: string): Promise<string> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(logFileName).replace(/'/g, "''");
        try {
            // First try ErrorLogFiles endpoint (standard for TM1 11/12)
            try {
                // In some versions it is /$value, in others /Content
                const response = await axios.get(`${cfg.url}/api/v1/ErrorLogFiles('${encodedName}')/$value`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
                });
                return response.data;
            } catch (e) {
                // Fallback to Content property just in case
                const response = await axios.get(`${cfg.url}/api/v1/ErrorLogFiles('${encodedName}')/Content`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
                });
                return response.data;
            }
        } catch (error: any) {
            console.error(`Error fetching log ${logFileName}:`, error.message);
            throw new Error(`Could not load log file: ${logFileName}`);
        }
    }

    public async getLatestErrorLog(instanceName: string, processName: string): Promise<{ filename: string, content: string } | null> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/ErrorLogFiles`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });

            const logs = response.data.value || [];
            if (logs.length === 0) return null;

            const cleanProcessName = processName.replace(/ /g, '');
            const processLogs = logs.filter((l: any) => {
                const name = l.Filename || l.Name || "";
                return name.includes(processName) || name.replace(/ /g, '').includes(cleanProcessName);
            });

            if (processLogs.length === 0) return null;

            processLogs.sort((a: any, b: any) => {
                const dateA = new Date(a.LastModified || 0).getTime();
                const dateB = new Date(b.LastModified || 0).getTime();
                return dateB - dateA; // descending
            });

            const latestLogName = processLogs[0].Filename || processLogs[0].Name;
            const content = await this.getErrorLog(instanceName, latestLogName);
            return { filename: latestLogName, content };

        } catch (e: any) {
            console.error(`Error searching for latest log for ${processName}:`, e.message);
            throw new Error(`Fallback TM1 ErrorLogFiles API failed: ${e.response?.status} ${e.response?.data?.error?.message || e.message}`);
        }
    }

    // --- MESSAGE LOG ---
    public async getMessageLogEntries(instanceName: string, top: number = 200): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            // Fetches the latest 'top' entries, descending by timestamp
            const response = await axios.get(`${cfg.url}/api/v1/MessageLogEntries?$top=${top}&$orderby=TimeStamp desc`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            // Return sorted ascending so the log reads top-to-bottom chronologically
            return (response.data.value || []).reverse();
        } catch (error: any) {
            console.error(`Error fetching message log for ${instanceName}:`, error.message);
            throw new Error(`Failed to fetch message log: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // Message-log entries within a lookback window (ascending), for process-run
    // analysis. Capped by `top` to stay responsive on busy servers.
    public async getMessageLogEntriesWindow(instanceName: string, sinceIso: string, top: number = 20000): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        const filterStr = encodeURIComponent(`TimeStamp ge ${sinceIso}`);
        const response = await axios.get(
            `${cfg.url}/api/v1/MessageLogEntries?$filter=${filterStr}&$orderby=TimeStamp asc&$top=${top}`,
            { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 120000 }
        );
        return response.data.value || [];
    }

    public async getMessageLogEntriesSince(instanceName: string, timestamp: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            // Filters for entries strictly newer than the given timestamp
            const filterStr = encodeURIComponent(`TimeStamp gt ${timestamp}`);
            // Fetch all newer, ordered ascending
            const response = await axios.get(`${cfg.url}/api/v1/MessageLogEntries?$filter=${filterStr}&$orderby=TimeStamp asc`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            return response.data.value || [];
        } catch (error: any) {
            console.error(`Error fetching message log delta for ${instanceName}:`, error.message);
            return []; // Return empty on delta error to avoid breaking the polling loop
        }
    }

    public async getMessageLogEntriesBefore(instanceName: string, timestamp: string, top: number = 1000): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const filterStr = encodeURIComponent(`TimeStamp lt ${timestamp}`);
            const response = await axios.get(`${cfg.url}/api/v1/MessageLogEntries?$filter=${filterStr}&$top=${top}&$orderby=TimeStamp desc`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            return (response.data.value || []).reverse();
        } catch (error: any) {
            throw new Error(`Failed to fetch older log entries: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- CUBES & RULES (FINAL FIX) ---

    public async getCubes(instanceName: string, type: 'all' | 'normal' | 'control' = 'normal'): Promise<TM1Object[]> {
        const cfg = this.getConfig(instanceName);
        let filterStr = '';
        if (type === 'normal') filterStr = "&$filter=not startswith(Name,'}')";
        else if (type === 'control') filterStr = "&$filter=startswith(Name,'}')";

        try {
            const response = await axios.get(`${cfg.url}/api/v1/Cubes?$select=Name${filterStr}`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            this.updateCookieFromResponse(instanceName, response);
            if (!response.data || !response.data.value) {
                const responseStr = typeof response.data === 'string' ? response.data.substring(0, 200) : JSON.stringify(response.data);
                console.error(`[TM1 API Error] Unexpected response format for getCubes:`, response.data);
                throw new Error(`Unexpected response from server: ${responseStr}...`);
            }
            return (response.data.value as TM1Object[]).sort((a, b) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            this.handleError(instanceName, 'getCubes', error);
            throw new Error(`getCubes failed: ${error.response?.status} - ${error.message}`);
        }
    }

    public async getRuleContent(instanceName: string, cubeName: string): Promise<string> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(cubeName).replace(/'/g, "''");

        // Dein funktionierender Pfad
        const url = `${cfg.url}/api/v1/Cubes('${encodedName}')/Rules`;

        try {
            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent,
                headers: { ...this.getHeaders(instanceName), 'Accept': 'application/json' }
            });

            const data = response.data;

            // CASE 1: value ist direkt der String (Dein Szenario)
            if (typeof data.value === 'string') {
                return data.value;
            }

            // CASE 2: value ist Array (Standard OData Collection)
            if (data.value && Array.isArray(data.value)) {
                if (data.value.length > 0 && data.value[0].Rules) return data.value[0].Rules;
                return "";
            }

            // CASE 3: Direktes Rules Property
            if (data.Rules) return data.Rules;

            return "";

        } catch (error: any) {
            // 404 -> Keine Rule
            if (error.response && error.response.status === 404) return "";
            // Andere Fehler werfen
            throw new Error(`Error with Rule ${cubeName}: ${error.message}`);
        }
    }

    public async updateRule(instanceName: string, cubeName: string, ruleContent: string, signal?: AbortSignal): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(cubeName).replace(/'/g, "''");

        const url = `${cfg.url}/api/v1/Cubes('${encodedName}')`;
        const payload = { Rules: ruleContent };

        try {
            await axios.patch(url, payload, {
                httpsAgent: this.httpsAgent,
                headers: {
                    ...this.getHeaders(instanceName),
                    'Content-Type': 'application/json'
                },
                signal
            });
        } catch (error: any) {
            if (axios.isCancel(error) || error.code === 'ERR_CANCELED') throw new Error('RULE_SAVE_CANCELLED');
            console.error(`Error saving rule for ${cubeName}:`, error.message);
            const rawMsg = error.response?.data?.error?.message;
            const tm1Error = (typeof rawMsg === 'object' && rawMsg?.value) ? rawMsg.value : (rawMsg || error.message);

            this._throwRuleSyntaxError(tm1Error);
            throw new Error(`Save failed: ${tm1Error}`);
        }

        // Post-save: Check rule compilation via tm1.CheckRules (equivalent to tm1.Compile for processes)
        const checkUrl = `${cfg.url}/api/v1/Cubes('${encodedName}')/tm1.CheckRules`;
        const checkResp = await axios.post(checkUrl, {}, {
            httpsAgent: this.httpsAgent,
            headers: this.getHeaders(instanceName)
        });
        const errors = checkResp.data?.value;
        if (errors && errors.length > 0) {
            const firstErr = errors[0];
            const lineNumber = firstErr.LineNumber ?? firstErr.Line ?? 1;
            const message = firstErr.Message ?? firstErr.Description ?? JSON.stringify(firstErr);
            const err: any = new Error(`Rule Syntax Error:\n${errors.map((e: any) => `Line ${e.LineNumber ?? e.Line ?? '?'}: ${e.Message ?? e.Description ?? JSON.stringify(e)}`).join('\n')}`);
            err.ruleSyntaxError = {
                LineNumber: lineNumber,
                Message: message
            };
            throw err;
        }
    }

    private _throwRuleSyntaxError(tm1Error: string): void {
        // Parse line number from TM1 rule error messages
        // Typical formats: "...line 5: ..." or "...Line: 5 ..." or "Error at line 5, ..."
        const lineMatch = tm1Error.match(/line[:\s]+?(\d+)/i);
        if (lineMatch) {
            const err: any = new Error(`Syntax Error: ${tm1Error}`);
            err.ruleSyntaxError = {
                LineNumber: parseInt(lineMatch[1], 10),
                Message: tm1Error
            };
            throw err;
        }
    }

    /** Returns the ordered dimension names of a cube. */
    public async getCubeDimensionNames(instanceName: string, cubeName: string): Promise<string[]> {
        const cfg = this.getConfig(instanceName);
        const enc = encodeURIComponent(cubeName).replace(/'/g, "''");
        const resp = await axios.get(`${cfg.url}/api/v1/Cubes('${enc}')/Dimensions?$select=Name`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
        });
        this.updateCookieFromResponse(instanceName, resp);
        return (resp.data?.value || []).map((d: any) => d.Name);
    }

    /**
     * Validates cube rule text WITHOUT saving (and without re-feeding the real
     * cube): creates a throwaway cube with the same dimensions, applies the rule
     * there so TM1 compiles it, runs tm1.CheckRules, then deletes the temp cube.
     * The empty temp cube makes feeder processing instant, so the real cube is
     * only ever saved once — with valid, correct rules.
     */
    public async checkRuleSyntax(instanceName: string, cubeName: string, rules: string): Promise<{ ok: boolean; message: string }> {
        const dims = await this.getCubeDimensionNames(instanceName, cubeName);
        if (!dims.length) throw new Error(`Cube '${cubeName}' not found or has no dimensions.`);
        const cfg = this.getConfig(instanceName);
        const tempCube = '}pa-code.rulecheck.' + Date.now() + '.' + Math.floor(Math.random() * 1e6);
        await this.createCube(instanceName, tempCube, dims);
        try {
            const enc = encodeURIComponent(tempCube).replace(/'/g, "''");
            let compileError = '';
            try {
                await axios.patch(`${cfg.url}/api/v1/Cubes('${enc}')`, { Rules: rules }, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
                });
            } catch (e: any) {
                const raw = e.response?.data?.error?.message;
                compileError = (typeof raw === 'object' && raw?.value) ? raw.value : (raw || e.message);
            }
            let errors: any[] = [];
            try {
                const resp = await axios.post(`${cfg.url}/api/v1/Cubes('${enc}')/tm1.CheckRules`, {}, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
                });
                errors = resp.data?.value || [];
            } catch { /* ignore — fall back to the compile error */ }
            if (errors.length) {
                return { ok: false, message: errors.map((er: any) => `Line ${er.LineNumber ?? er.Line ?? '?'}: ${er.Message ?? er.Description ?? JSON.stringify(er)}`).join('\n') };
            }
            if (compileError) { return { ok: false, message: compileError }; }
            return { ok: true, message: 'Rule syntax OK.' };
        } finally {
            try { await this.deleteCube(instanceName, tempCube); } catch { /* best-effort cleanup */ }
        }
    }

    /**
     * Pull All mit "Chunking" (Stapelverarbeitung), um 460 Requests zu bewältigen
     */
    public async getAllRulesDetails(instanceName: string, type: 'all' | 'normal' | 'control' = 'normal'): Promise<{ CubeName: string, Content: string }[]> {
        const cfg = this.getConfig(instanceName);

        let filterStr = '';
        if (type === 'normal') filterStr = "&$filter=not startswith(Name,'}')";
        else if (type === 'control') filterStr = "&$filter=startswith(Name,'}')";

        // 1. Liste aller Cubes
        const response = await axios.get(`${cfg.url}/api/v1/Cubes?$select=Name${filterStr}`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        const cubes = response.data.value;

        const results: { CubeName: string, Content: string }[] = [];

        // 2. In 20er Häppchen verarbeiten
        const chunkSize = 20;
        for (let i = 0; i < cubes.length; i += chunkSize) {
            const chunk = cubes.slice(i, i + chunkSize);

            const tasks = chunk.map(async (cube: any) => {
                try {
                    const content = await this.getRuleContent(instanceName, cube.Name);
                    if (content && content.trim().length > 0) {
                        return { CubeName: cube.Name, Content: content };
                    }
                } catch (e) { /* ignore */ }
                return null;
            });

            const chunkResults = await Promise.all(tasks);
            const valid = chunkResults.filter((r): r is { CubeName: string, Content: string } => r !== null);
            results.push(...valid);
        }

        return results;
    }

    // --- INTELLISENSE: Cubes, Dimensions, Elements ---
    public async getCubeNames(instanceName: string): Promise<string[]> {
        if (this.cubeCache.has(instanceName)) return this.cubeCache.get(instanceName)!;
        const cfg = this.getConfig(instanceName);
        const res = await axios.get(`${cfg.url}/api/v1/Cubes?$select=Name&$top=5000`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000
        });
        const names: string[] = (res.data.value || []).map((c: any) => c.Name as string);
        this.cubeCache.set(instanceName, names);
        return names;
    }

    public async getDimensionNames(instanceName: string): Promise<string[]> {
        if (this.dimensionCache.has(instanceName)) return this.dimensionCache.get(instanceName)!;
        const cfg = this.getConfig(instanceName);
        const res = await axios.get(`${cfg.url}/api/v1/Dimensions?$select=Name&$top=5000`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000
        });
        const names: string[] = (res.data.value || []).map((d: any) => d.Name as string);
        this.dimensionCache.set(instanceName, names);
        return names;
    }

    public async getElementNames(instanceName: string, dimensionName: string): Promise<string[]> {
        if (!this.elementCache.has(instanceName)) this.elementCache.set(instanceName, new Map());
        const dimMap = this.elementCache.get(instanceName)!;
        if (dimMap.has(dimensionName)) return dimMap.get(dimensionName)!;
        const cfg = this.getConfig(instanceName);
        const encoded = encodeURIComponent(dimensionName);
        const res = await axios.get(
            `${cfg.url}/api/v1/Dimensions('${encoded}')/Hierarchies('${encoded}')/Elements?$select=Name&$top=5000`,
            { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
        );
        const names: string[] = (res.data.value || []).map((e: any) => e.Name as string);
        dimMap.set(dimensionName, names);
        return names;
    }

    public async getSubsetNames(instanceName: string, dimensionName: string): Promise<string[]> {
        if (!this.subsetCache.has(instanceName)) this.subsetCache.set(instanceName, new Map());
        const dimMap = this.subsetCache.get(instanceName)!;
        if (dimMap.has(dimensionName)) return dimMap.get(dimensionName)!;
        const cfg = this.getConfig(instanceName);
        const encoded = encodeURIComponent(dimensionName);
        const res = await axios.get(
            `${cfg.url}/api/v1/Dimensions('${encoded}')/Hierarchies('${encoded}')/Subsets?$select=Name&$top=1000`,
            { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
        );
        const names: string[] = (res.data.value || []).map((s: any) => s.Name as string);
        dimMap.set(dimensionName, names);
        return names;
    }

    public async getAttributeNames(instanceName: string, dimensionName: string): Promise<string[]> {
        if (!this.attributeCache.has(instanceName)) this.attributeCache.set(instanceName, new Map());
        const dimMap = this.attributeCache.get(instanceName)!;
        if (dimMap.has(dimensionName)) return dimMap.get(dimensionName)!;
        const cfg = this.getConfig(instanceName);
        const encoded = encodeURIComponent(dimensionName);
        const res = await axios.get(
            `${cfg.url}/api/v1/Dimensions('${encoded}')/Hierarchies('${encoded}')/ElementAttributes?$select=Name&$top=1000`,
            { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
        );
        const names: string[] = (res.data.value || []).map((a: any) => a.Name as string);
        dimMap.set(dimensionName, names);
        return names;
    }

    public clearIntelliSenseCache(instanceName?: string): void {
        if (instanceName) {
            this.cubeCache.delete(instanceName);
            this.dimensionCache.delete(instanceName);
            this.elementCache.delete(instanceName);
            this.subsetCache.delete(instanceName);
            this.attributeCache.delete(instanceName);
        } else {
            this.cubeCache.clear();
            this.dimensionCache.clear();
            this.elementCache.clear();
            this.subsetCache.clear();
            this.attributeCache.clear();
        }
    }

    // --- TI DEBUGGING ---

    /**
     * Get all TM1 server configuration parameters (flat, read-only).
     */
    public async getConfiguration(instanceName: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Configuration`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            this.handleError(instanceName, 'getConfiguration', error);
            throw new Error(`Failed to load configuration: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Get TM1 static configuration (nested structure matching tm1s.cfg sections, writable).
     */
    public async getStaticConfiguration(instanceName: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/StaticConfiguration`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            this.handleError(instanceName, 'getStaticConfiguration', error);
            throw new Error(`Failed to load static configuration: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Update one or more TM1 server configuration parameters via StaticConfiguration.
     * Updates the .cfg file and triggers TM1 to re-read it.
     * params should be in nested format: { "SectionName": { "ParamName": value } }
     */
    public async updateConfigurationParameter(instanceName: string, params: Record<string, any>): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            await axios.patch(`${cfg.url}/api/v1/StaticConfiguration`, params, {
                httpsAgent: this.httpsAgent,
                headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }
            });
        } catch (error: any) {
            this.handleError(instanceName, 'updateConfigurationParameter', error);
            throw new Error(`Failed to update configuration: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Find which section a parameter belongs to in StaticConfiguration,
     * then update it via PATCH with the correct nested structure.
     * If the parameter is not found (unset/default), tries each section until one succeeds.
     */
    public async updateConfigurationParameterByName(instanceName: string, paramName: string, value: any, section?: string): Promise<void> {
        const staticConfig = await this.getStaticConfiguration(instanceName);

        // Handle dot-separated names (e.g., "TI.EnableTIDebugging" from sub-sections)
        const nameParts = paramName.split('.');
        const leafName = nameParts[nameParts.length - 1];

        // Deep recursive search using the leaf parameter name
        const path = this._findParamPath(staticConfig, leafName);
        if (path) {
            let body: any = value;
            for (let i = path.length - 1; i >= 0; i--) {
                body = { [path[i]]: body };
            }
            await this.updateConfigurationParameter(instanceName, body);
            return;
        }

        // Parameter not found in current config (may be unset with default value).
        // Build properly nested body from name parts.
        const buildNestedBody = (parts: string[], val: any): any => {
            let body: any = val;
            for (let i = parts.length - 1; i >= 0; i--) {
                body = { [parts[i]]: body };
            }
            return body;
        };

        // If section is known, try it first with proper nesting
        if (section) {
            try {
                await this.updateConfigurationParameter(instanceName, { [section]: buildNestedBody(nameParts, value) });
                return;
            } catch {
                // Fall through to brute force
            }
        }

        // Try each top-level section until PATCH succeeds.
        const sections = Object.keys(staticConfig).filter(k =>
            !k.startsWith('@odata') && !k.startsWith('odata') &&
            staticConfig[k] && typeof staticConfig[k] === 'object' && !Array.isArray(staticConfig[k])
        );

        for (const sec of sections) {
            try {
                await this.updateConfigurationParameter(instanceName, { [sec]: buildNestedBody(nameParts, value) });
                return;
            } catch {
                // Section didn't accept this parameter, try next
            }
        }

        throw new Error(`Parameter '${paramName}' could not be set in any configuration section.`);
    }

    private _findParamPath(obj: any, target: string, path: string[] = []): string[] | null {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
        for (const [key, val] of Object.entries(obj)) {
            if (key.startsWith('@odata') || key.startsWith('odata')) continue;
            if (key === target && (typeof val !== 'object' || val === null)) {
                return [...path, key];
            }
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                const found = this._findParamPath(val, target, [...path, key]);
                if (found) return found;
            }
        }
        return null;
    }

    /**
     * Check if EnableTIDebugging is set to true on the server.
     */
    public async checkTIDebuggingEnabled(instanceName: string): Promise<boolean> {
        const cfg = this.getConfig(instanceName);
        try {
            // Check the active (effective) configuration first
            const response = await axios.get(`${cfg.url}/api/v1/ActiveConfiguration`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 10000
            });
            this.updateCookieFromResponse(instanceName, response);
            // Search recursively for EnableTIDebugging in the nested response
            const val = this._findValueInConfig(response.data, 'EnableTIDebugging');
            if (val !== undefined) {
                return val === true || val === 'T' || val === 'true' || val === 't';
            }
            // Fallback: check flat Configuration endpoint
            const flatResponse = await axios.get(`${cfg.url}/api/v1/Configuration`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 10000
            });
            this.updateCookieFromResponse(instanceName, flatResponse);
            const flatVal = flatResponse.data?.EnableTIDebugging;
            if (flatVal !== undefined) {
                return flatVal === true || flatVal === 'T' || flatVal === 'true' || flatVal === 't';
            }
            // Parameter not found at all — assume disabled
            return false;
        } catch (error: any) {
            // If we can't check, let the debug call itself fail with a more specific error
            return true;
        }
    }

    private _findValueInConfig(obj: any, target: string): any {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
        for (const [key, val] of Object.entries(obj)) {
            if (key === target && (typeof val !== 'object' || val === null)) {
                return val;
            }
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                const found = this._findValueInConfig(val, target);
                if (found !== undefined) return found;
            }
        }
        return undefined;
    }

    /**
     * Start a debug session for a TI process. Returns the ProcessDebugContext including the debug ID.
     */
    public async debugProcess(instanceName: string, processName: string, parameters: any[] = []): Promise<any> {
        const cfg = this.getConfig(instanceName);
        const encodedName = encodeURIComponent(processName).replace(/'/g, "''");
        const url = `${cfg.url}/api/v1/Processes('${encodedName}')/tm1.Debug?$expand=Breakpoints,Thread,CallStack($expand=Variables,Process($select=Name))`;
        try {
            const response = await axios.post(url, { Parameters: parameters }, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            this.handleError(instanceName, 'debugProcess', error);
            throw new Error(`Debug failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Fetch current debug context state (CallStack, Variables, Breakpoints).
     */
    public async debugGetState(instanceName: string, debugId: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        const url = `${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')?$expand=Breakpoints,Thread,CallStack($expand=Variables,Process($select=Name))`;
        try {
            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            this.handleError(instanceName, 'debugGetState', error);
            throw new Error(`Debug get state failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Step Over: execute next line; if it's ExecuteProcess, do NOT step into it.
     */
    public async debugStepOver(instanceName: string, debugId: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        await axios.post(`${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/tm1.StepOver`, {}, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        // Small delay for TM1 to process (required for TM1 <= 11.8)
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.debugGetState(instanceName, debugId);
    }

    /**
     * Step In: if next line is ExecuteProcess, step into the sub-process.
     */
    public async debugStepIn(instanceName: string, debugId: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        await axios.post(`${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/tm1.StepIn`, {}, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.debugGetState(instanceName, debugId);
    }

    /**
     * Step Out: resume execution until the current process finishes.
     */
    public async debugStepOut(instanceName: string, debugId: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        await axios.post(`${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/tm1.StepOut`, {}, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.debugGetState(instanceName, debugId);
    }

    /**
     * Continue: resume execution until the next breakpoint or end.
     */
    public async debugContinue(instanceName: string, debugId: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        await axios.post(`${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/tm1.Continue`, {}, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
        });
        await new Promise(resolve => setTimeout(resolve, 100));
        return this.debugGetState(instanceName, debugId);
    }

    /**
     * Add breakpoints to a debug session.
     * Each breakpoint: { "@odata.type": "#ibm.tm1.api.v1.ProcessDebugContextLineBreakpoint", ID, Enabled, HitMode, Expression, ProcessName, Procedure, LineNumber }
     */
    public async debugAddBreakpoints(instanceName: string, debugId: string, breakpoints: any[]): Promise<any> {
        const cfg = this.getConfig(instanceName);
        const url = `${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/Breakpoints`;
        try {
            const response = await axios.post(url, breakpoints, {
                httpsAgent: this.httpsAgent,
                headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            this.handleError(instanceName, 'debugAddBreakpoints', error);
            throw new Error(`Add breakpoints failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Remove a breakpoint from a debug session.
     */
    public async debugRemoveBreakpoint(instanceName: string, debugId: string, breakpointId: number): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const url = `${cfg.url}/api/v1/ProcessDebugContexts('${debugId}')/Breakpoints('${breakpointId}')`;
        try {
            await axios.delete(url, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName)
            });
        } catch (error: any) {
            this.handleError(instanceName, 'debugRemoveBreakpoint', error);
            throw new Error(`Remove breakpoint failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- FILE MANAGER ---

    private static readonly VIRTUAL_ERROR_LOGS = '##ErrorLogs##';

    /**
     * List files and folders in a given path via the Contents API.
     * path = '' for root (lists top-level folders + virtual Error Logs folder),
     * or 'Blobs/subfolder' for deeper paths.
     */
    public async getFileContents(instanceName: string, folderPath: string = ''): Promise<any[]> {
        const cfg = this.getConfig(instanceName);

        // Virtual Error Logs folder
        if (folderPath === TM1Service.VIRTUAL_ERROR_LOGS) {
            return this._getErrorLogFileList(instanceName);
        }

        if (!folderPath) {
            // Root level: list all top-level containers + virtual folders
            const url = `${cfg.url}/api/v1/Contents`;
            try {
                const response = await axios.get(url, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                });
                const items = response.data.value || [];
                // Add virtual Error Logs folder
                items.push({
                    Name: 'Error Logs',
                    '@odata.type': '#ibm.tm1.api.v1.Folder',
                    _virtualPath: TM1Service.VIRTUAL_ERROR_LOGS
                });
                return items;
            } catch (error: any) {
                throw new Error(`Failed to list files: ${error.response?.data?.error?.message || error.message}`);
            }
        } else {
            // Inside a folder: /api/v1/Contents('folder1')/Contents('folder2')/Contents
            const parts = folderPath.split('/').filter(p => p.length > 0);
            let url = `${cfg.url}/api/v1`;
            for (const part of parts) {
                const encoded = encodeURIComponent(part).replace(/'/g, "''");
                url += `/Contents('${encoded}')`;
            }
            url += '/Contents';
            try {
                const response = await axios.get(url, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                });
                return response.data.value || [];
            } catch (error: any) {
                throw new Error(`Failed to list files: ${error.response?.data?.error?.message || error.message}`);
            }
        }
    }

    /**
     * Get file content as binary (Buffer).
     * filePath e.g. 'Blobs/myfile.txt' or '##ErrorLogs##/TM1ProcessError_xxx.log'
     */
    public async getFileContent(instanceName: string, filePath: string): Promise<Buffer> {
        // Error log file
        if (filePath.startsWith(TM1Service.VIRTUAL_ERROR_LOGS + '/')) {
            const logName = filePath.substring(TM1Service.VIRTUAL_ERROR_LOGS.length + 1);
            const content = await this.getErrorLog(instanceName, logName);
            return Buffer.from(content, 'utf-8');
        }

        const cfg = this.getConfig(instanceName);
        const parts = filePath.split('/').filter(p => p.length > 0);
        let url = `${cfg.url}/api/v1`;
        for (const part of parts) {
            const encoded = encodeURIComponent(part).replace(/'/g, "''");
            url += `/Contents('${encoded}')`;
        }
        url += '/Content';
        try {
            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName),
                responseType: 'arraybuffer', timeout: 60000
            });
            return Buffer.from(response.data);
        } catch (error: any) {
            throw new Error(`Failed to get file: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * List all error log files via /api/v1/ErrorLogFiles.
     * Returns items shaped like Contents API entries.
     */
    private async _getErrorLogFileList(instanceName: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/ErrorLogFiles`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            const logs = response.data.value || [];
            return logs.map((l: any) => ({
                Name: l.Filename || l.Name || '',
                '@odata.type': '#ibm.tm1.api.v1.Document',
                Size: l.Size ?? null,
                LastUpdated: l.LastModified || l.LastUpdated || null
            }));
        } catch (error: any) {
            throw new Error(`Failed to list error logs: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- SECURITY GROUPS ---

    public async getSecurityGroups(instanceName: string): Promise<{ Name: string; Users: { Name: string; FriendlyName?: string }[] }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Groups?$expand=Users($select=Name,FriendlyName)&$select=Name`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get security groups: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getUsers(instanceName: string): Promise<{ Name: string; FriendlyName?: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Users?$select=Name,FriendlyName`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get users: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Users plus an `isAdmin` flag (member of a TM1 admin group). Used to offer a
     * searchable impersonation picker and to warn that TM1 forbids impersonating
     * administrators (which fails with 403).
     */
    public async getUsersForImpersonation(instanceName: string): Promise<{ Name: string; FriendlyName?: string; isAdmin: boolean }[]> {
        const cfg = this.getConfig(instanceName);
        const response = await axios.get(`${cfg.url}/api/v1/Users?$select=Name,FriendlyName&$expand=Groups($select=Name)`, {
            httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
        });
        this.updateCookieFromResponse(instanceName, response);
        const adminGroups = new Set(['ADMIN', 'DATAADMIN', 'SECURITYADMIN', 'OPERATIONSADMIN']);
        return (response.data.value || []).map((u: any) => ({
            Name: u.Name,
            FriendlyName: u.FriendlyName,
            isAdmin: (u.Groups || []).some((g: any) => adminGroups.has(String(g.Name || '').toUpperCase()))
        })).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
    }

    public async addUserToGroup(instanceName: string, userName: string, groupName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            // Read current groups of the user
            const userRes = await axios.get(
                `${cfg.url}/api/v1/Users('${encodeURIComponent(userName)}')?$expand=Groups($select=Name)`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, userRes);

            const currentGroups: string[] = (userRes.data.Groups || []).map((g: any) => g.Name);
            if (currentGroups.includes(groupName)) return; // already a member

            // Build full list including the new group
            const allGroups = [...currentGroups, groupName].map(g => ({ '@odata.id': `Groups('${g}')` }));

            const response = await axios.patch(
                `${cfg.url}/api/v1/Users('${encodeURIComponent(userName)}')`,
                { Groups: allGroups },
                { httpsAgent: this.httpsAgent, headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to add user '${userName}' to group '${groupName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async removeUserFromGroup(instanceName: string, userName: string, groupName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            // Read current groups of the user
            const userRes = await axios.get(
                `${cfg.url}/api/v1/Users('${encodeURIComponent(userName)}')?$expand=Groups($select=Name)`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, userRes);

            const currentGroups: string[] = (userRes.data.Groups || []).map((g: any) => g.Name);
            if (!currentGroups.includes(groupName)) return; // not a member

            // Build list without the target group
            const remainingGroups = currentGroups.filter(g => g !== groupName).map(g => ({ '@odata.id': `Groups('${g}')` }));

            const response = await axios.patch(
                `${cfg.url}/api/v1/Users('${encodeURIComponent(userName)}')`,
                { Groups: remainingGroups },
                { httpsAgent: this.httpsAgent, headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to remove user '${userName}' from group '${groupName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async createUser(instanceName: string, userName: string, friendlyName?: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const body: any = { Name: userName };
            if (friendlyName) body.FriendlyName = friendlyName;
            const response = await axios.post(
                `${cfg.url}/api/v1/Users`,
                body,
                { httpsAgent: this.httpsAgent, headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create user '${userName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteUser(instanceName: string, userName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Users('${encodeURIComponent(userName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete user '${userName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async createGroup(instanceName: string, groupName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.post(
                `${cfg.url}/api/v1/Groups`,
                { Name: groupName },
                { httpsAgent: this.httpsAgent, headers: { ...this.getHeaders(instanceName), 'Content-Type': 'application/json' }, timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create group '${groupName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteGroup(instanceName: string, groupName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Groups('${encodeURIComponent(groupName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete group '${groupName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- MDX WIZARD: DIMENSIONS & HIERARCHIES ---

    public async getDimensions(instanceName: string): Promise<{ Name: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(`${cfg.url}/api/v1/Dimensions?$select=Name`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get dimensions: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getCubeDimensions(instanceName: string, cubeName: string): Promise<{ Name: string; Hierarchies: { Name: string }[] }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Cubes('${encodeURIComponent(cubeName)}')/Dimensions?$select=Name&$expand=Hierarchies($select=Name)`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data.value || [];
        } catch (error: any) {
            throw new Error(`Failed to get cube dimensions: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getHierarchies(instanceName: string, dimensionName: string): Promise<{ Name: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies?$select=Name`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data.value || [];
        } catch (error: any) {
            throw new Error(`Failed to get hierarchies: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getHierarchyAttributes(instanceName: string, dimensionName: string, hierarchyName: string): Promise<{ Name: string; Type: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/ElementAttributes?$select=Name,Type`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return response.data.value || [];
        } catch (error: any) {
            throw new Error(`Failed to get attributes: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getHierarchyLevelCount(instanceName: string, dimensionName: string, hierarchyName: string): Promise<number> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Levels/$count`, {
                httpsAgent: this.httpsAgent, headers: { ...this.getHeaders(instanceName), 'Accept': 'text/plain' }, timeout: 15000
            });
            this.updateCookieFromResponse(instanceName, response);
            return parseInt(response.data, 10) || 0;
        } catch {
            return 0;
        }
    }

    public async getConsolidatedElements(instanceName: string, dimensionName: string, hierarchyName: string): Promise<{ Name: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements?$select=Name&$filter=Type eq 3`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get elements: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getHierarchySubsets(instanceName: string, dimensionName: string, hierarchyName: string): Promise<{ Name: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Subsets?$select=Name`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get subsets: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getHierarchyElements(instanceName: string, dimensionName: string, hierarchyName: string, top: number = 5000): Promise<string[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Elements?$select=Name&$top=${top}`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).map((e: any) => e.Name);
        } catch (error: any) {
            throw new Error(`Failed to get elements: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- SUBSET EDITOR SUPPORT ---

    /**
     * Fetches all data needed to render the Subset Editor tree for a hierarchy:
     * elements (with Type/Level and all attribute values including aliases) and
     * the parent/child edges. Element Type: 1=Numeric (N), 2=String (S),
     * 3=Consolidated (C).
     */
    public async getSubsetEditorData(instanceName: string, dimensionName: string, hierarchyName: string, top: number = 50000): Promise<{
        elements: { Name: string; Type: number; Level: number; Attributes: Record<string, any> }[];
        edges: { ParentName: string; ComponentName: string; Weight: number }[];
        aliasAttributes: string[];
        attributes: { Name: string; Type: string }[];
    }> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const base = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')`;
        try {
            // Elements with attribute values. Some TM1 versions reject selecting the
            // open "Attributes" property — fall back to a plain element projection so
            // the tree still loads (aliases/attributes just won't be available).
            const fetchElements = async () => {
                try {
                    return await axios.get(`${base}/Elements?$select=Name,Type,Level,Attributes&$top=${top}`, {
                        httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
                    });
                } catch (e: any) {
                    return await axios.get(`${base}/Elements?$select=Name,Type,Level&$top=${top}`, {
                        httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
                    });
                }
            };
            const [elemResp, edgeResp, attrResp] = await Promise.all([
                fetchElements(),
                axios.get(`${base}/Edges?$select=ParentName,ComponentName,Weight&$top=${top * 4}`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
                }),
                axios.get(`${base}/ElementAttributes?$select=Name,Type`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                })
            ]);
            this.updateCookieFromResponse(instanceName, elemResp);

            const attributes = (attrResp.data.value || []).map((a: any) => ({ Name: a.Name, Type: a.Type }));
            // Attribute Type "Alias" identifies alias attributes
            const aliasAttributes = attributes.filter((a: any) => (a.Type || '').toLowerCase() === 'alias').map((a: any) => a.Name);

            return {
                elements: (elemResp.data.value || []).map((e: any) => ({
                    Name: e.Name,
                    Type: e.Type,
                    Level: e.Level,
                    Attributes: e.Attributes || {}
                })),
                edges: (edgeResp.data.value || []).map((e: any) => ({
                    ParentName: e.ParentName,
                    ComponentName: e.ComponentName,
                    Weight: e.Weight
                })),
                aliasAttributes,
                attributes
            };
        } catch (error: any) {
            throw new Error(`Failed to load subset editor data: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Returns the content of an existing subset: either its MDX expression
     * (dynamic subset) or the explicit list of element names (static subset).
     */
    public async getSubsetContent(instanceName: string, dimensionName: string, hierarchyName: string, subsetName: string, isPrivate: boolean = false): Promise<{ mdx: string | null; elements: string[] }> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const collection = isPrivate ? 'PrivateSubsets' : 'Subsets';
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/${collection}('${encodeURIComponent(subsetName)}')?$expand=Elements($select=Name)`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            const data = response.data;
            const mdx = data.Expression && data.Expression.trim().length > 0 ? data.Expression : null;
            const elements = (data.Elements || []).map((e: any) => e.Name);
            return { mdx, elements };
        } catch (error: any) {
            throw new Error(`Failed to load subset '${subsetName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Creates or updates a subset. When `mdx` is provided a dynamic subset is
     * stored, otherwise a static subset with the given element list.
     * `isPublic=false` stores it as a private subset.
     */
    public async saveSubset(instanceName: string, dimensionName: string, hierarchyName: string, subsetName: string, isPublic: boolean, options: { mdx?: string; elements?: string[] }): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const collection = isPublic ? 'Subsets' : 'PrivateSubsets';
        const collUrl = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/${collection}`;

        const body: any = { Name: subsetName };
        if (options.mdx && options.mdx.trim().length > 0) {
            body.Expression = options.mdx;
        } else {
            const elems = options.elements || [];
            body['Elements@odata.bind'] = elems.map(e =>
                `Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/Elements('${encodeURIComponent(e).replace(/'/g, "''")}')`);
        }

        try {
            await axios.post(collUrl, body, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
        } catch (error: any) {
            // If it already exists, update it via PATCH
            const status = error.response?.status;
            if (status === 409 || status === 500 || status === 400) {
                try {
                    const patchBody: any = {};
                    if (options.mdx && options.mdx.trim().length > 0) {
                        patchBody.Expression = options.mdx;
                    } else {
                        patchBody['Elements@odata.bind'] = body['Elements@odata.bind'];
                    }
                    await axios.patch(`${collUrl}('${encodeURIComponent(subsetName)}')`, patchBody, {
                        httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                    });
                    return;
                } catch (patchError: any) {
                    throw new Error(`Failed to save subset: ${patchError.response?.data?.error?.message || patchError.message}`);
                }
            }
            throw new Error(`Failed to save subset: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- VIEWS ---

    public async getViews(instanceName: string, cubeName: string): Promise<{ Name: string; type: string; isPrivate: boolean }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const cubeEnc = encodeURIComponent(cubeName);
            // Public views live under /Views, the user's private views under
            // /PrivateViews — both must be listed (private ones were missing before).
            const [pubRes, privRes] = await Promise.all([
                axios.get(`${cfg.url}/api/v1/Cubes('${cubeEnc}')/Views?$select=Name`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                }).catch(() => ({ data: { value: [] } })),
                axios.get(`${cfg.url}/api/v1/Cubes('${cubeEnc}')/PrivateViews?$select=Name`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                }).catch(() => ({ data: { value: [] } }))
            ]);
            this.updateCookieFromResponse(instanceName, pubRes as any);
            const views: { Name: string; type: string; isPrivate: boolean }[] = [];
            for (const v of (pubRes.data.value || [])) { views.push({ Name: v.Name, type: 'native', isPrivate: false }); }
            for (const v of (privRes.data.value || [])) { views.push({ Name: v.Name, type: 'native', isPrivate: true }); }
            // Public first, then private; alphabetical within each group.
            return views.sort((a, b) => (a.isPrivate === b.isPrivate) ? a.Name.localeCompare(b.Name) : (a.isPrivate ? 1 : -1));
        } catch (error: any) {
            throw new Error(`Failed to get views: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteView(instanceName: string, cubeName: string, viewName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Cubes('${encodeURIComponent(cubeName)}')/Views('${encodeURIComponent(viewName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete view '${viewName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- SUBSETS ---

    public async getSubsets(instanceName: string, dimensionName: string): Promise<{ Name: string }[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(dimensionName)}')/Subsets?$select=Name&$top=10000`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).sort((a: any, b: any) => a.Name.localeCompare(b.Name));
        } catch (error: any) {
            throw new Error(`Failed to get subsets: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteSubset(instanceName: string, dimensionName: string, subsetName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(dimensionName)}')/Subsets('${encodeURIComponent(subsetName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete subset '${subsetName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- DELETE PROCESS ---

    public async deleteProcess(instanceName: string, processName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Processes('${encodeURIComponent(processName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete process '${processName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Runs a one-off TI statement without leaving a process behind: creates a
     * temporary (control) process, compiles it, executes it, and deletes it
     * again — the "TI console" pattern used by Arc. `prolog` holds the code (the
     * Data tab can be used for row-loop code). Compile errors are thrown before
     * execution; a non-success run returns the TM1 error log when available.
     */
    public async executeTiCode(instanceName: string, prolog: string, data: string = ''): Promise<{ status: string; errorLog?: string }> {
        const tempName = '}pa-code.console.' + Date.now() + '.' + Math.floor(Math.random() * 1e6);
        await this.createProcess(instanceName, tempName);
        try {
            await this.updateProcessCode(instanceName, tempName, { Prolog: prolog, Metadata: '', Data: data, Epilog: '', PropertiesJSON: '' });
            const res = await this.executeProcess(instanceName, tempName);
            const status = String(res?.ProcessExecuteStatusCode || 'Unknown');
            let errorLog: string | undefined;
            const logName = res?.ErrorLogFile?.Filename || res?.ErrorLogFile?.Name;
            if (status !== 'CompletedSuccessfully' && logName) {
                try { errorLog = await this.getErrorLog(instanceName, logName); } catch { /* ignore */ }
            }
            return { status, errorLog };
        } finally {
            try { await this.deleteProcess(instanceName, tempName); } catch { /* best-effort cleanup */ }
        }
    }

    public async deleteCube(instanceName: string, cubeName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Cubes('${encodeURIComponent(cubeName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete cube '${cubeName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteDimension(instanceName: string, dimensionName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete dimension '${dimensionName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- MODEL BUILDING (WRITE) ---

    /** Maps a loose element-type hint (N/S/C, numeric/string/consolidated, 1/2/3) to the TM1 REST type name. */
    private normElemType(t?: string): 'Numeric' | 'String' | 'Consolidated' {
        const s = String(t == null ? '' : t).trim().toLowerCase();
        if (s.startsWith('c') || s === '3' || s === 'consolidated') return 'Consolidated';
        if (s.startsWith('s') || s === '2' || s === 'string') return 'String';
        return 'Numeric';
    }

    /** Creates a dimension with a single (leaves) hierarchy of the given name (defaults to the dimension name). */
    public async createDimension(instanceName: string, dimensionName: string, hierarchyName?: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const hier = hierarchyName || dimensionName;
        try {
            const response = await axios.post(`${cfg.url}/api/v1/Dimensions`,
                { Name: dimensionName, Hierarchies: [{ Name: hier }] },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create dimension '${dimensionName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /** Creates an additional hierarchy inside an existing dimension. */
    public async createHierarchy(instanceName: string, dimensionName: string, hierarchyName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName).replace(/'/g, "''");
        try {
            const response = await axios.post(`${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies`,
                { Name: hierarchyName },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create hierarchy '${hierarchyName}' in '${dimensionName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Adds elements to a hierarchy (existing ones are skipped, not overwritten).
     * Uses individual POSTs so nothing already in the hierarchy is removed.
     */
    public async addElements(instanceName: string, dimensionName: string, hierarchyName: string, elements: { name: string; type?: string }[]): Promise<{ added: number; failed: number }> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName).replace(/'/g, "''");
        const hierEnc = encodeURIComponent(hierarchyName || dimensionName).replace(/'/g, "''");
        const url = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/Elements`;
        let added = 0, failed = 0; let firstError: any;
        for (const e of elements) {
            try {
                await axios.post(url, { Name: e.name, Type: this.normElemType(e.type) },
                    { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
                added++;
            } catch (err: any) { failed++; if (!firstError) firstError = err; }
        }
        if (added === 0 && elements.length > 0) {
            throw new Error(`Failed to add elements to '${dimensionName}': ${firstError?.response?.data?.error?.message || firstError?.message || 'unknown error'}`);
        }
        return { added, failed };
    }

    /**
     * Adds consolidation edges (parent → child, with weight). Uses individual
     * POSTs so existing edges are preserved.
     */
    public async addEdges(instanceName: string, dimensionName: string, hierarchyName: string, edges: { parent: string; child: string; weight?: number }[]): Promise<{ added: number; failed: number }> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName).replace(/'/g, "''");
        const hierEnc = encodeURIComponent(hierarchyName || dimensionName).replace(/'/g, "''");
        const url = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/Edges`;
        let added = 0, failed = 0; let firstError: any;
        for (const e of edges) {
            try {
                await axios.post(url, { ParentName: e.parent, ComponentName: e.child, Weight: e.weight == null ? 1 : e.weight },
                    { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
                added++;
            } catch (err: any) { failed++; if (!firstError) firstError = err; }
        }
        if (added === 0 && edges.length > 0) {
            throw new Error(`Failed to add edges to '${dimensionName}': ${firstError?.response?.data?.error?.message || firstError?.message || 'unknown error'}`);
        }
        return { added, failed };
    }

    /** Deletes a single element from a hierarchy. */
    public async deleteElement(instanceName: string, dimensionName: string, hierarchyName: string, elementName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName).replace(/'/g, "''");
        const hierEnc = encodeURIComponent(hierarchyName || dimensionName).replace(/'/g, "''");
        const elemEnc = encodeURIComponent(elementName).replace(/'/g, "''");
        try {
            const response = await axios.delete(`${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/Elements('${elemEnc}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete element '${elementName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /** Sets one or more attribute values on an element (writes to the }ElementAttributes_<dim> cube). */
    public async updateElementAttributes(instanceName: string, dimensionName: string, hierarchyName: string, elementName: string, attributes: Record<string, string | number>): Promise<void> {
        const attrCube = '}ElementAttributes_' + dimensionName;
        const hier = hierarchyName || dimensionName;
        for (const [attr, val] of Object.entries(attributes)) {
            await this.writeCellByTuple(instanceName, attrCube, [
                { dimension: dimensionName, hierarchy: hier, element: elementName },
                { dimension: attrCube, hierarchy: attrCube, element: attr }
            ], val);
        }
    }

    /** Creates a cube over the given ordered dimensions. */
    public async createCube(instanceName: string, cubeName: string, dimensions: string[]): Promise<void> {
        const cfg = this.getConfig(instanceName);
        // @odata.bind values are JSON strings (not URL segments), so the dimension
        // name must be raw with only single quotes doubled — percent-encoding it
        // would make TM1 look for a dimension literally named e.g. 'My%20Dim'.
        const binds = dimensions.map(d => `Dimensions('${String(d).replace(/'/g, "''")}')`);
        try {
            const response = await axios.post(`${cfg.url}/api/v1/Cubes`,
                { Name: cubeName, 'Dimensions@odata.bind': binds },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 });
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create cube '${cubeName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- CUBE VIEWER SUPPORT ---

    /**
     * Returns the initial members to show on a row/column axis for a dimension:
     * the top consolidations (highest level) for a real hierarchy, or the first
     * elements for a flat dimension. Used to seed the Cube Viewer grid.
     */
    public async getInitialMembers(instanceName: string, dimensionName: string, hierarchyName: string): Promise<{ Name: string; Type: number; Level: number }[]> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const base = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')`;
        const levelCount = await this.getHierarchyLevelCount(instanceName, dimensionName, hierarchyName);
        try {
            let url: string;
            if (levelCount <= 1) {
                url = `${base}/Elements?$select=Name,Type,Level&$top=500`;
            } else {
                const maxLevel = levelCount - 1;
                url = `${base}/Elements?$select=Name,Type,Level&$filter=Level eq ${maxLevel}`;
            }
            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).map((e: any) => ({ Name: e.Name, Type: e.Type, Level: e.Level }));
        } catch (error: any) {
            throw new Error(`Failed to get initial members: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /** Builds a Name -> element Type map for a hierarchy (to detect consolidations in the Cube Viewer). */
    public async getElementTypeMap(instanceName: string, dimensionName: string, hierarchyName: string): Promise<Record<string, number>> {
        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const base = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')`;
        const map: Record<string, number> = {};
        try {
            const response = await axios.get(`${base}/Elements?$select=Name,Type&$top=100000`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
            });
            this.updateCookieFromResponse(instanceName, response);
            for (const e of response.data.value || []) {
                // Normalize enum string -> number
                let t: number = e.Type;
                if (typeof e.Type === 'string') {
                    const s = e.Type.toLowerCase();
                    t = s === 'consolidated' ? 3 : (s === 'string' ? 2 : 1);
                }
                map[e.Name] = t;
            }
        } catch { /* best-effort */ }
        return map;
    }

    /** Builds a Name -> alias-value map for a hierarchy (for alias display in the Cube Viewer). */
    public async getElementAliasMap(instanceName: string, dimensionName: string, hierarchyName: string, alias: string): Promise<Record<string, string>> {        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const base = `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')`;
        const map: Record<string, string> = {};
        try {
            const response = await axios.get(`${base}/Elements?$select=Name,Attributes&$top=100000`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000
            });
            this.updateCookieFromResponse(instanceName, response);
            for (const e of response.data.value || []) {
                const v = e.Attributes && e.Attributes[alias];
                if (v != null && v !== '') map[e.Name] = v;
            }
        } catch { /* alias display is best-effort */ }
        return map;
    }

    /** Returns the direct children (components) of a consolidated element. */
    public async getElementChildren(instanceName: string, dimensionName: string, hierarchyName: string, elementName: string): Promise<{ Name: string; Type: number; Level: number }[]> {        const cfg = this.getConfig(instanceName);
        const dimEnc = encodeURIComponent(dimensionName);
        const hierEnc = encodeURIComponent(hierarchyName);
        const elEnc = encodeURIComponent(elementName).replace(/'/g, "''");
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${dimEnc}')/Hierarchies('${hierEnc}')/Elements('${elEnc}')/Components?$select=Name,Type,Level`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            return (response.data.value || []).map((e: any) => ({ Name: e.Name, Type: e.Type, Level: e.Level }));
        } catch (error: any) {
            throw new Error(`Failed to get children of '${elementName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Saves the current Cube Viewer layout as a named MDX view on the server,
     * public or private. Creates it, or updates the MDX if it already exists.
     */
    public async saveView(instanceName: string, cubeName: string, viewName: string, mdx: string, isPrivate: boolean): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const cubeEnc = encodeURIComponent(cubeName);
        const collection = isPrivate ? 'PrivateViews' : 'Views';
        const collUrl = `${cfg.url}/api/v1/Cubes('${cubeEnc}')/${collection}`;
        const body: any = { '@odata.type': '#ibm.tm1.api.v1.MDXView', Name: viewName, MDX: mdx };
        try {
            await axios.post(collUrl, body, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
            });
        } catch (error: any) {
            const status = error.response?.status;
            if (status === 409 || status === 500 || status === 400) {
                try {
                    await axios.patch(`${collUrl}('${encodeURIComponent(viewName)}')`, { MDX: mdx }, {
                        httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000
                    });
                    return;
                } catch (patchError: any) {
                    throw new Error(`Failed to save view: ${patchError.response?.data?.error?.message || patchError.message}`);
                }
            }
            throw new Error(`Failed to save view: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /** Executes a saved cube view (native or MDX, public or private) and returns the cellset. */
    /**
     * Reads a native view's structure (which dimensions sit on Rows / Columns /
     * Titles and the subset behind each) so the Cube Viewer can lay it out
     * correctly even when the executed cellset comes back empty (e.g. zero
     * suppression hides every row). Returns null for MDX views / on failure so
     * the caller falls back to reconstructing from the cellset.
     */
    public async getViewStructure(instanceName: string, cubeName: string, viewName: string): Promise<any | null> {
        const cfg = this.getConfig(instanceName);
        const cubeEnc = encodeURIComponent(cubeName);
        const viewEnc = encodeURIComponent(viewName);
        const selSubset = `Subset($select=Name,Expression;$expand=Hierarchy($select=Name;$expand=Dimension($select=Name)),Elements($select=Name,Type,Level;$top=50000))`;
        const query = `$select=SuppressEmptyColumns,SuppressEmptyRows&$expand=Columns($expand=${selSubset}),Rows($expand=${selSubset}),Titles($expand=${selSubset},Selected($select=Name))`;
        for (const coll of ['Views', 'PrivateViews']) {
            try {
                const res = await axios.get(
                    `${cfg.url}/api/v1/Cubes('${cubeEnc}')/${coll}('${viewEnc}')?${query}`,
                    { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000 }
                );
                this.updateCookieFromResponse(instanceName, res);
                const data = res.data;
                // MDX views have no Rows/Columns/Titles selections.
                if (!data || (!data.Rows && !data.Columns && !data.Titles)) { return null; }
                const normSel = (s: any) => {
                    const sub = s.Subset || {};
                    const hier = sub.Hierarchy || {};
                    const dimension = (hier.Dimension && hier.Dimension.Name) || hier.Name || '';
                    const hierarchy = hier.Name || dimension;
                    const elements = (sub.Elements || []).map((e: any) => ({ name: e.Name, type: e.Type, level: e.Level }));
                    let subsetMdx = '';
                    if (dimension) {
                        if (sub.Name) { subsetMdx = `{TM1SubsetToSet([${dimension}].[${hierarchy}], "${sub.Name}")}`; }
                        else if (sub.Expression) { subsetMdx = sub.Expression; }
                    }
                    return { dimension, hierarchy, subsetName: sub.Name || '', subsetMdx, elements };
                };
                return {
                    columns: (data.Columns || []).map(normSel),
                    rows: (data.Rows || []).map(normSel),
                    titles: (data.Titles || []).map((t: any) => {
                        const base = normSel(t);
                        return { ...base, selected: (t.Selected && t.Selected.Name) || '' };
                    }),
                    suppressCols: !!data.SuppressEmptyColumns,
                    suppressRows: !!data.SuppressEmptyRows
                };
            } catch (error: any) {
                if (error.response?.status !== 404) { return null; }
            }
        }
        return null;
    }

    public async executeView(instanceName: string, cubeName: string, viewName: string, isPrivate: boolean = false): Promise<any> {
        const cfg = this.getConfig(instanceName);
        const cubeEnc = encodeURIComponent(cubeName);
        const viewEnc = encodeURIComponent(viewName);
        const expand = `$expand=Axes($expand=Hierarchies($select=Name;$expand=Dimension($select=Name)),Tuples($expand=Members($select=Name,Type,Level,UniqueName))),Cells($select=Ordinal,Value,FormattedValue,Updateable,Consolidated,RuleDerived)`;
        const collections = isPrivate ? ['PrivateViews', 'Views'] : ['Views', 'PrivateViews'];
        let lastErr: any;
        for (const coll of collections) {
            try {
                const response = await axios.post(
                    `${cfg.url}/api/v1/Cubes('${cubeEnc}')/${coll}('${viewEnc}')/tm1.Execute?${expand}`,
                    {},
                    { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 120000 }
                );
                this.updateCookieFromResponse(instanceName, response);
                return response.data;
            } catch (error: any) {
                lastErr = error;
                if (error.response?.status !== 404) break;
            }
        }
        throw new Error(`Failed to execute view '${viewName}': ${lastErr?.response?.data?.error?.message || lastErr?.message}`);
    }

    /** Executes an MDX statement and returns the full cellset (axes + cells) for the Cube Viewer. */
    public async executeMDXCube(instanceName: string, mdx: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.post(
                `${cfg.url}/api/v1/ExecuteMDX?$expand=Axes($expand=Hierarchies($select=Name;$expand=Dimension($select=Name)),Tuples($expand=Members($select=Name,Type,Level,UniqueName))),Cells($select=Ordinal,Value,FormattedValue,Updateable,Consolidated,RuleDerived)`,
                { MDX: mdx },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 120000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            throw new Error(`MDX execution failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Writes a single value into a cube cell using the proven `tm1.Update`
     * action with an explicit element tuple (one element per cube dimension).
     */
    public async writeCellByTuple(instanceName: string, cubeName: string, tuple: { dimension: string; hierarchy: string; element: string }[], value: string | number): Promise<void> {
        const cfg = this.getConfig(instanceName);
        const enc = (s: string) => encodeURIComponent(s).replace(/'/g, "''");
        const binds = tuple.map(t =>
            `Dimensions('${enc(t.dimension)}')/Hierarchies('${enc(t.hierarchy)}')/Elements('${enc(t.element)}')`);
        const body: any = {
            Cells: [{ 'Tuple@odata.bind': binds }],
            Value: String(value)
        };
        try {
            await axios.post(
                `${cfg.url}/api/v1/Cubes('${encodeURIComponent(cubeName)}')/tm1.Update`,
                body,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
        } catch (error: any) {
            throw new Error(`${error.response?.data?.error?.message || error.message}`);
        }
    }

    /**
     * Writes a single value into a cube cell. `cellMdx` must be an MDX statement
     * that resolves to exactly one cell (all dimensions pinned). The value is
     * written to Cell ordinal 0 of the resulting cellset.
     */
    public async writeCellByMDX(instanceName: string, cellMdx: string, value: string | number): Promise<void> {
        const cfg = this.getConfig(instanceName);
        let cellsetId: string | undefined;
        try {
            const createResponse = await axios.post(
                `${cfg.url}/api/v1/ExecuteMDX`,
                { MDX: cellMdx },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, createResponse);
            cellsetId = createResponse.data.ID;
            await axios.patch(
                `${cfg.url}/api/v1/Cellsets('${cellsetId}')/Cells(0)`,
                { Value: value },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
        } catch (error: any) {
            throw new Error(`Cell write failed: ${error.response?.data?.error?.message || error.message}`);
        } finally {
            if (cellsetId) {
                axios.delete(`${cfg.url}/api/v1/Cellsets('${cellsetId}')`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 10000
                }).catch(() => { });
            }
        }
    }

    // --- V12 TENANT ---

    public async getDatabasesFromTenant(tenantUrl: string, authHeader: string): Promise<{ Name: string; Status: string }[]> {
        try {
            const url = tenantUrl.replace(/\/+$/, '');
            const response = await axios.get(`${url}/api/v1/Databases`, {
                httpsAgent: this.httpsAgent,
                headers: { 'Accept': 'application/json', 'Authorization': authHeader },
                timeout: 30000
            });
            return (response.data.value || []).map((db: any) => ({
                Name: db.Name || db.name,
                Status: db.Status || db.status || 'Unknown'
            }));
        } catch (error: any) {
            throw new Error(`Failed to get databases from tenant: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async connectToTenantDatabase(instanceName: string, tenantUrl: string, databaseName: string, authHeader: string): Promise<void> {
        const url = `${tenantUrl.replace(/\/+$/, '')}/api/v1/Databases('${encodeURIComponent(databaseName)}')`;
        try {
            const response = await axios.get(`${url}/api/v1/ActiveUser`, {
                httpsAgent: this.httpsAgent,
                headers: { 'Accept': 'application/json', 'Authorization': authHeader },
                timeout: 15000
            });
            const cookie = this.extractCookie(response);
            this.connections.set(instanceName, {
                url: url,
                authHeader: authHeader,
                cookie: cookie,
                connected: true
            });
        } catch (error: any) {
            throw new Error(`Failed to connect to database '${databaseName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    private extractCookie(response: any): string {
        const setCookies = response.headers['set-cookie'];
        if (setCookies) {
            for (const c of setCookies) {
                if (c.includes('TM1SessionId')) return c.split(';')[0];
            }
        }
        return '';
    }

    // --- PAW OAUTH ---

    /** Normalizes a PAW base URL down to the bare host (strips trailing slashes and any /api/... suffix). */
    public normalizePawHost(url: string): string {
        return (url || '').trim().replace(/\/+$/, '').replace(/\/api\/.*$/i, '').replace(/\/+$/, '');
    }

    /** Builds the PAW-routed TM1 REST base URL for a given server/database. */
    public buildPawTm1Base(pawHost: string, serverName: string): string {
        return `${this.normalizePawHost(pawHost)}/api/v1/tm1/${encodeURIComponent(serverName)}/api/v1`;
    }

    /**
     * Lists the TM1 servers/databases available through a PAW instance using the
     * OAuth-routed endpoint `GET <pawHost>/api/v1/tm1/Servers`.
     */
    public async getPawServers(pawHost: string, authHeader: string): Promise<{ Name: string; Status: string }[]> {
        const host = this.normalizePawHost(pawHost);
        try {
            const response = await axios.get(`${host}/api/v1/tm1/Servers`, {
                httpsAgent: this.httpsAgent,
                headers: { 'Accept': 'application/json', 'Authorization': authHeader, 'X-Requested-With': 'XMLHttpRequest' },
                timeout: 30000
            });
            const data = response.data;
            const rows = Array.isArray(data) ? data : (data.value || data.databases || data.servers || data.Servers || []);
            return rows.map((x: any) => ({
                Name: x.Name || x.name || x.ID || x.id || x.ServerName || x.serverName || (typeof x === 'string' ? x : ''),
                Status: x.Status || x.status || 'Unknown'
            })).filter((x: any) => x.Name);
        } catch (error: any) {
            throw new Error(`Failed to list PAW servers: ${error.response?.data?.error?.message || error.response?.status || error.message}`);
        }
    }

    /**
     * Connects to a PAW-routed TM1 server using an OAuth bearer header. Validates
     * the token against ActiveUser and stores the connection.
     */
    public async setConnectionWithOAuth(instanceName: string, restBaseUrl: string, authHeader: string, timeoutMs?: number): Promise<void> {
        const reqTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : 20000;
        let url = restBaseUrl.replace(/\/+$/, '');
        if (url.toLowerCase().endsWith('/api/v1')) {
            url = url.substring(0, url.length - 7);
        }
        const extraHeaders = { 'X-Requested-With': 'XMLHttpRequest' };
        try {
            const response = await axios.get(`${url}/api/v1/ActiveUser`, {
                httpsAgent: this.httpsAgent,
                headers: { 'Accept': 'application/json', 'Authorization': authHeader, ...extraHeaders },
                timeout: reqTimeout
            });
            const cookie = this.extractCookie(response);
            this.connections.set(instanceName, { url, authHeader, cookie, connected: true, extraHeaders, timeout: reqTimeout });

            // Detect admin status (optional)
            try {
                const groupsResp = await axios.get(`${url}/api/v1/ActiveUser/Groups?$select=Name`, {
                    httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 10000
                });
                const groups = groupsResp.data?.value || [];
                this.connections.get(instanceName)!.isAdmin = groups.some((g: any) => g.Name === 'ADMIN');
            } catch { /* admin detection is optional */ }
        } catch (error: any) {
            this.connections.delete(instanceName);
            const status = error.response?.status ? ` (Status ${error.response.status})` : '';
            throw new Error(`OAuth connection failed${status}: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- MDX EXECUTION ---

    public async executeMDXSet(instanceName: string, mdx: string, dimension?: string): Promise<string[]> {
        const cfg = this.getConfig(instanceName);
        try {
            // TM1py approach: wrap set expression in SELECT, execute as cellset, extract members
            const cubeName = dimension ? `}ElementAttributes_${dimension}` : '}Clients';
            const fullMdx = `SELECT {${mdx}} ON 0 FROM [${cubeName}]`;
            // Step 1: Create cellset
            const createResponse = await axios.post(
                `${cfg.url}/api/v1/ExecuteMDX`,
                { MDX: fullMdx },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000 }
            );
            this.updateCookieFromResponse(instanceName, createResponse);
            const cellsetId = createResponse.data.ID;
            // Step 2: Extract members from cellset
            const cellsetResponse = await axios.get(
                `${cfg.url}/api/v1/Cellsets('${cellsetId}')?$expand=Axes($expand=Tuples($expand=Members($select=Name)))`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 60000 }
            );
            this.updateCookieFromResponse(instanceName, cellsetResponse);
            // Delete cellset
            axios.delete(`${cfg.url}/api/v1/Cellsets('${cellsetId}')`, {
                httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 10000
            }).catch(() => {});
            const axes = cellsetResponse.data.Axes || [];
            if (axes.length > 0 && axes[0].Tuples) {
                return axes[0].Tuples.map((t: any) => t.Members?.[0]?.Name).filter(Boolean);
            }
            return [];
        } catch (error: any) {
            const detail = error.response?.data?.error?.message || error.message;
            throw new Error(`MDX execution failed: ${detail}. Check the set syntax — a TM1 set must use MDX form, e.g. {TM1SubsetAll([Dimension])} rather than a TI-style call.`);
        }
    }

    public async executeMDXView(instanceName: string, mdx: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.post(`${cfg.url}/api/v1/ExecuteMDX?$expand=Axes($expand=Tuples($expand=Members($select=Name))),Cells($select=Value,FormattedValue)`,
                { MDX: mdx },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 120000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            throw new Error(`MDX execution failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- DATASOURCE PREVIEW ---

    public async previewCubeView(instanceName: string, cubeName: string, viewName: string, top: number = 10): Promise<{ headers: string[]; rows: string[][] }> {
        const cfg = this.getConfig(instanceName);
        try {
            // Execute the view to get row/column/title data
            const response = await axios.post(
                `${cfg.url}/api/v1/Cubes('${encodeURIComponent(cubeName)}')/Views('${encodeURIComponent(viewName)}')/tm1.Execute?$expand=Axes($expand=Hierarchies($select=Name),Tuples($expand=Members($select=Name))),Cells($select=Value,FormattedValue)`,
                {},
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            const data = response.data;
            const axes = data.Axes || [];
            const cells = data.Cells || [];

            // Axis 0 = columns, Axis 1 = rows, Axis 2 = slicer/titles (context dimensions)
            const titleDimNames: string[] = [];
            const titleElements: string[] = [];
            if (axes.length > 2) {
                const titleAxis = axes[2];
                for (const h of (titleAxis.Hierarchies || [])) {
                    titleDimNames.push(h.Name);
                }
                // Slicer axis has exactly one tuple with one member per title dimension
                const titleTuple = (titleAxis.Tuples || [])[0];
                if (titleTuple) {
                    for (const m of (titleTuple.Members || [])) {
                        titleElements.push(m.Name);
                    }
                }
            }

            // Build flat/relational view: all dimensions + Value
            const headers: string[] = [];
            const rows: string[][] = [];

            if (axes.length >= 2) {
                const colAxis = axes[0];
                const rowAxis = axes[1];
                const rowHierarchies = (rowAxis.Hierarchies || []).map((h: any) => h.Name);
                const colHierarchies = (colAxis.Hierarchies || []).map((h: any) => h.Name);
                const colTuples = colAxis.Tuples || [];
                const rowTuples = rowAxis.Tuples || [];
                const colCount = colTuples.length || 1;

                // Headers: row dims + col dims + title dims + Value
                headers.push(...rowHierarchies, ...colHierarchies, ...titleDimNames, 'Value');

                // Flatten: iterate row tuples × col tuples (cartesian product)
                let count = 0;
                for (let r = 0; r < rowTuples.length && count < top; r++) {
                    const rowMembers = (rowTuples[r].Members || []).map((m: any) => m.Name);
                    for (let c = 0; c < colCount && count < top; c++) {
                        const colMembers = (colTuples[c]?.Members || []).map((m: any) => m.Name);
                        const cellIdx = r * colCount + c;
                        const cellVal = cells[cellIdx]?.FormattedValue ?? cells[cellIdx]?.Value ?? '';
                        rows.push([...rowMembers, ...colMembers, ...titleElements, String(cellVal)]);
                        count++;
                    }
                }
            } else if (axes.length === 1) {
                const tuples = axes[0].Tuples || [];
                const hierarchies = (axes[0].Hierarchies || []).map((h: any) => h.Name);
                headers.push(...hierarchies, ...titleDimNames, 'Value');
                for (let i = 0; i < Math.min(tuples.length, top); i++) {
                    const members = (tuples[i].Members || []).map((m: any) => m.Name);
                    const cellVal = cells[i]?.FormattedValue ?? cells[i]?.Value ?? '';
                    rows.push([...members, ...titleElements, String(cellVal)]);
                }
            }
            return { headers, rows };
        } catch (error: any) {
            throw new Error(`View preview failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async previewDimensionSubset(instanceName: string, dimensionName: string, hierarchyName: string, subsetName: string, top: number = 10): Promise<{ headers: string[]; rows: string[][] }> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Dimensions('${encodeURIComponent(dimensionName)}')/Hierarchies('${encodeURIComponent(hierarchyName)}')/Subsets('${encodeURIComponent(subsetName)}')/Elements?$select=Name&$top=${top}`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            const elements = response.data.value || [];
            return {
                headers: [dimensionName],
                rows: elements.map((e: any) => [e.Name])
            };
        } catch (error: any) {
            throw new Error(`Subset preview failed: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    // --- CHORE MANAGEMENT ---

    public async getChores(instanceName: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        const url = `${cfg.url}/api/v1/Chores?$expand=Tasks($expand=Process($select=Name))`;
        console.log('[TM1Service] getChores URL:', url);
        try {
            const response = await axios.get(url, {
                httpsAgent: this.httpsAgent,
                headers: this.getHeaders(instanceName),
                timeout: 30000
            });
            this.updateCookieFromResponse(instanceName, response);
            const chores = response.data.value || [];
            console.log('[TM1Service] getChores success, count:', chores.length);
            return chores;
        } catch (error: any) {
            console.error('[TM1Service] getChores failed:', error.response?.status, error.response?.data?.error?.message || error.message);
            throw new Error(`Failed to get chores: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getChore(instanceName: string, choreName: string): Promise<any> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.get(
                `${cfg.url}/api/v1/Chores('${encodeURIComponent(choreName)}')?$expand=Tasks($expand=Process($select=Name))`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return response.data;
        } catch (error: any) {
            throw new Error(`Failed to get chore '${choreName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async updateChoreActive(instanceName: string, choreName: string, active: boolean): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.patch(
                `${cfg.url}/api/v1/Chores('${encodeURIComponent(choreName)}')`,
                { Active: active },
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to ${active ? 'activate' : 'deactivate'} chore '${choreName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async executeChore(instanceName: string, choreName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.post(
                `${cfg.url}/api/v1/Chores('${encodeURIComponent(choreName)}')/tm1.Execute`,
                {},
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 120000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to execute chore '${choreName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async createChore(instanceName: string, choreBody: any): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.post(
                `${cfg.url}/api/v1/Chores`,
                choreBody,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to create chore: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async updateChore(instanceName: string, choreName: string, choreBody: any): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.patch(
                `${cfg.url}/api/v1/Chores('${encodeURIComponent(choreName)}')`,
                choreBody,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to update chore '${choreName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async deleteChore(instanceName: string, choreName: string): Promise<void> {
        const cfg = this.getConfig(instanceName);
        try {
            const response = await axios.delete(
                `${cfg.url}/api/v1/Chores('${encodeURIComponent(choreName)}')`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 15000 }
            );
            this.updateCookieFromResponse(instanceName, response);
        } catch (error: any) {
            throw new Error(`Failed to delete chore '${choreName}': ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getChoreHistory(instanceName: string, choreName: string, top: number = 50): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const safeName = choreName.replace(/'/g, "''");
            const filterStr = encodeURIComponent(`contains(Message,'${safeName}')`);
            const response = await axios.get(
                `${cfg.url}/api/v1/MessageLogEntries?$filter=${filterStr}&$orderby=TimeStamp desc&$top=${top}`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return response.data.value || [];
        } catch (error: any) {
            throw new Error(`Failed to get chore history: ${error.response?.data?.error?.message || error.message}`);
        }
    }

    public async getChoreMessageLog(instanceName: string, sinceTimestamp: string): Promise<any[]> {
        const cfg = this.getConfig(instanceName);
        try {
            const filterStr = encodeURIComponent(`contains(tolower(Message),'chore') and TimeStamp ge ${sinceTimestamp}`);
            const response = await axios.get(
                `${cfg.url}/api/v1/MessageLogEntries?$filter=${filterStr}&$orderby=TimeStamp desc&$top=2000`,
                { httpsAgent: this.httpsAgent, headers: this.getHeaders(instanceName), timeout: 30000 }
            );
            this.updateCookieFromResponse(instanceName, response);
            return response.data.value || [];
        } catch (error: any) {
            console.error(`Failed to get chore message log:`, error.message);
            return [];  // Return empty on failure to not block the UI
        }
    }
}

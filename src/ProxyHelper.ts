import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

/**
 * Centralized proxy resolution for all outbound HTTP(S) requests.
 *
 * Order of precedence for the proxy URL:
 *   1. VS Code setting `http.proxy`
 *   2. Environment variables HTTPS_PROXY / HTTP_PROXY (and lowercase)
 *
 * Bypass ("no proxy") list is built from:
 *   1. VS Code setting `http.noProxy` (string array)
 *   2. Environment variable NO_PROXY / no_proxy (comma separated)
 *   3. Always-bypassed: localhost, 127.0.0.1, ::1
 *
 * This solves the corporate-proxy problem where internal TM1 servers were
 * wrongly routed through the proxy because axios only honored the OS
 * environment variables and ignored VS Code's own proxy configuration.
 */
export class ProxyHelper {
    private static _output: vscode.OutputChannel | undefined;
    private static _plainHttps = new https.Agent({ rejectUnauthorized: false });
    private static _plainHttp = new http.Agent();
    private static _proxyAgentCache = new Map<string, http.Agent | https.Agent>();

    private static getOutput(): vscode.OutputChannel {
        if (!ProxyHelper._output) {
            ProxyHelper._output = vscode.window.createOutputChannel('PA Code (Proxy)');
        }
        return ProxyHelper._output;
    }

    private static isDebugEnabled(): boolean {
        return vscode.workspace.getConfiguration('pa-code').get<boolean>('proxy.debug', false);
    }

    public static showLog(): void {
        ProxyHelper.getOutput().show(true);
    }

    public static log(message: string): void {
        if (!ProxyHelper.isDebugEnabled()) return;
        const ts = new Date().toISOString();
        ProxyHelper.getOutput().appendLine(`[${ts}] ${message}`);
    }

    /** Returns the configured proxy URL (VS Code setting wins over env), or '' if none. */
    private static getProxyUrl(targetProtocol: string): string {
        const cfg = vscode.workspace.getConfiguration('http');
        const vscodeProxy = (cfg.get<string>('proxy') || '').trim();
        if (vscodeProxy) return vscodeProxy;

        // Fall back to environment variables
        const env = process.env;
        if (targetProtocol === 'https:') {
            return (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '').trim();
        }
        return (env.HTTP_PROXY || env.http_proxy || '').trim();
    }

    /** Builds the combined no-proxy host list from VS Code settings + env. */
    private static getNoProxyList(): string[] {
        const list: string[] = ['localhost', '127.0.0.1', '::1'];

        const cfg = vscode.workspace.getConfiguration('http');
        const vscodeNoProxy = cfg.get<string[]>('noProxy') || [];
        for (const entry of vscodeNoProxy) {
            if (entry && entry.trim()) list.push(entry.trim());
        }

        const envNoProxy = process.env.NO_PROXY || process.env.no_proxy || '';
        for (const entry of envNoProxy.split(',')) {
            if (entry && entry.trim()) list.push(entry.trim());
        }
        return list;
    }

    /**
     * Determines whether a hostname should bypass the proxy based on the
     * no-proxy list. Supports exact matches, `*.domain`, `.domain` suffixes,
     * and bare-domain suffix matching (like curl/requests).
     */
    private static hostMatchesNoProxy(hostname: string, noProxyList: string[]): string | null {
        const host = hostname.toLowerCase();
        for (const raw of noProxyList) {
            let pattern = raw.toLowerCase();
            if (pattern === '*') return '*'; // bypass everything
            // Strip an optional port suffix from the pattern
            pattern = pattern.replace(/:\d+$/, '');
            // Normalize leading wildcard / dot to a suffix match
            const suffix = pattern.startsWith('*.') ? pattern.slice(1)
                : pattern.startsWith('.') ? pattern
                    : null;
            if (suffix) {
                if (host.endsWith(suffix) || host === suffix.slice(1)) return raw;
            } else {
                if (host === pattern) return raw;
                // Bare-domain suffix match (e.g. "example.com" matches "tm1.example.com")
                if (host.endsWith('.' + pattern)) return raw;
            }
        }
        return null;
    }

    private static getProxyAgent(proxyUrl: string, targetProtocol: string): http.Agent | https.Agent {
        const cacheKey = `${targetProtocol}|${proxyUrl}`;
        const cached = ProxyHelper._proxyAgentCache.get(cacheKey);
        if (cached) return cached;

        // v5 API: single argument (proxy URL string). Target cert validation is
        // governed globally by NODE_TLS_REJECT_UNAUTHORIZED which the extension sets.
        const agent = targetProtocol === 'https:'
            ? new HttpsProxyAgent(proxyUrl)
            : new HttpProxyAgent(proxyUrl);
        ProxyHelper._proxyAgentCache.set(cacheKey, agent as any);
        return agent as any;
    }

    /**
     * Resolves the correct agent for a target URL. Returns the agent that
     * should be assigned to both `httpAgent` and `httpsAgent` on the axios
     * request. Also returns `proxy: false` intent so callers can disable
     * axios' built-in env-based proxy handling (our agent is authoritative).
     */
    public static resolveAgent(targetUrl: string): http.Agent | https.Agent {
        let parsed: URL;
        try {
            parsed = new URL(targetUrl);
        } catch {
            ProxyHelper.log(`Could not parse URL, using direct agent: ${targetUrl}`);
            return ProxyHelper._plainHttps;
        }

        const protocol = parsed.protocol;
        const plainAgent = protocol === 'https:' ? ProxyHelper._plainHttps : ProxyHelper._plainHttp;

        const proxyUrl = ProxyHelper.getProxyUrl(protocol);
        if (!proxyUrl) {
            ProxyHelper.log(`No proxy configured -> DIRECT ${parsed.hostname}`);
            return plainAgent;
        }

        const noProxyList = ProxyHelper.getNoProxyList();
        const match = ProxyHelper.hostMatchesNoProxy(parsed.hostname, noProxyList);
        if (match) {
            ProxyHelper.log(`Host ${parsed.hostname} matches no-proxy rule "${match}" -> DIRECT`);
            return plainAgent;
        }

        ProxyHelper.log(`Host ${parsed.hostname} -> PROXY ${proxyUrl}`);
        return ProxyHelper.getProxyAgent(proxyUrl, protocol);
    }

    /** One-line summary of the current proxy configuration for diagnostics. */
    public static logConfigSummary(): void {
        const cfg = vscode.workspace.getConfiguration('http');
        const out = ProxyHelper.getOutput();
        out.appendLine('=== PA Code Proxy Configuration ===');
        out.appendLine(`VS Code http.proxy:        ${cfg.get<string>('proxy') || '(not set)'}`);
        out.appendLine(`VS Code http.noProxy:      ${JSON.stringify(cfg.get<string[]>('noProxy') || [])}`);
        out.appendLine(`VS Code http.proxyStrictSSL: ${cfg.get<boolean>('proxyStrictSSL', true)}`);
        out.appendLine(`env HTTPS_PROXY:           ${process.env.HTTPS_PROXY || process.env.https_proxy || '(not set)'}`);
        out.appendLine(`env HTTP_PROXY:            ${process.env.HTTP_PROXY || process.env.http_proxy || '(not set)'}`);
        out.appendLine(`env NO_PROXY:              ${process.env.NO_PROXY || process.env.no_proxy || '(not set)'}`);
        out.appendLine(`Effective no-proxy list:   ${JSON.stringify(ProxyHelper.getNoProxyList())}`);
        out.appendLine('===================================');
    }
}

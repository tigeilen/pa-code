import * as puppeteer from 'puppeteer-core';
import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export class CamAuthenticator {

    /**
     * Attempts to find Chrome on the system.
     */
    private static getChromePath(): string {
        const platform = os.platform();
        if (platform === 'win32') {
            const paths = [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : ''
            ].filter(p => p !== '');
            for (const p of paths) {
                if (fs.existsSync(p)) return p;
            }
        } else if (platform === 'darwin') {
            const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
            if (fs.existsSync(p)) return p;
        } else {
            const p = '/usr/bin/google-chrome';
            if (fs.existsSync(p)) return p;
        }
        return '';
    }

    /**
     * Attempts to find Edge on the system.
     */
    private static getEdgePath(): string {
        const platform = os.platform();
        if (platform === 'win32') {
            const paths = [
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
                process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe` : ''
            ].filter(p => p !== '');
            for (const p of paths) {
                if (fs.existsSync(p)) return p;
            }
            return 'msedge.exe';
        } else if (platform === 'darwin') {
            const p = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
            if (fs.existsSync(p)) return p;
        } else {
            const p = '/usr/bin/microsoft-edge';
            if (fs.existsSync(p)) return p;
        }
        return '';
    }

    /**
     * Resolves the browser executable path based on preference.
     */
    private static getExecutablePath(preferred?: 'edge' | 'chrome'): string {
        if (preferred === 'chrome') {
            const chromePath = this.getChromePath();
            if (chromePath) return chromePath;
            // Fallback to Edge if Chrome not found
            return this.getEdgePath();
        }
        if (preferred === 'edge') {
            const edgePath = this.getEdgePath();
            if (edgePath) return edgePath;
            // Fallback to Chrome if Edge not found
            return this.getChromePath();
        }
        // Auto: try Edge first, then Chrome
        return this.getEdgePath() || this.getChromePath() || '';
    }

    private static isEdge(exePath: string): boolean {
        return exePath.toLowerCase().includes('edge') || exePath.toLowerCase().includes('msedge');
    }

    public static async loginAndGetPassport(cognosLoginUrl: string, onLog?: (text: string) => void, preferredBrowser?: 'edge' | 'chrome', usePrivate?: boolean): Promise<string | null> {
        let browser: puppeteer.Browser | null = null;
        const exePath = this.getExecutablePath(preferredBrowser);
        const isEdge = this.isEdge(exePath);

        if (!exePath && onLog) onLog('[Error] Could not find a Chromium-based browser (Edge/Chrome).');

        try {
            if (onLog) onLog(`[Auth] Launching ${isEdge ? 'Edge' : 'Chrome'}${usePrivate ? ' (private window)' : ''}: ${exePath}`);

            if (isEdge) {
                // Edge requires spawn+connect approach because Edge's Startup Boost
                // intercepts puppeteer.launch() and exits the process (Code: 0).
                browser = await this.launchEdge(exePath, cognosLoginUrl, onLog, usePrivate);
            } else {
                browser = await puppeteer.launch({
                    executablePath: exePath,
                    headless: false,
                    defaultViewport: null,
                    args: [
                        '--window-size=900,700',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--ignore-certificate-errors',
                        ...(usePrivate ? ['--incognito'] : []),
                        '--app=' + cognosLoginUrl
                    ]
                });
            }

            if (!browser) {
                throw new Error('Browser could not be started.');
            }

            const pages = await browser.pages();
            let page = pages.find(p => p.url() !== 'about:blank') || pages[0];

            // If page is still on about:blank, navigate explicitly
            if (page.url() === 'about:blank') {
                if (onLog) onLog('[Auth] Navigating to login page...');
                await page.goto(cognosLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            }

            return await new Promise<string | null>((resolve) => {
                let resolved = false;
                let checkInterval: NodeJS.Timeout;

                browser?.on('disconnected', () => {
                    if (!resolved) {
                        clearInterval(checkInterval);
                        if (onLog) onLog('[Auth] Browser window closed by user.');
                        resolve(null);
                    }
                });

                // Poll for cam_passport cookie using CDP (catches cookies on ALL domains)
                checkInterval = setInterval(async () => {
                    if (resolved || !browser?.isConnected()) {
                        clearInterval(checkInterval);
                        return;
                    }

                    try {
                        // Always get fresh page list — redirects/navigation can invalidate old references
                        const currentPages = await browser!.pages();
                        const activePage = currentPages.find(p => p.url() !== 'about:blank') || currentPages[0];
                        if (!activePage) return;

                        // Use CDP to get ALL cookies across all domains (not just current page)
                        const client = await activePage.createCDPSession();
                        const { cookies } = await client.send('Network.getAllCookies');
                        await client.detach();

                        // Case-insensitive match: cam_passport, CAMPassport, etc.
                        const passportCookie = cookies.find((c: any) => c.name.toLowerCase() === 'cam_passport');

                        if (passportCookie && passportCookie.value && passportCookie.value.length > 20) {
                            resolved = true;
                            clearInterval(checkInterval);

                            if (onLog) onLog(`[Auth] Success! Captured ${passportCookie.name} cookie.`);

                            // Give Cognos time to persist the session
                            setTimeout(() => {
                                resolve(passportCookie.value);
                            }, 1500);
                        }
                    } catch (err: any) {
                        // Log poll errors for diagnostics (page may have navigated)
                        if (onLog && err.message && !err.message.includes('Target closed')) {
                            onLog(`[Auth] Poll: ${err.message}`);
                        }
                    }
                }, 800);
            });

        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to start login window: ${error.message}`);
            return null;
        } finally {
            if (browser && browser.isConnected()) {
                await browser.close();
            }
        }
    }

    /**
     * Launch Edge via spawn + puppeteer.connect() to bypass Startup Boost interference.
     */
    private static async launchEdge(exePath: string, url: string, onLog?: (text: string) => void, usePrivate?: boolean): Promise<puppeteer.Browser> {
        const { spawn } = require('child_process');
        const userDataDir = path.join(os.tmpdir(), 'pa-code-edge-profile');
        const debugPort = 9222 + Math.floor(Math.random() * 777);

        // Clean stale lock files from previous sessions
        for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile']) {
            try { fs.unlinkSync(path.join(userDataDir, lockFile)); } catch { }
        }

        const args = [
            `--remote-debugging-port=${debugPort}`,
            `--user-data-dir=${userDataDir}`,
            '--window-size=900,700',
            '--no-first-run',
            '--no-default-browser-check',
            '--ignore-certificate-errors',
            '--disable-features=msEdgeRedirect,msEdgeDiscoverBar,msEdgeSidebarV2,msEdgeShoppingAssist,msEdgeStartupBoost',
            ...(usePrivate ? ['--inprivate'] : []),
            url
        ];

        const browserProc = spawn(exePath, args, {
            detached: true,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        browserProc.unref();

        // Read WebSocket URL from stderr (Edge prints "DevTools listening on ws://...")
        const wsUrl = await new Promise<string>((resolve) => {
            let data = '';
            const timeout = setTimeout(() => resolve(''), 15000);
            browserProc.stderr.on('data', (chunk: Buffer) => {
                data += chunk.toString();
                const match = data.match(/DevTools listening on (ws:\/\/[^\s]+)/);
                if (match) {
                    clearTimeout(timeout);
                    resolve(match[1]);
                }
            });
            browserProc.stderr.on('close', () => { clearTimeout(timeout); resolve(''); });
        });

        if (wsUrl) {
            if (onLog) onLog('[Auth] Connected to Edge via WebSocket.');
            return await puppeteer.connect({ browserWSEndpoint: wsUrl });
        }

        // Fallback: poll the HTTP debug endpoint
        if (onLog) onLog(`[Auth] Polling debug port ${debugPort}...`);
        const http = require('http');
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
                const json = await new Promise<string>((resolve, reject) => {
                    const req = http.get(`http://127.0.0.1:${debugPort}/json/version`, (res: any) => {
                        let body = '';
                        res.on('data', (d: string) => body += d);
                        res.on('end', () => resolve(body));
                    });
                    req.on('error', reject);
                    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
                });
                const { webSocketDebuggerUrl } = JSON.parse(json);
                if (onLog) onLog('[Auth] Connected to Edge via HTTP fallback.');
                return await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl });
            } catch { }
        }

        throw new Error('Edge started but could not connect to debugging port. Try closing all Edge windows first.');
    }
}
import * as vscode from 'vscode';
import { CamAuthenticator } from './CamAuthenticator';

export class CAMLoginPanel {
    public static currentPanel: CAMLoginPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        private targetUrl: string,
        private onAuthenticated: (passport: string) => void
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(
            async message => {
                switch (message.command) {
                    case 'startLogin':
                        const browser = message.browser as 'edge' | 'chrome' | undefined;
                        const usePrivate = vscode.workspace.getConfiguration('pa-code').get<boolean>('auth.privateBrowserWindow', false);
                        this.log(`Starting browser authentication (${browser || 'auto'})${usePrivate ? ' [private window]' : ''}...`);
                        const passport = await CamAuthenticator.loginAndGetPassport(this.targetUrl, (msg) => this.log(msg), browser, usePrivate);
                        if (passport) {
                            this.onAuthenticated(passport);
                            this.dispose();
                        } else {
                            this.log('Authentication cancelled or failed.');
                        }
                        break;
                    case 'manualToken':
                        this.onAuthenticated(message.token);
                        this.dispose();
                        break;
                }
            },
            null,
            this._disposables
        );

        this._update();
    }

    public static createOrShow(extensionUri: vscode.Uri, targetUrl: string, onAuthenticated: (passport: string) => void) {
        if (CAMLoginPanel.currentPanel) {
            CAMLoginPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'camLogin',
            'TM1 CAM Authentication',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        CAMLoginPanel.currentPanel = new CAMLoginPanel(panel, extensionUri, targetUrl, onAuthenticated);
    }

    private log(message: string) {
        this._panel.webview.postMessage({ command: 'log', message });
    }

    public dispose() {
        CAMLoginPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }

    private _update() {
        this._panel.webview.html = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; padding: 20px; color: #ccc; background: #1e1e1e; line-height: 1.6; }
                    .container { max-width: 800px; margin: 0 auto; }
                    .card { background: #2d2d2d; padding: 25px; border-radius: 12px; border: 1px solid #444; margin-bottom: 25px; box-shadow: 0 4px 15px rgba(0,0,0,0.3); }
                    h2 { color: #569cd6; margin-top: 0; font-size: 24px; }
                    .btn { 
                        display: inline-block; padding: 14px 28px; background: #007acc; color: white; 
                        text-decoration: none; border-radius: 6px; cursor: pointer; border: none; font-size: 16px; font-weight: 600;
                        transition: background 0.2s, transform 0.1s;
                    }
                    .btn:hover { background: #0062a3; transform: translateY(-1px); }
                    .btn:active { transform: translateY(0); }
                    .log-window { background: #000; height: 180px; overflow-y: auto; padding: 12px; font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; border: 1px solid #444; color: #888; border-radius: 6px; margin-top: 15px; }
                    .info-box { background: #264f78; color: white; padding: 15px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; border-left: 4px solid #569cd6; }
                    input { 
                        width: 100%; padding: 12px; background: #3c3c3c; border: 1px solid #555; color: white; 
                        border-radius: 6px; margin-bottom: 10px; box-sizing: border-box;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>TM1 CAM Authentication</h2>
                    
                    <div class="info-box">
                        <strong>New Automated Flow:</strong> We will launch a secure, temporary browser window to handle your login. 
                        Once you finish the MFA process, we'll automatically capture the session and close the window.
                    </div>

                    <div class="card">
                        <p>Choose your browser to start the authentication:</p>
                        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
                            <button class="btn" style="background: #0078d4;" onclick="startLogin('edge')">
                                <svg style="vertical-align: middle; margin-right: 6px;" width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M21.86 17.86q.14 0 .25.12.1.13.1.25t-.11.33l-.32.46q-.43.58-1.15 1.22a7.2 7.2 0 01-1.84 1.16 8.3 8.3 0 01-2.47.84 11.7 11.7 0 01-2.69.31q-1.65 0-3.22-.58a8.9 8.9 0 01-2.78-1.57 7.5 7.5 0 01-1.92-2.37A6.3 6.3 0 015 14.67q0-1.39.66-2.81a8.8 8.8 0 011.74-2.68 4.7 4.7 0 01-.36-1.87q0-1.3.6-2.5A6.6 6.6 0 019.3 2.72a7.5 7.5 0 012.5-1.46A9 9 0 0114.84.82q2.19 0 3.9.85a6.8 6.8 0 012.72 2.34 5.5 5.5 0 011.02 3.22q0 1.39-.72 2.3a2.2 2.2 0 01-1.81.92H14.5q-.56 0-.92-.38a1.3 1.3 0 01-.36-.92q0-.82.54-1.48.53-.66 1.41-1.06t1.87-.4q0-.78-.55-1.3-.54-.52-1.4-.52-1.25 0-2.36.73a5.6 5.6 0 00-1.85 1.95 5 5 0 00-.7 2.56q0 .85.23 1.54a6.8 6.8 0 01-1.94 3.33A6.1 6.1 0 007 16.56q0 1.15.46 2.09.47.93 1.27 1.6.8.66 1.85 1.01A6.8 6.8 0 0012.83 21.64q1.5 0 2.78-.47a7 7 0 002.16-1.28 7.3 7.3 0 001.5-1.73q.36-.58.36-.58a.36.36 0 01.23-.12z"/></svg>
                                Login with Edge
                            </button>
                            <button class="btn" style="background: #4285f4;" onclick="startLogin('chrome')">
                                <svg style="vertical-align: middle; margin-right: 6px;" width="18" height="18" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="4.5" fill="white"/><path d="M12 2a10 10 0 00-8.66 5h5.66l3-5.2A10 10 0 0012 2zm8.66 5A10 10 0 0022 12h-6l-3 5.2A5 5 0 0017 12h5.66zM12 22a10 10 0 008.66-5h-5.66l-3 5.2A10 10 0 0112 22zM2 12a10 10 0 002.34 5h5.66l-3-5.2A5 5 0 017 12H2z" opacity="0.3"/></svg>
                                Login with Chrome
                            </button>
                        </div>
                        
                        <div id="log" class="log-window">System ready. Waiting for user...</div>
                    </div>

                    <div class="card">
                        <h3>Manual Token Entry</h3>
                        <p style="color: #888; font-size: 13px;">Use this only if the automated flow fails:</p>
                        <input type="text" id="tokenInput" placeholder="Paste CAMPassport string here...">
                        <button class="btn" style="padding: 8px 16px; font-size: 13px;" onclick="submitManual()">Submit Token</button>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    function startLogin(browser) {
                        vscode.postMessage({ command: 'startLogin', browser: browser });
                    }

                    function submitManual() {
                        const token = document.getElementById('tokenInput').value;
                        if (token) vscode.postMessage({ command: 'manualToken', token });
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.command === 'log') {
                            const log = document.getElementById('log');
                            const entry = document.createElement('div');
                            entry.style.marginBottom = '4px';
                            entry.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message.message;
                            log.appendChild(entry);
                            log.scrollTop = log.scrollHeight;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}

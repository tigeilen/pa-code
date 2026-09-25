import * as vscode from 'vscode';

export class ProcessExecutionPanel {
    public static currentPanel: ProcessExecutionPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _extensionUri: vscode.Uri,
        private readonly processName: string,
        private readonly parameters: any[],
        private readonly onExecute: (params: any[]) => void,
        private readonly defaultParameters?: any[],
        private readonly lastUsedParameters?: any[]
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getWebviewContent(processName, parameters, defaultParameters, lastUsedParameters);

        this._panel.webview.onDidReceiveMessage(
            message => {
                switch (message.command) {
                    case 'executeProcess':
                        this.onExecute(message.parameters);
                        this.dispose();
                        return;
                    case 'cancel':
                        this.dispose();
                        return;
                }
            },
            null,
            this._disposables
        );
    }

    public static render(
        extensionUri: vscode.Uri,
        processName: string,
        parameters: any[],
        onExecute: (params: any[]) => void,
        defaultParameters?: any[],
        lastUsedParameters?: any[]
    ) {
        if (ProcessExecutionPanel.currentPanel) {
            ProcessExecutionPanel.currentPanel.dispose();
        }

        const panel = vscode.window.createWebviewPanel(
            'processExecution',
            `Execute: ${processName}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        ProcessExecutionPanel.currentPanel = new ProcessExecutionPanel(panel, extensionUri, processName, parameters, onExecute, defaultParameters, lastUsedParameters);
    }

    public dispose() {
        ProcessExecutionPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _getWebviewContent(processName: string, parameters: any[], defaultParameters?: any[], lastUsedParameters?: any[]) {
        const paramFields = parameters.map((param, index) => {
            const isNumeric = param.Type === 1 || param.Type === 'Numeric';
            const inputType = isNumeric ? 'number' : 'text';
            const value = param.Value !== undefined ? param.Value : '';

            return `
                <div class="form-group">
                    <label for="param_${index}">${this.escapeHtml(param.Prompt || param.Name)}</label>
                    <small style="display: block; margin-bottom: 5px; opacity: 0.7;">${this.escapeHtml(param.Name)} (${isNumeric ? 'Numeric' : 'String'})</small>
                    <input type="${inputType}" id="param_${index}" data-name="${this.escapeHtml(param.Name)}" data-type="${isNumeric ? 'numeric' : 'string'}" value="${this.escapeHtml(String(value))}">
                </div>
            `;
        }).join('');

        const hasToggle = !!(defaultParameters && lastUsedParameters);
        const defaultParamsJson = defaultParameters ? JSON.stringify(defaultParameters) : '[]';
        const lastUsedParamsJson = lastUsedParameters ? JSON.stringify(lastUsedParameters) : '[]';

        const toggleHtml = hasToggle ? `
            <div class="toggle-bar">
                <button id="btnLastUsed" class="toggle-btn active" onclick="switchParams('lastUsed')">Last Used Parameters</button>
                <button id="btnDefaults" class="toggle-btn" onclick="switchParams('defaults')">Default Parameters</button>
            </div>
        ` : '';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; script-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Execute Process</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            color: var(--vscode-editor-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px;
            max-width: 600px;
            margin: 0 auto;
        }
        h2 {
            border-bottom: 1px solid var(--vscode-panel-border);
            padding-bottom: 10px;
            margin-bottom: 20px;
        }
        .form-group {
            margin-bottom: 15px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: bold;
        }
        .form-group input {
            width: 100%;
            padding: 8px;
            box-sizing: border-box;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
        }
        .form-group input:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-panel-border);
        }
        button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        button.secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        button.secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .toggle-bar {
            display: flex;
            gap: 0;
            margin-bottom: 20px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            overflow: hidden;
        }
        .toggle-btn {
            flex: 1;
            padding: 6px 12px;
            font-size: 12px;
            border: none;
            cursor: pointer;
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .toggle-btn.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .toggle-btn:hover:not(.active) {
            background: var(--vscode-button-secondaryHoverBackground);
        }
    </style>
</head>
<body>
    <h2>Execute Process: ${this.escapeHtml(processName)}</h2>
    
    ${toggleHtml}

    <div id="parametersForm">
        ${paramFields}
    </div>

    <div class="form-actions">
        <button id="cancelBtn" class="secondary">Cancel</button>
        <button id="executeBtn">Start Process</button>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const defaultParams = ${defaultParamsJson};
        const lastUsedParams = ${lastUsedParamsJson};
        
        function switchParams(mode) {
            const params = mode === 'lastUsed' ? lastUsedParams : defaultParams;
            const inputs = document.querySelectorAll('#parametersForm input');
            inputs.forEach(input => {
                const name = input.getAttribute('data-name');
                const match = params.find(p => p.Name === name);
                if (match) {
                    input.value = match.Value !== undefined ? match.Value : '';
                }
            });
            document.getElementById('btnLastUsed').classList.toggle('active', mode === 'lastUsed');
            document.getElementById('btnDefaults').classList.toggle('active', mode === 'defaults');
        }
        
        document.getElementById('cancelBtn').addEventListener('click', () => {
            vscode.postMessage({ command: 'cancel' });
        });

        document.getElementById('executeBtn').addEventListener('click', () => {
            const inputs = document.querySelectorAll('#parametersForm input');
            const parameters = [];
            
            inputs.forEach(input => {
                const name = input.getAttribute('data-name');
                const type = input.getAttribute('data-type');
                let value = input.value;
                
                if (type === 'numeric') {
                    value = value === '' ? 0 : Number(value);
                }
                
                parameters.push({ Name: name, Value: value });
            });
            
            vscode.postMessage({ 
                command: 'executeProcess',
                parameters: parameters
            });
        });
    </script>
</body>
</html>`;
    }

    private escapeHtml(unsafe: string): string {
        return (unsafe || "").toString()
             .replace(/&/g, "&amp;")
             .replace(/</g, "&lt;")
             .replace(/>/g, "&gt;")
             .replace(/"/g, "&quot;")
             .replace(/'/g, "&#039;");
    }
}

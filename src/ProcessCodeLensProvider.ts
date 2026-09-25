import * as vscode from 'vscode';
import * as path from 'path';

export class ProcessCodeLensProvider implements vscode.CodeLensProvider {
    private onDidChangeCodeLensesEmitter: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this.onDidChangeCodeLensesEmitter.event;

    constructor() { }

    public provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] | Thenable<vscode.CodeLens[]> {
        const lenses: vscode.CodeLens[] = [];

        // Ensure we are in a workspace folder
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!workspaceFolder) { return lenses; }

        // Parse path: <Workspace>/<EnvironmentFolder>/<ServerName>/Processes/ProcessName.ti
        const fsPath = document.uri.fsPath;
        const processName = path.basename(fsPath, '.ti');

        // Find environment and instance names from the file path
        const parentDir = path.dirname(fsPath);
        const subFolder = path.basename(parentDir); // "Processes"

        if (subFolder !== 'Processes') { return lenses; }

        const serverFolder = path.dirname(parentDir);
        const serverRealName = path.basename(serverFolder);
        const envFolderDir = path.dirname(serverFolder);
        const envFolder = path.basename(envFolderDir);

        // Always show the CodeLens at the top of the document
        const range = new vscode.Range(0, 0, 0, 0);

        const runCommand: vscode.Command = {
            title: "$(play) Run",
            tooltip: `Execute process ${processName} on ${serverRealName}`,
            command: "pa-code.executeProcessByLens",
            arguments: [envFolder, serverRealName, processName]
        };

        const debugCommand: vscode.Command = {
            title: "$(bug) Debug",
            tooltip: `Debug process ${processName} on ${serverRealName}`,
            command: "pa-code.debugProcessByLens",
            arguments: [envFolder, serverRealName, processName]
        };

        lenses.push(new vscode.CodeLens(range, runCommand));
        lenses.push(new vscode.CodeLens(range, debugCommand));

        return lenses;
    }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { TM1Service } from './TM1Service';
import { ProcessParser, SectionOffsets } from './processParser';
import { ConfigManager } from './ConfigManager';

// ─── DAP Message Types ───────────────────────────────────────────────

interface DAPMessage {
    seq: number;
    type: string;
}

interface DAPRequest extends DAPMessage {
    type: 'request';
    command: string;
    arguments?: any;
}

interface DAPResponse extends DAPMessage {
    type: 'response';
    request_seq: number;
    command: string;
    success: boolean;
    message?: string;
    body?: any;
}

interface DAPEvent extends DAPMessage {
    type: 'event';
    event: string;
    body?: any;
}

// ─── TM1 Debug Adapter (Inline) ──────────────────────────────────────

export class TM1DebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
    createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
        return new vscode.DebugAdapterInlineImplementation(new TM1DebugAdapter());
    }
}

export class TM1DebugConfigurationProvider implements vscode.DebugConfigurationProvider {

    resolveDebugConfiguration(
        folder: vscode.WorkspaceFolder | undefined,
        config: vscode.DebugConfiguration,
        token?: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.DebugConfiguration> {
        // If launch config is empty (user just pressed F5 with no launch.json), fill in defaults
        if (!config.type && !config.request && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName.endsWith('.ti')) {
                config.type = 'tm1';
                config.request = 'launch';
                config.name = 'Debug TI Process';
                config.program = editor.document.uri.fsPath;
                config.stopOnEntry = true;
            }
        }

        if (!config.program) {
            return vscode.window.showInformationMessage('Cannot find a .ti file to debug').then(_ => undefined);
        }

        return config;
    }
}

export class TM1DebugAdapter implements vscode.DebugAdapter {
    private sendMessageEmitter = new vscode.EventEmitter<DAPResponse | DAPEvent>();
    readonly onDidSendMessage: vscode.Event<DAPResponse | DAPEvent> = this.sendMessageEmitter.event;

    private seq = 1;
    private debugId: string = '';
    private instanceName: string = '';
    private processName: string = '';
    private programPath: string = '';
    private sectionOffsets: SectionOffsets = {};
    private fileContent: string = '';

    // Breakpoint ID counter for VS Code
    private nextBpId = 1;
    // Map: VS Code breakpoint ID → TM1 breakpoint ID
    private bpMap = new Map<number, number>();
    // Pending breakpoints to set once debug session starts (file line → condition)
    private pendingBreakpoints: { line: number; condition?: string }[] = [];

    // Variable reference IDs
    private static readonly SCOPE_LOCAL = 1;



    handleMessage(message: DAPMessage): void {
        if (message.type === 'request') {
            this.handleRequest(message as DAPRequest);
        }
    }

    private async handleRequest(request: DAPRequest): Promise<void> {
        try {
            switch (request.command) {
                case 'initialize': this.onInitialize(request); break;
                case 'launch': await this.onLaunch(request); break;
                case 'setBreakpoints': await this.onSetBreakpoints(request); break;
                case 'setExceptionBreakpoints': this.sendResponse(request, {}); break;
                case 'configurationDone': await this.onConfigurationDone(request); break;
                case 'threads': this.onThreads(request); break;
                case 'stackTrace': await this.onStackTrace(request); break;
                case 'scopes': this.onScopes(request); break;
                case 'variables': await this.onVariables(request); break;
                case 'continue': await this.onContinue(request); break;
                case 'next': await this.onNext(request); break;
                case 'stepIn': await this.onStepIn(request); break;
                case 'stepOut': await this.onStepOut(request); break;
                case 'evaluate': await this.onEvaluate(request); break;
                case 'disconnect': await this.onDisconnect(request); break;
                case 'terminate': await this.onDisconnect(request); break;
                case 'pause': this.sendResponse(request, {}); break;
                case 'source': this.sendResponse(request, { content: this.fileContent }); break;
                default:
                    this.sendResponse(request, {});
                    break;
            }
        } catch (err: any) {
            this.sendErrorResponse(request, err.message || 'Unknown error');
        }
    }

    // ─── Initialize ──────────────────────────────────────────────────

    private onInitialize(request: DAPRequest): void {
        this.sendResponse(request, {
            supportsConfigurationDoneRequest: true,
            supportsConditionalBreakpoints: true,
            supportsEvaluateForHovers: true,
            supportsSetVariable: false,
            supportsStepBack: false,
            supportsRestartFrame: false,
            supportsGotoTargetsRequest: false,
            supportsTerminateRequest: true,
            supportTerminateDebuggee: true,
            supportsFunctionBreakpoints: false,
            supportsDataBreakpoints: false,
        });

        this.sendEvent('initialized', {});
    }

    // ─── Launch ──────────────────────────────────────────────────────

    private async onLaunch(request: DAPRequest): Promise<void> {
        const args = request.arguments;
        this.programPath = args.program;

        if (!fs.existsSync(this.programPath)) {
            throw new Error(`File not found: ${this.programPath}`);
        }

        // Parse path: <workspace>/<envFolder>/<serverName>/Processes/<processName>.ti
        this.processName = path.basename(this.programPath, '.ti');
        const parentDir = path.dirname(this.programPath);
        const subFolder = path.basename(parentDir);
        if (subFolder !== 'Processes') {
            throw new Error('Debug is only supported for files in a Processes folder.');
        }
        const serverFolder = path.dirname(parentDir);
        const serverRealName = path.basename(serverFolder);
        const envFolderDir = path.dirname(serverFolder);
        const envFolder = path.basename(envFolderDir);

        // Resolve instance name from config
        const config = ConfigManager.getConfig();
        const envConfig = config.environments.find((e: any) => e.folder === envFolder);
        if (!envConfig) {
            throw new Error(`Environment configuration not found for folder '${envFolder}'.`);
        }
        this.instanceName = `${envConfig.name}_${serverRealName}`;

        // Verify connection
        if (!TM1Service.getInstance().isConnected(this.instanceName)) {
            throw new Error(`Not connected to ${serverRealName}. Please connect via PA Code Explorer first.`);
        }

        // Read file content and compute section offsets
        this.fileContent = fs.readFileSync(this.programPath, 'utf8');
        this.sectionOffsets = ProcessParser.getSectionOffsets(this.fileContent);

        // Collect parameters if provided in launch config
        const parameters = args.parameters || [];

        // Start debug session on TM1 server
        this.sendEvent('output', { category: 'console', output: `Starting debug session for '${this.processName}' on ${serverRealName}...\n` });

        try {
            const result = await TM1Service.getInstance().debugProcess(this.instanceName, this.processName, parameters);
            this.debugId = result.ID;
        } catch (err: any) {
            throw new Error(`Failed to start debug session: ${err.message}`);
        }

        this.sendEvent('output', { category: 'console', output: `Debug session started (ID: ${this.debugId})\n` });

        // Apply any pending breakpoints that were set before launch
        if (this.pendingBreakpoints.length > 0) {
            await this.applyBreakpointsToTM1(this.pendingBreakpoints);
        }

        // If stopOnEntry, send stopped event; otherwise continue to first breakpoint
        if (args.stopOnEntry !== false) {
            // TM1 debug starts paused at the first line automatically
            this.sendStoppedEvent('entry');
        } else {
            // Continue execution to first breakpoint
            try {
                const state = await TM1Service.getInstance().debugContinue(this.instanceName, this.debugId);
                this.handleTM1DebugState(state);
            } catch {
                this.sendStoppedEvent('entry');
            }
        }

        this.sendResponse(request, {});
    }

    // ─── Configuration Done ──────────────────────────────────────────

    private async onConfigurationDone(request: DAPRequest): Promise<void> {
        this.sendResponse(request, {});
    }

    // ─── Breakpoints ─────────────────────────────────────────────────

    private async onSetBreakpoints(request: DAPRequest): Promise<void> {
        const args = request.arguments;
        const sourcePath: string = args.source?.path || '';
        const clientLines: { line: number; condition?: string }[] = args.breakpoints || [];

        // Only handle breakpoints for the file being debugged
        const normalizedSource = path.normalize(sourcePath).toLowerCase();
        const normalizedProgram = path.normalize(this.programPath).toLowerCase();

        if (normalizedSource !== normalizedProgram && this.programPath) {
            // Breakpoints in a different file — acknowledge but don't set on TM1
            const breakpoints = clientLines.map(bp => ({
                verified: false,
                line: bp.line,
                message: 'Breakpoints only supported in the debugged process file'
            }));
            this.sendResponse(request, { breakpoints });
            return;
        }

        // Read file for section offsets if not already loaded
        if (!this.sectionOffsets || Object.keys(this.sectionOffsets).length === 0) {
            if (fs.existsSync(sourcePath)) {
                const content = fs.readFileSync(sourcePath, 'utf8');
                this.sectionOffsets = ProcessParser.getSectionOffsets(content);
                this.programPath = sourcePath;
            }
        }

        // Build verified breakpoints
        const verifiedBreakpoints: any[] = [];
        const validBreakpoints: { line: number; condition?: string }[] = [];

        for (const bp of clientLines) {
            const fileLine = bp.line - 1; // Convert 1-based DAP line to 0-based
            const tm1Info = ProcessParser.fileLineToTM1Line(fileLine, this.sectionOffsets);
            if (tm1Info) {
                verifiedBreakpoints.push({
                    verified: true,
                    line: bp.line,
                    source: args.source,
                });
                validBreakpoints.push({ line: bp.line, condition: bp.condition });
            } else {
                verifiedBreakpoints.push({
                    verified: false,
                    line: bp.line,
                    message: 'Line is not inside a TI code section'
                });
            }
        }

        // If debug session is active, apply breakpoints to TM1
        if (this.debugId) {
            // Remove all existing TM1 breakpoints first
            for (const [vscId, tm1Id] of this.bpMap.entries()) {
                try {
                    await TM1Service.getInstance().debugRemoveBreakpoint(this.instanceName, this.debugId, tm1Id);
                } catch { /* ignore removal errors */ }
            }
            this.bpMap.clear();
            this.nextBpId = 1;

            await this.applyBreakpointsToTM1(validBreakpoints);
        } else {
            // Debug session not started yet — store as pending
            this.pendingBreakpoints = validBreakpoints;
        }

        this.sendResponse(request, { breakpoints: verifiedBreakpoints });
    }

    private async applyBreakpointsToTM1(breakpoints: { line: number; condition?: string }[]): Promise<void> {
        const tm1Breakpoints: any[] = [];

        for (const bp of breakpoints) {
            const fileLine = bp.line - 1; // 0-based
            const tm1Info = ProcessParser.fileLineToTM1Line(fileLine, this.sectionOffsets);
            if (!tm1Info) continue;

            const bpId = this.nextBpId++;
            const tm1Bp: any = {
                '@odata.type': '#ibm.tm1.api.v1.ProcessDebugContextLineBreakpoint',
                'ID': bpId,
                'Enabled': true,
                'HitMode': bp.condition ? 'BreakOnExpression' : 'BreakAlways',
                'Expression': bp.condition || '',
                'ProcessName': this.processName,
                'Procedure': tm1Info.section,
                'LineNumber': tm1Info.tm1Line
            };

            tm1Breakpoints.push(tm1Bp);
            this.bpMap.set(bpId, bpId);
        }

        if (tm1Breakpoints.length > 0) {
            try {
                await TM1Service.getInstance().debugAddBreakpoints(this.instanceName, this.debugId, tm1Breakpoints);
            } catch (err: any) {
                this.sendEvent('output', { category: 'stderr', output: `Failed to set breakpoints: ${err.message}\n` });
            }
        }
    }

    // ─── Threads ─────────────────────────────────────────────────────

    private onThreads(request: DAPRequest): void {
        // TM1 debug is single-threaded
        this.sendResponse(request, {
            threads: [{ id: 1, name: 'TM1 Process Thread' }]
        });
    }

    // ─── Stack Trace ─────────────────────────────────────────────────

    private async onStackTrace(request: DAPRequest): Promise<void> {
        if (!this.debugId) {
            this.sendResponse(request, { stackFrames: [], totalFrames: 0 });
            return;
        }

        try {
            const state = await TM1Service.getInstance().debugGetState(this.instanceName, this.debugId);
            const callStack = state.CallStack || [];
            const stackFrames: any[] = [];

            for (let i = 0; i < callStack.length; i++) {
                const frame = callStack[i];
                const procedure: string = frame.Procedure || 'Prolog';
                const lineNumber: number = frame.LineNumber || 1;
                const processName: string = frame.Process?.Name || this.processName;

                // Determine the source file path for this frame
                let sourcePath = this.programPath;
                let fileLine = lineNumber; // fallback

                if (processName === this.processName) {
                    // Current process — map TM1 line to file line
                    const fileLineIdx = ProcessParser.tm1LineToFileLine(procedure, lineNumber, this.sectionOffsets);
                    if (fileLineIdx >= 0) {
                        fileLine = fileLineIdx + 1; // Convert 0-based to 1-based for DAP
                    }
                } else {
                    // Sub-process — try to find its .ti file in workspace
                    const subProcessPath = this.findProcessFile(processName);
                    if (subProcessPath) {
                        sourcePath = subProcessPath;
                        const subContent = fs.readFileSync(subProcessPath, 'utf8');
                        const subOffsets = ProcessParser.getSectionOffsets(subContent);
                        const fileLineIdx = ProcessParser.tm1LineToFileLine(procedure, lineNumber, subOffsets);
                        if (fileLineIdx >= 0) {
                            fileLine = fileLineIdx + 1;
                        }
                    }
                }

                stackFrames.push({
                    id: i,
                    name: `${processName} - ${procedure}`,
                    source: {
                        name: path.basename(sourcePath),
                        path: sourcePath,
                    },
                    line: fileLine,
                    column: 1,
                });
            }

            this.sendResponse(request, { stackFrames, totalFrames: stackFrames.length });
        } catch (err: any) {
            this.sendResponse(request, { stackFrames: [], totalFrames: 0 });
        }
    }

    private findProcessFile(processName: string): string | undefined {
        // Look in the same server folder as the current process
        const processesDir = path.dirname(this.programPath);
        const candidate = path.join(processesDir, `${processName}.ti`);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        return undefined;
    }

    // ─── Scopes ──────────────────────────────────────────────────────

    private onScopes(request: DAPRequest): void {
        this.sendResponse(request, {
            scopes: [
                {
                    name: 'Variables',
                    variablesReference: TM1DebugAdapter.SCOPE_LOCAL,
                    expensive: false,
                }
            ]
        });
    }

    // ─── Variables ───────────────────────────────────────────────────

    private async onVariables(request: DAPRequest): Promise<void> {
        if (!this.debugId) {
            this.sendResponse(request, { variables: [] });
            return;
        }

        try {
            const state = await TM1Service.getInstance().debugGetState(this.instanceName, this.debugId);
            const callStack = state.CallStack || [];
            const variables: any[] = [];

            if (callStack.length > 0 && callStack[0].Variables) {
                for (const v of callStack[0].Variables) {
                    variables.push({
                        name: v.Name,
                        value: String(v.Value ?? ''),
                        type: typeof v.Value === 'number' ? 'number' : 'string',
                        variablesReference: 0, // no children
                    });
                }
            }

            this.sendResponse(request, { variables });
        } catch (err: any) {
            this.sendResponse(request, { variables: [] });
        }
    }

    // ─── Execution Control ───────────────────────────────────────────

    private async onContinue(request: DAPRequest): Promise<void> {
        this.sendResponse(request, { allThreadsContinued: true });
        try {
            const state = await TM1Service.getInstance().debugContinue(this.instanceName, this.debugId);
            this.handleTM1DebugState(state);
        } catch (err: any) {
            this.sendEvent('output', { category: 'stderr', output: `Continue failed: ${err.message}\n` });
            this.sendEvent('terminated', {});
        }
    }

    private async onNext(request: DAPRequest): Promise<void> {
        this.sendResponse(request, {});
        try {
            const state = await TM1Service.getInstance().debugStepOver(this.instanceName, this.debugId);
            this.handleTM1DebugState(state);
        } catch (err: any) {
            this.sendEvent('output', { category: 'stderr', output: `Step Over failed: ${err.message}\n` });
            this.sendEvent('terminated', {});
        }
    }

    private async onStepIn(request: DAPRequest): Promise<void> {
        this.sendResponse(request, {});
        try {
            const state = await TM1Service.getInstance().debugStepIn(this.instanceName, this.debugId);
            this.handleTM1DebugState(state);
        } catch (err: any) {
            this.sendEvent('output', { category: 'stderr', output: `Step In failed: ${err.message}\n` });
            this.sendEvent('terminated', {});
        }
    }

    private async onStepOut(request: DAPRequest): Promise<void> {
        this.sendResponse(request, {});
        try {
            const state = await TM1Service.getInstance().debugStepOut(this.instanceName, this.debugId);
            this.handleTM1DebugState(state);
        } catch (err: any) {
            this.sendEvent('output', { category: 'stderr', output: `Step Out failed: ${err.message}\n` });
            this.sendEvent('terminated', {});
        }
    }

    // ─── Evaluate (Watch / Hover) ────────────────────────────────────

    private async onEvaluate(request: DAPRequest): Promise<void> {
        const expression = request.arguments?.expression || '';

        if (!this.debugId) {
            this.sendResponse(request, { result: '', variablesReference: 0 });
            return;
        }

        try {
            // Try to find the variable in current state
            const state = await TM1Service.getInstance().debugGetState(this.instanceName, this.debugId);
            const callStack = state.CallStack || [];

            if (callStack.length > 0 && callStack[0].Variables) {
                const variable = callStack[0].Variables.find(
                    (v: any) => v.Name.toLowerCase() === expression.toLowerCase()
                );
                if (variable) {
                    this.sendResponse(request, {
                        result: String(variable.Value ?? ''),
                        variablesReference: 0
                    });
                    return;
                }
            }

            this.sendResponse(request, { result: `Variable '${expression}' not found`, variablesReference: 0 });
        } catch {
            this.sendResponse(request, { result: `Could not evaluate '${expression}'`, variablesReference: 0 });
        }
    }

    // ─── Disconnect ──────────────────────────────────────────────────

    private async onDisconnect(request: DAPRequest): Promise<void> {
        if (this.debugId && this.instanceName) {
            try {
                // Step out to end the debug session cleanly
                await TM1Service.getInstance().debugStepOut(this.instanceName, this.debugId);
            } catch { /* session may already be finished */ }
        }
        this.debugId = '';
        this.sendResponse(request, {});
    }

    // ─── Handle TM1 Debug State ──────────────────────────────────────

    private handleTM1DebugState(state: any): void {
        const status = state.Status;

        if (status === 'Complete') {
            this.sendEvent('output', { category: 'console', output: 'Process execution completed.\n' });
            this.sendEvent('terminated', {});
            this.debugId = '';
            return;
        }

        // Process is paused (at breakpoint or after step)
        const callStack = state.CallStack || [];
        if (callStack.length > 0) {
            const frame = callStack[0];
            const procedure = frame.Procedure || 'Prolog';


            const lineNumber = frame.LineNumber || 1;
            const processName = frame.Process?.Name || this.processName;

            this.sendEvent('output', {
                category: 'console',
                output: `Paused at ${processName} → ${procedure} line ${lineNumber}\n`
            });
        }

        // Determine the stop reason
        const currentBreakpoint = state.CurrentBreakpoint;
        if (currentBreakpoint) {
            this.sendStoppedEvent('breakpoint');
        } else {
            this.sendStoppedEvent('step');
        }
    }

    // ─── DAP Protocol Helpers ────────────────────────────────────────

    private sendResponse(request: DAPRequest, body: any): void {
        const response: DAPResponse = {
            seq: this.seq++,
            type: 'response',
            request_seq: request.seq,
            command: request.command,
            success: true,
            body: body
        };
        this.sendMessageEmitter.fire(response);
    }

    private sendErrorResponse(request: DAPRequest, message: string): void {
        const response: DAPResponse = {
            seq: this.seq++,
            type: 'response',
            request_seq: request.seq,
            command: request.command,
            success: false,
            message: message,
            body: { error: { id: 1, format: message } }
        };
        this.sendMessageEmitter.fire(response);
    }

    private sendEvent(event: string, body?: any): void {
        const evt: DAPEvent = {
            seq: this.seq++,
            type: 'event',
            event: event,
            body: body
        };
        this.sendMessageEmitter.fire(evt);
    }

    private sendStoppedEvent(reason: string): void {
        this.sendEvent('stopped', {
            reason: reason,
            threadId: 1,
            allThreadsStopped: true
        });
    }

    dispose(): void {
        this.sendMessageEmitter.dispose();
    }
}

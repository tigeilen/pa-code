import * as vscode from 'vscode';

/**
 * Opt-in "delightful" celebration of a successful process run. Styles:
 *  - 'balloons' (default): an animated toast with rising balloons, then a
 *    persistent success message.
 *  - 'fireworks': an animated toast with rockets + a burst, then the message.
 *  - 'panel': a short-lived webview beside the editor with floating balloons.
 */
export class CelebrationPanel {
    public static celebrateProcessSuccess(processName?: string, timeStr?: string): void {
        const style = vscode.workspace.getConfiguration('pa-code').get<string>('delight.celebrationStyle', 'balloons');
        if (style === 'panel') { CelebrationPanel.balloons(); return; }
        const frames = style === 'fireworks' ? CelebrationPanel.FIREWORKS : CelebrationPanel.BALLOONS;
        CelebrationPanel.toast(frames, processName, timeStr);
    }

    /** Success message text; a random cheerful phrase when delight.funMessages is on. */
    public static successMessage(processName?: string, timeStr?: string): string {
        const nameStr = processName ? ` \u2018${processName}\u2019` : '';
        const timeSuffix = timeStr ? ` \u00b7 ${timeStr}` : '';
        const fun = vscode.workspace.getConfiguration('pa-code').get<boolean>('delight.funMessages', true);
        if (fun) {
            const phrases = ['\uD83C\uDFAF Nailed it!', '\u2728 Clean run!', '\uD83D\uDCA5 Boom!', '\uD83D\uDE80 Shipped it!', '\uD83E\uDDC8 Smooth as butter!', '\uD83C\uDFC6 Flawless!', '\uD83D\uDD25 Crushed it!', '\uD83C\uDFAC That\u2019s a wrap!', '\uD83D\uDC4F Well done!', '\u26A1 Lightning fast!'];
            return `${phrases[Math.floor(Math.random() * phrases.length)]}${nameStr}${timeSuffix}`;
        }
        return `\uD83C\uDF89 Success!${nameStr}${timeSuffix}`;
    }

    /** First-connect-of-the-day greeting (delight.dailyGreeting), shown at most once per day. */
    public static maybeDailyGreeting(context: vscode.ExtensionContext): void {
        if (!vscode.workspace.getConfiguration('pa-code').get<boolean>('delight.dailyGreeting', true)) { return; }
        const today = new Date().toISOString().slice(0, 10);
        const key = 'pa-code.delight.lastGreetDay';
        if (context.globalState.get<string>(key) === today) { return; }
        context.globalState.update(key, today);
        const h = new Date().getHours();
        const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
        const emoji = h < 12 ? '\u2600\uFE0F' : h < 18 ? '\uD83C\uDF24\uFE0F' : '\uD83C\uDF19';
        vscode.window.showInformationMessage(`${emoji} ${part}! Welcome back to PA Code \u2014 first connect of the day. Happy modeling!`);
    }

    // --------------------------------------------------------------- toast styles
    private static readonly BALLOONS = [
        '\uD83C\uDF88',
        '\uD83C\uDF88\uD83C\uDF88',
        '\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88',
        '\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88',
        '\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88\uD83C\uDF88'
    ];
    private static readonly FIREWORKS = [
        '\uD83D\uDE80',
        '\uD83D\uDE80\uD83D\uDE80',
        '\uD83D\uDE80\uD83D\uDE80\uD83D\uDE80',
        '\u2728 \uD83C\uDF86 \u2728'
    ];

    /** Short animated toast (balloons or fireworks). The frame animation always
     *  takes the same total time regardless of frame count; when it finishes a
     *  persistent success message appears, both linger together, then the
     *  animated toast closes and the success message stays. */
    private static toast(frames: string[], processName?: string, timeStr?: string): void {
        const totalMs = 1200;
        const perFrame = Math.max(150, Math.round(totalMs / frames.length));
        const holdMs = 3200;
        const endFrame = frames[frames.length - 1];
        const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
        vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, cancellable: false, title: '\uD83C\uDF89 Process succeeded' },
            async (progress) => {
                for (const f of frames) { progress.report({ message: f }); await wait(perFrame); }
                progress.report({ message: endFrame });
                // Animation done -> now the success toast appears; both then linger.
                vscode.window.showInformationMessage(CelebrationPanel.successMessage(processName, timeStr));
                await wait(holdMs);
            }
        );
    }

    // ------------------------------------------------------------------- balloons
    private static panel: vscode.WebviewPanel | undefined;
    private static closeTimer: ReturnType<typeof setTimeout> | undefined;

    /** Rising balloons. Reuses one panel so rapid successes don't stack tabs. */
    public static balloons(): void {
        const durationMs = 4200;
        if (!CelebrationPanel.panel) {
            CelebrationPanel.panel = vscode.window.createWebviewPanel(
                'paCodeCelebrate', '🎈',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: false }
            );
            CelebrationPanel.panel.onDidDispose(() => {
                CelebrationPanel.panel = undefined;
                if (CelebrationPanel.closeTimer) { clearTimeout(CelebrationPanel.closeTimer); CelebrationPanel.closeTimer = undefined; }
            });
        }
        const panel = CelebrationPanel.panel;
        panel.webview.html = CelebrationPanel.html();
        panel.reveal(vscode.ViewColumn.Beside, true);
        if (CelebrationPanel.closeTimer) { clearTimeout(CelebrationPanel.closeTimer); }
        CelebrationPanel.closeTimer = setTimeout(() => { try { panel.dispose(); } catch { /* already gone */ } }, durationMs);
    }

    private static html(): string {
        return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; background: var(--vscode-editor-background); }
  .stage { position: fixed; inset: 0; overflow: hidden; }
  .balloon { position: absolute; bottom: -160px; width: 46px; height: 58px; border-radius: 50% 50% 48% 48%;
             will-change: transform; animation: rise var(--dur) cubic-bezier(.36,.05,.4,1) var(--delay) forwards; }
  .balloon::before { content: ''; position: absolute; left: 50%; bottom: -3px; width: 8px; height: 8px;
             transform: translateX(-50%) rotate(45deg); background: inherit; filter: brightness(.85); }
  .balloon::after { content: ''; position: absolute; left: 50%; top: 100%; width: 1px; height: 60px;
             background: rgba(180,180,180,.55); transform: translateX(-50%); }
  .balloon .shine { position: absolute; top: 9px; left: 10px; width: 12px; height: 16px; border-radius: 50%;
             background: rgba(255,255,255,.45); filter: blur(1px); }
  .sway { position: absolute; bottom: 0; animation: sway var(--sway) ease-in-out infinite alternate; }
  @keyframes rise { to { transform: translateY(-130vh); } }
  @keyframes sway { from { transform: translateX(-18px); } to { transform: translateX(18px); } }
  .caption { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
             font-family: var(--vscode-font-family); font-size: 40px; opacity: 0; animation: pop 2.6s ease forwards; }
  @keyframes pop { 0% { transform: scale(.4); opacity: 0; } 18% { transform: scale(1.15); opacity: 1; }
             35% { transform: scale(1); } 80% { opacity: 1; } 100% { opacity: 0; } }
</style></head>
<body>
  <div class="stage" id="stage"></div>
  <div class="caption">🎉</div>
<script>
  var colors = ['#ff6b6b','#ffd93d','#6bcB77','#4d96ff','#c084fc','#ff8fab','#22d3ee','#f97316'];
  var stage = document.getElementById('stage');
  var W = window.innerWidth || 800;
  var N = Math.max(16, Math.min(40, Math.round(W / 26)));
  for (var i = 0; i < N; i++) {
    var sway = document.createElement('div');
    sway.className = 'sway';
    sway.style.left = Math.round(Math.random() * 100) + 'vw';
    sway.style.setProperty('--sway', (1.6 + Math.random() * 1.6).toFixed(2) + 's');
    var b = document.createElement('div');
    b.className = 'balloon';
    var c = colors[i % colors.length];
    b.style.background = c;
    var scale = (0.7 + Math.random() * 0.8).toFixed(2);
    b.style.transform = 'scale(' + scale + ')';
    b.style.setProperty('--dur', (2.6 + Math.random() * 1.6).toFixed(2) + 's');
    b.style.setProperty('--delay', (Math.random() * 0.9).toFixed(2) + 's');
    var shine = document.createElement('div');
    shine.className = 'shine';
    b.appendChild(shine);
    sway.appendChild(b);
    stage.appendChild(sway);
  }
</script>
</body></html>`;
    }
}

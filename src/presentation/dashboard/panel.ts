/**
 * DashboardPanel — WebView panel for live stats, queue status, and settings
 *
 * Communication:
 *   Extension → WebView: panel.webview.postMessage({ type, data })
 *   WebView → Extension: acquireVsCodeApi().postMessage({ type, ... })
 *
 * Singleton: Only one panel can be open at a time.
 */

import * as vscode from 'vscode';
import { IEventBus } from '../../domain/interfaces/event-bus';
import { DisposableStore } from '../../core/disposable';
import { SessionStats } from '../../domain/types/stats';
import { RuntimeConfigService } from '../../application/runtime-config-service';
import { TerminalWatchdog } from '../../infrastructure/terminal/watchdog';

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private readonly disposables = new DisposableStore();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly eventBus: IEventBus,
    private readonly runtimeConfigService?: RuntimeConfigService,
    private readonly watchdog?: TerminalWatchdog,
  ) {
    this.setupMessageBridge();

    // Clean up on panel close
    panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
      this.disposables.dispose();
    });

    // Push initial runtime config and watchdog status
    this.pushRuntimeConfig();
    this.pushWatchdogStatus();
  }

  // ── Singleton factory ────────────────────────────

  static createOrShow(
    extensionUri: vscode.Uri,
    eventBus: IEventBus,
    initialState?: { stats?: SessionStats; engineState?: string },
    runtimeConfigService?: RuntimeConfigService,
    watchdog?: TerminalWatchdog,
  ): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      // Push latest state on re-reveal too
      if (initialState) {
        DashboardPanel.instance.pushState(initialState);
      }
      DashboardPanel.instance.pushRuntimeConfig();
      DashboardPanel.instance.pushWatchdogStatus();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'domyhAutoAcceptDashboard',
      'Domyh Auto Accept — Dashboard',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );

    panel.webview.html = DashboardPanel.getHtmlContent(panel.webview);
    DashboardPanel.instance = new DashboardPanel(panel, eventBus, runtimeConfigService, watchdog);

    // Push initial state after a brief delay to let webview initialize
    if (initialState) {
      setTimeout(() => {
        DashboardPanel.instance?.pushState(initialState);
      }, 200);
    }
  }

  /** Push current state to the webview */
  private pushState(state: { stats?: SessionStats; engineState?: string }): void {
    if (state.stats) {
      this.panel.webview.postMessage({ type: 'stats', data: state.stats });
    }
    if (state.engineState) {
      this.panel.webview.postMessage({ type: 'state', data: state.engineState });
    }
  }

  /** Push runtime config to webview */
  private pushRuntimeConfig(): void {
    if (!this.runtimeConfigService) return;
    const config = this.runtimeConfigService.get();
    this.panel.webview.postMessage({
      type: 'runtimeConfig',
      data: {
        clickRun: config.clickRun,
        clickProceed: config.clickProceed,
        clickAcceptAll: config.clickAcceptAll,
        clickAllowOnce: config.clickAllowOnce,
        clickAllowConversation: config.clickAllowConversation,
        clickSend: config.clickSend,
        enabled: config.enabled,
      },
    });
  }

  /** Push watchdog status to webview */
  private pushWatchdogStatus(): void {
    if (!this.watchdog) return;
    this.panel.webview.postMessage({
      type: 'watchdog',
      data: {
        enabled: this.watchdog.isRuntimeEnabled(),
      },
    });
  }

  // ── Message Bridge ───────────────────────────────

  private setupMessageBridge(): void {
    // EventBus → WebView (live stats)
    this.disposables.add(
      this.eventBus.on('engine:statsUpdated', (stats: SessionStats) => {
        this.panel.webview.postMessage({ type: 'stats', data: stats });
      }),
    );

    this.disposables.add(
      this.eventBus.on('scheduler:queueAdvanced', (info: { index: number; total: number }) => {
        this.panel.webview.postMessage({ type: 'queue', data: info });
      }),
    );

    this.disposables.add(
      this.eventBus.on('scheduler:completed', () => {
        this.panel.webview.postMessage({ type: 'queueCompleted' });
      }),
    );

    this.disposables.add(
      this.eventBus.on('engine:stateChanged', (data: { from: unknown; to: unknown }) => {
        this.panel.webview.postMessage({ type: 'state', data: String(data.to) });
      }),
    );

    // CDP connection events → WebView
    this.disposables.add(
      this.eventBus.on('cdp:connected', (info: { port: number; targets: number }) => {
        this.panel.webview.postMessage({ type: 'cdp', data: { status: 'connected', ...info } });
      }),
    );
    this.disposables.add(
      this.eventBus.on('cdp:disconnected', (info: { reason: string }) => {
        this.panel.webview.postMessage({ type: 'cdp', data: { status: 'disconnected', ...info } });
      }),
    );
    this.disposables.add(
      this.eventBus.on('cdp:reconnecting', (info: { attempt: number; delay: number }) => {
        this.panel.webview.postMessage({ type: 'cdp', data: { status: 'reconnecting', ...info } });
      }),
    );

    // Death loop events → WebView
    this.disposables.add(
      this.eventBus.on('engine:deathLoopDetected', () => {
        this.panel.webview.postMessage({ type: 'activity', data: { event: '⚠️ Death loop detected — paused' } });
      }),
    );
    this.disposables.add(
      this.eventBus.on('engine:deathLoopReset', () => {
        this.panel.webview.postMessage({ type: 'activity', data: { event: '✅ Death loop reset' } });
      }),
    );

    // Command blocked → WebView (now implemented in engine.ts)
    this.disposables.add(
      this.eventBus.on('engine:commandBlocked', (info: { command: string; pattern: string }) => {
        this.panel.webview.postMessage({ type: 'activity', data: { event: `🛡️ Blocked: ${info.command} (${info.pattern})` } });
      }),
    );

    // Prompt sent → WebView
    this.disposables.add(
      this.eventBus.on('scheduler:promptSent', (info: { text: string }) => {
        const preview = info.text.length > 40 ? info.text.substring(0, 40) + '...' : info.text;
        this.panel.webview.postMessage({ type: 'activity', data: { event: `📝 Prompt: ${preview}` } });
      }),
    );

    // Runtime config changes → WebView
    this.disposables.add(
      this.eventBus.on('runtimeConfig:changed', () => {
        this.pushRuntimeConfig();
      }),
    );

    // WebView → Extension (user actions)
    this.disposables.add(
      this.panel.webview.onDidReceiveMessage(
        (msg: { type: string; action?: string }) => {
          switch (msg.type) {
            case 'toggle':
              vscode.commands.executeCommand('domyh-auto-accept.toggle');
              break;
            case 'toggleRuntimeConfig':
              if (msg.action) {
                vscode.commands.executeCommand(`domyh-auto-accept.toggleClick${msg.action}`);
              }
              break;
            case 'toggleWatchdog':
              if (this.watchdog) {
                if (this.watchdog.isRuntimeEnabled()) {
                  vscode.commands.executeCommand('domyh-auto-accept.watchdog.pause');
                } else {
                  vscode.commands.executeCommand('domyh-auto-accept.watchdog.resume');
                }
                // Update status after a brief delay
                setTimeout(() => this.pushWatchdogStatus(), 100);
              }
              break;
            case 'startQueue':
              vscode.commands.executeCommand('domyh-auto-accept.startQueue');
              break;
            case 'pauseQueue':
              vscode.commands.executeCommand('domyh-auto-accept.pauseQueue');
              break;
            case 'resumeQueue':
              vscode.commands.executeCommand('domyh-auto-accept.resumeQueue');
              break;
            case 'skipQueue':
              vscode.commands.executeCommand('domyh-auto-accept.skipQueue');
              break;
            case 'stopQueue':
              vscode.commands.executeCommand('domyh-auto-accept.stopQueue');
              break;
            case 'openSettings':
              vscode.commands.executeCommand('workbench.action.openSettings', 'domyh-auto-accept');
              break;
          }
        },
      ),
    );
  }

  // ── HTML Content ─────────────────────────────────

  private static getHtmlContent(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <title>Domyh Auto Accept — Dashboard</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1e1e2e);
      --fg: var(--vscode-editor-foreground, #cdd6f4);
      --card: var(--vscode-editorWidget-background, #313244);
      --border: var(--vscode-editorWidget-border, #45475a);
      --accent: var(--vscode-focusBorder, #89b4fa);
      --success: #a6e3a1;
      --warning: #f9e2af;
      --error: #f38ba8;
      --muted: var(--vscode-descriptionForeground, #a6adc8);
      --radius: 8px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--bg);
      color: var(--fg);
      padding: 12px;
      min-height: 100vh;
      font-size: 13px;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 16px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-right { 
      display: flex; 
      align-items: center; 
      gap: 6px; 
    }
    .icon-btn {
      width: 32px; 
      height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
      color: var(--fg);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      padding: 0;
      font-size: 16px;
    }
    .icon-btn:hover {
      background: var(--border);
      transform: scale(1.05);
    }
    .icon-btn.active {
      background: var(--accent);
      color: #1e1e2e;
      border-color: var(--accent);
    }
    .badge {
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 12px;
      font-weight: 500;
      white-space: nowrap;
    }
    .badge.active { background: var(--success); color: #1e1e2e; }
    .badge.idle { background: var(--border); color: var(--fg); }
    .badge.warning { background: var(--warning); color: #1e1e2e; }
    .badge.error { background: var(--error); color: #1e1e2e; }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
      margin-bottom: 12px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px;
      text-align: center;
      transition: transform 0.2s, box-shadow 0.2s;
      cursor: help;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .stat-value {
      font-size: 20px;
      font-weight: 700;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
      line-height: 1.2;
    }
    .stat-label {
      font-size: 9px;
      color: var(--muted);
      margin-top: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    /* Section */
    .section {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 10px;
    }
    .section-title {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Compact Info Row */
    .info-row {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .info-row:last-child {
      margin-bottom: 0;
    }
    .info-label {
      color: var(--muted);
      min-width: 80px;
    }
    .info-value {
      flex: 1;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-dot {
      width: 8px; 
      height: 8px;
      border-radius: 50%;
      background: var(--border);
      flex-shrink: 0;
    }
    .status-dot.connected { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.disconnected { background: var(--error); }
    .status-dot.reconnecting { background: var(--warning); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

    /* Toggle Switch */
    .toggle-switch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      user-select: none;
      font-size: 12px;
    }
    .toggle-switch input[type="checkbox"] {
      display: none;
    }
    .toggle-switch .slider {
      width: 36px;
      height: 20px;
      background: var(--border);
      border-radius: 10px;
      position: relative;
      transition: background 0.2s;
    }
    .toggle-switch .slider::before {
      content: '';
      position: absolute;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: var(--fg);
      top: 2px;
      left: 2px;
      transition: transform 0.2s;
    }
    .toggle-switch input:checked + .slider {
      background: var(--accent);
    }
    .toggle-switch input:checked + .slider::before {
      transform: translateX(16px);
      background: #1e1e2e;
    }
    .toggle-switch .label {
      color: var(--fg);
    }

    /* Progress Bar */
    .progress-bar {
      width: 100%; 
      height: 4px;
      background: var(--border); 
      border-radius: 2px;
      margin: 6px 0; 
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--success));
      border-radius: 2px;
      transition: width 0.4s ease;
    }
    .queue-info { 
      font-size: 11px; 
      opacity: 0.7; 
      margin-bottom: 6px; 
    }

    /* Buttons */
    .btn-row { 
      display: flex; 
      gap: 6px; 
      flex-wrap: wrap; 
    }
    .btn {
      padding: 5px 10px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
      color: var(--fg);
      cursor: pointer;
      font-size: 11px;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--border); }
    .btn.primary {
      background: var(--accent); 
      color: #1e1e2e;
      border-color: var(--accent);
    }
    .btn.primary:hover { opacity: 0.9; }

    /* Activity Log */
    .log-list { 
      list-style: none; 
      max-height: 150px; 
      overflow-y: auto; 
    }
    .log-item {
      padding: 4px 0;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .log-item:last-child { border-bottom: none; }
    .log-msg { 
      flex: 1; 
      overflow: hidden; 
      text-overflow: ellipsis; 
      white-space: nowrap; 
    }
    .log-time { 
      opacity: 0.4; 
      font-variant-numeric: tabular-nums; 
      flex-shrink: 0; 
      font-size: 10px;
    }

    /* Two Column Layout */
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    @media (max-width: 600px) {
      .two-col {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h1>⚡ Domyh Auto Accept</h1>
    <div class="header-right">
      <button class="icon-btn" onclick="send('toggle')" title="Toggle Engine On/Off" id="toggleBtn">▶</button>
      <button class="icon-btn" onclick="send('openSettings')" title="Open Settings">⚙</button>
      <span id="cdpBadge" class="badge idle">CDP: —</span>
      <span id="stateBadge" class="badge idle">Idle</span>
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="stats-grid">
    <div class="stat-card" title="Total buttons clicked automatically">
      <div id="statClicks" class="stat-value">0</div>
      <div class="stat-label">Clicks</div>
    </div>
    <div class="stat-card" title="Dangerous commands blocked">
      <div id="statBlocked" class="stat-value" style="color: var(--error)">0</div>
      <div class="stat-label">Blocked</div>
    </div>
    <div class="stat-card" title="Retry attempts">
      <div id="statRetries" class="stat-value" style="color: var(--warning)">0</div>
      <div class="stat-label">Retries</div>
    </div>
    <div class="stat-card" title="Scheduled prompts sent">
      <div id="statPrompts" class="stat-value" style="color: var(--success)">0</div>
      <div class="stat-label">Prompts</div>
    </div>
    <div class="stat-card" title="Estimated time saved (5s per click)">
      <div id="statTimeSaved" class="stat-value" style="color: var(--accent)">0s</div>
      <div class="stat-label">Time Saved</div>
    </div>
    <div class="stat-card" title="Session uptime">
      <div id="statUptime" class="stat-value" style="font-size: 16px; color: var(--muted)">—</div>
      <div class="stat-label">Uptime</div>
    </div>
  </div>

  <!-- Connection & Queue -->
  <div class="section">
    <div class="section-title">🔌 Connection & Queue</div>
    <div class="info-row">
      <span class="info-label">CDP:</span>
      <div class="info-value">
        <span id="cdpDot" class="status-dot"></span>
        <span id="cdpText">Not connected</span>
      </div>
    </div>
    <div class="info-row">
      <span class="info-label">Queue:</span>
      <div class="info-value">
        <span id="queueInfo">No queue active</span>
      </div>
    </div>
    <div class="progress-bar">
      <div id="queueProgress" class="progress-fill" style="width: 0%"></div>
    </div>
    <div class="btn-row" style="margin-top: 8px;">
      <button class="btn primary" onclick="send('startQueue')">▶ Start</button>
      <button class="btn" onclick="send('pauseQueue')">⏸ Pause</button>
      <button class="btn" onclick="send('resumeQueue')">▶ Resume</button>
      <button class="btn" onclick="send('skipQueue')">⏭ Skip</button>
      <button class="btn" onclick="send('stopQueue')">⏹ Stop</button>
    </div>
  </div>

  <!-- Runtime Config & Watchdog -->
  <div class="two-col">
    <!-- Runtime Config -->
    <div class="section">
      <div class="section-title">⚙️ Runtime Config</div>
      <div class="info-row">
        <label class="toggle-switch">
          <input type="checkbox" id="toggleRun" onchange="toggleRuntime('Run')">
          <span class="slider"></span>
          <span class="label">Run</span>
        </label>
      </div>
      <div class="info-row">
        <label class="toggle-switch">
          <input type="checkbox" id="toggleProceed" onchange="toggleRuntime('Proceed')">
          <span class="slider"></span>
          <span class="label">Proceed</span>
        </label>
      </div>
      <div class="info-row">
        <label class="toggle-switch">
          <input type="checkbox" id="toggleAcceptAll" onchange="toggleRuntime('AcceptAll')">
          <span class="slider"></span>
          <span class="label">Accept All</span>
        </label>
      </div>
      <div class="info-row">
        <label class="toggle-switch">
          <input type="checkbox" id="toggleAllowOnce" onchange="toggleRuntime('AllowOnce')">
          <span class="slider"></span>
          <span class="label">Allow Once</span>
        </label>
      </div>
    </div>

    <!-- Watchdog -->
    <div class="section">
      <div class="section-title">🐕 Terminal Watchdog(Beta Test)</div>
      <div class="info-row">
        <label class="toggle-switch">
          <input type="checkbox" id="toggleWatchdog" onchange="toggleWatchdog()">
          <span class="slider"></span>
          <span class="label">Enabled</span>
        </label>
      </div>
      <div class="info-row" style="font-size: 11px; color: var(--muted); margin-top: 8px;">
        Monitors terminal commands and recovers from stuck processes
      </div>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="section">
    <div class="section-title">📜 Activity</div>
    <ul id="logList" class="log-list">
      <li class="log-item">
        <span class="log-msg">Dashboard opened</span>
        <span class="log-time">${new Date().toLocaleTimeString()}</span>
      </li>
    </ul>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function send(type, action) { 
      vscode.postMessage({ type, action }); 
    }
    function toggleRuntime(action) {
      send('toggleRuntimeConfig', action);
    }
    function toggleWatchdog() {
      send('toggleWatchdog');
    }

    let sessionStart = 0;
    let lastClickTime = 0;

    function addLog(text) {
      const list = document.getElementById('logList');
      const li = document.createElement('li');
      li.className = 'log-item';
      const msgSpan = document.createElement('span');
      msgSpan.className = 'log-msg';
      msgSpan.textContent = text;
      msgSpan.title = text;
      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = new Date().toLocaleTimeString();
      li.appendChild(msgSpan);
      li.appendChild(timeSpan);
      list.prepend(li);
      while (list.children.length > 30) list.removeChild(list.lastChild);
    }

    function formatDuration(ms) {
      if (!ms || ms <= 0) return '—';
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      const h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }

    function formatTimeSaved(seconds) {
      if (!seconds || seconds <= 0) return '0s';
      if (seconds < 60) return seconds + 's';
      const m = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      if (m < 60) return m + 'm' + (remainingSeconds > 0 ? ' ' + remainingSeconds + 's' : '');
      const h = Math.floor(m / 60);
      const remainingMinutes = m % 60;
      return h + 'h' + (remainingMinutes > 0 ? ' ' + remainingMinutes + 'm' : '') + (remainingSeconds > 0 ? ' ' + remainingSeconds + 's' : '');
    }

    // Update uptime every second
    setInterval(function() {
      var uptimeEl = document.getElementById('statUptime');
      if (sessionStart > 0) {
        uptimeEl.textContent = formatDuration(Date.now() - sessionStart);
      } else {
        uptimeEl.textContent = '—';
      }
    }, 1000);

    window.addEventListener('message', function(event) {
      var type = event.data.type;
      var data = event.data.data;
      switch (type) {
        case 'stats':
          document.getElementById('statClicks').textContent = data.totalClicks || 0;
          document.getElementById('statBlocked').textContent = data.blockedCommands || 0;
          document.getElementById('statRetries').textContent = data.retriesAttempted || 0;
          document.getElementById('statPrompts').textContent = data.promptsSent || 0;
          document.getElementById('statTimeSaved').textContent = formatTimeSaved(data.estimatedTimeSaved || 0);
          if (data.sessionStartTime && data.sessionStartTime > 0) {
            sessionStart = data.sessionStartTime;
          }
          if (data.lastClickTime) lastClickTime = data.lastClickTime;
          break;

        case 'state': {
          var badge = document.getElementById('stateBadge');
          var toggleBtn = document.getElementById('toggleBtn');
          badge.textContent = data;
          badge.className = 'badge ' + (data === 'polling' || data === 'connected' ? 'active' : 'idle');
          if (toggleBtn) {
            toggleBtn.className = 'icon-btn' + (data === 'polling' ? ' active' : '');
            toggleBtn.title = data === 'polling' ? 'Engine: ON — Click to stop' : 'Engine: OFF — Click to start';
          }
          addLog('State: ' + data);
          break;
        }

        case 'cdp': {
          var dot = document.getElementById('cdpDot');
          var txt = document.getElementById('cdpText');
          var cdpBadge = document.getElementById('cdpBadge');
          dot.className = 'status-dot ' + data.status;
          if (data.status === 'connected') {
            txt.textContent = 'Connected (port ' + data.port + ', ' + data.targets + ' targets)';
            cdpBadge.textContent = 'CDP: ✓'; 
            cdpBadge.className = 'badge active';
          } else if (data.status === 'reconnecting') {
            txt.textContent = 'Reconnecting (#' + data.attempt + ', delay ' + (data.delay/1000) + 's)';
            cdpBadge.textContent = 'CDP: ↻'; 
            cdpBadge.className = 'badge warning';
          } else {
            txt.textContent = 'Disconnected' + (data.reason ? ': ' + data.reason : '');
            cdpBadge.textContent = 'CDP: ✗'; 
            cdpBadge.className = 'badge error';
          }
          addLog('CDP: ' + data.status);
          break;
        }

        case 'runtimeConfig': {
          if (data.clickRun !== undefined) {
            document.getElementById('toggleRun').checked = data.clickRun;
          }
          if (data.clickProceed !== undefined) {
            document.getElementById('toggleProceed').checked = data.clickProceed;
          }
          if (data.clickAcceptAll !== undefined) {
            document.getElementById('toggleAcceptAll').checked = data.clickAcceptAll;
          }
          if (data.clickAllowOnce !== undefined) {
            document.getElementById('toggleAllowOnce').checked = data.clickAllowOnce;
          }
          break;
        }

        case 'watchdog': {
          if (data.enabled !== undefined) {
            document.getElementById('toggleWatchdog').checked = data.enabled;
          }
          break;
        }

        case 'activity':
          addLog(data.event);
          break;

        case 'queue': {
          if (data.total && data.total > 0) {
            var pct = Math.min(100, ((data.index + 1) / data.total * 100).toFixed(0));
            document.getElementById('queueProgress').style.width = pct + '%';
            document.getElementById('queueInfo').textContent =
              'Prompt ' + (data.index + 1) + ' of ' + data.total;
            addLog('Queue: ' + (data.index + 1) + '/' + data.total);
          } else {
            document.getElementById('queueProgress').style.width = '0%';
            document.getElementById('queueInfo').textContent = 'No queue active';
          }
          break;
        }

        case 'queueCompleted':
          document.getElementById('queueProgress').style.width = '100%';
          document.getElementById('queueInfo').textContent = 'Queue completed ✅';
          addLog('Queue completed');
          break;
      }
    });
  </script>
</body>
</html>`;
  }
}

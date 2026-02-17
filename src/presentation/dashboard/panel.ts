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

export class DashboardPanel {
  private static instance: DashboardPanel | undefined;
  private readonly disposables = new DisposableStore();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly eventBus: IEventBus,
  ) {
    this.setupMessageBridge();

    // Clean up on panel close
    panel.onDidDispose(() => {
      DashboardPanel.instance = undefined;
      this.disposables.dispose();
    });
  }

  // ── Singleton factory ────────────────────────────

  static createOrShow(
    extensionUri: vscode.Uri,
    eventBus: IEventBus,
    initialState?: { stats?: SessionStats; engineState?: string },
  ): void {
    if (DashboardPanel.instance) {
      DashboardPanel.instance.panel.reveal();
      // Push latest state on re-reveal too
      if (initialState) {
        DashboardPanel.instance.pushState(initialState);
      }
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
    DashboardPanel.instance = new DashboardPanel(panel, eventBus);

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

    // Command blocked → WebView
    this.disposables.add(
      this.eventBus.on('engine:commandBlocked', (info: { command: string; pattern: string }) => {
        this.panel.webview.postMessage({ type: 'activity', data: { event: `🛡️ Blocked: ${info.command}` } });
      }),
    );

    // Prompt sent → WebView
    this.disposables.add(
      this.eventBus.on('scheduler:promptSent', (info: { text: string }) => {
        const preview = info.text.length > 40 ? info.text.substring(0, 40) + '...' : info.text;
        this.panel.webview.postMessage({ type: 'activity', data: { event: `📝 Prompt: ${preview}` } });
      }),
    );

    // WebView → Extension (user actions)
    this.disposables.add(
      this.panel.webview.onDidReceiveMessage(
        (msg: { type: string }) => {
          switch (msg.type) {
            case 'toggle':
              vscode.commands.executeCommand('domyh-auto-accept.toggle');
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
      padding: 16px;
      min-height: 100vh;
    }

    /* Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 500;
    }
    .badge.active { background: var(--success); color: #1e1e2e; }
    .badge.idle { background: var(--border); color: var(--fg); }
    .badge.warning { background: var(--warning); color: #1e1e2e; }
    .badge.error { background: var(--error); color: #1e1e2e; }

    /* Stats Grid */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 10px;
      margin-bottom: 16px;
    }
    .stat-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px;
      text-align: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--accent);
      font-variant-numeric: tabular-nums;
    }
    .stat-label {
      font-size: 10px;
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
      padding: 14px;
      margin-bottom: 12px;
    }
    .section-title {
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      opacity: 0.8;
    }

    /* CDP Status */
    .cdp-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .cdp-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--border);
      flex-shrink: 0;
    }
    .cdp-dot.connected { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .cdp-dot.disconnected { background: var(--error); }
    .cdp-dot.reconnecting { background: var(--warning); animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

    /* Progress Bar */
    .progress-bar {
      width: 100%; height: 6px;
      background: var(--border); border-radius: 3px;
      margin: 8px 0; overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--accent), var(--success));
      border-radius: 3px;
      transition: width 0.4s ease;
    }
    .queue-info { font-size: 12px; opacity: 0.7; margin-bottom: 10px; }

    /* Buttons */
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .btn {
      padding: 6px 12px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--card);
      color: var(--fg);
      cursor: pointer;
      font-size: 12px;
      transition: background 0.2s;
    }
    .btn:hover { background: var(--border); }
    .btn.primary {
      background: var(--accent); color: #1e1e2e;
      border-color: var(--accent);
    }
    .btn.primary:hover { opacity: 0.9; }

    /* Activity Log */
    .log-list { list-style: none; max-height: 180px; overflow-y: auto; }
    .log-item {
      padding: 5px 0;
      border-bottom: 1px solid var(--border);
      font-size: 11px;
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .log-item:last-child { border-bottom: none; }
    .log-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .log-time { opacity: 0.4; font-variant-numeric: tabular-nums; flex-shrink: 0; }

    /* Meta Info */
    .meta-row {
      display: flex; gap: 16px; font-size: 11px;
      color: var(--muted); margin-top: 8px;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <h1>⚡ Domyh Auto Accept</h1>
    <div class="header-right">
      <span id="cdpBadge" class="badge idle">CDP: —</span>
      <span id="stateBadge" class="badge idle">Idle</span>
    </div>
  </div>

  <!-- Stats Grid -->
  <div class="stats-grid">
    <div class="stat-card">
      <div id="statClicks" class="stat-value">0</div>
      <div class="stat-label">Clicks</div>
    </div>
    <div class="stat-card">
      <div id="statBlocked" class="stat-value" style="color: var(--error)">0</div>
      <div class="stat-label">Blocked</div>
    </div>
    <div class="stat-card">
      <div id="statRetries" class="stat-value" style="color: var(--warning)">0</div>
      <div class="stat-label">Retries</div>
    </div>
    <div class="stat-card">
      <div id="statPrompts" class="stat-value" style="color: var(--success)">0</div>
      <div class="stat-label">Prompts</div>
    </div>
    <div class="stat-card">
      <div id="statTimeSaved" class="stat-value" style="color: var(--accent)">0s</div>
      <div class="stat-label">Time Saved</div>
    </div>
    <div class="stat-card">
      <div id="statUptime" class="stat-value" style="font-size: 18px; color: var(--muted)">—</div>
      <div class="stat-label">Uptime</div>
    </div>
  </div>

  <!-- CDP Status -->
  <div class="section">
    <div class="section-title">🔌 Connection</div>
    <div class="cdp-status">
      <span id="cdpDot" class="cdp-dot"></span>
      <span id="cdpText">Not connected</span>
    </div>
  </div>

  <!-- Queue Panel -->
  <div class="section">
    <div class="section-title">📋 Queue</div>
    <div id="queueInfo" class="queue-info">No queue active</div>
    <div class="progress-bar">
      <div id="queueProgress" class="progress-fill" style="width: 0%"></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" onclick="send('startQueue')">▶ Start</button>
      <button class="btn" onclick="send('pauseQueue')">⏸ Pause</button>
      <button class="btn" onclick="send('resumeQueue')">▶ Resume</button>
      <button class="btn" onclick="send('skipQueue')">⏭ Skip</button>
      <button class="btn" onclick="send('stopQueue')">⏹ Stop</button>
    </div>
  </div>

  <!-- Controls -->
  <div class="section">
    <div class="section-title">⚙ Controls</div>
    <div class="btn-row">
      <button class="btn primary" onclick="send('toggle')">Toggle Engine</button>
      <button class="btn" onclick="send('openSettings')">⚙ Settings</button>
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
    function send(type) { vscode.postMessage({ type }); }

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
      if (!seconds) return '0s';
      if (seconds < 60) return seconds + 's';
      const m = Math.floor(seconds / 60);
      if (m < 60) return m + 'm ' + (seconds % 60) + 's';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    // Update uptime every second
    setInterval(function() {
      if (sessionStart > 0) {
        document.getElementById('statUptime').textContent = formatDuration(Date.now() - sessionStart);
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
          if (data.sessionStartTime) sessionStart = data.sessionStartTime;
          if (data.lastClickTime) lastClickTime = data.lastClickTime;
          break;

        case 'state': {
          var badge = document.getElementById('stateBadge');
          badge.textContent = data;
          badge.className = 'badge ' + (data === 'polling' || data === 'connected' ? 'active' : 'idle');
          addLog('State: ' + data);
          break;
        }

        case 'cdp': {
          var dot = document.getElementById('cdpDot');
          var txt = document.getElementById('cdpText');
          var cdpBadge = document.getElementById('cdpBadge');
          dot.className = 'cdp-dot ' + data.status;
          if (data.status === 'connected') {
            txt.textContent = 'Connected (port ' + data.port + ', ' + data.targets + ' targets)';
            cdpBadge.textContent = 'CDP: ✓'; cdpBadge.className = 'badge active';
          } else if (data.status === 'reconnecting') {
            txt.textContent = 'Reconnecting (#' + data.attempt + ', delay ' + (data.delay/1000) + 's)';
            cdpBadge.textContent = 'CDP: ↻'; cdpBadge.className = 'badge warning';
          } else {
            txt.textContent = 'Disconnected' + (data.reason ? ': ' + data.reason : '');
            cdpBadge.textContent = 'CDP: ✗'; cdpBadge.className = 'badge error';
          }
          addLog('CDP: ' + data.status);
          break;
        }

        case 'activity':
          addLog(data.event);
          break;

        case 'queue': {
          var pct = ((data.index + 1) / data.total * 100).toFixed(0);
          document.getElementById('queueProgress').style.width = pct + '%';
          document.getElementById('queueInfo').textContent =
            'Prompt ' + (data.index + 1) + ' of ' + data.total;
          addLog('Queue: ' + (data.index + 1) + '/' + data.total);
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

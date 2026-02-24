# Domyh Auto Accept

> Production‑ready auto-accept extension for AI coding assistants — supports Antigravity, Cursor, Windsurf, Trae, and VS Code Copilot.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Auto-Accept** | Automatically clicks Accept, Accept All, Keep All, Run, Retry, and Continue buttons in AI panels |
| 🎯 **Cursor Enhanced** | First-class Cursor support: Keep All, terminal Run, web search Continue, error popup handling, MCP tool calls |
| 🛡️ **Dangerous Command Blocking** | Blocks dangerous terminal commands (`rm -rf`, `format C:`, pipe-to-shell, fork bombs, etc.) with 25+ built-in patterns |
| 🔄 **Death Loop Guard** | Detects infinite retry cycles (429, model overloaded, context window full) and pauses with configurable cooldown |
| 📋 **Prompt Scheduler** | 3 modes: Interval, Daily, Queue — with silence detection and consume/loop queue behavior |
| 📊 **Dashboard** | Live WebView dashboard with session stats, CDP status, queue progress, and activity log |
| 📈 **Status Bar Shortcuts** | Click `Auto Accept: ...` to toggle engine, or `$(graph-line) Auto Accept` to open the dashboard instantly |
| 🔌 **Multi-IDE** | Native adapter per IDE with IDE-specific commands, button selectors, and CDP target filtering |
| ⚡ **Smart Focus** | Optional focus-based toggle: auto-accept ON in terminal, OFF in chat |
| 🔍 **CDP Auto-Discovery** | 5-layer cascade: `DevToolsActivePort` → `argv.json` → process scan → IDE-aware port sweep → fallback |
| 📜 **Auto Scroll** | Automatically scrolls chat panel to bottom when new content appears |
| 📜 **Antigravity Scroll** | User scroll detection: pauses auto-scroll/click when user scrolls up or drags scrollbar |
| 🔧 **Probe Buttons** | Diagnostic command to find buttons without clicking (helps debug detection issues) |
| ⚙️ **Runtime Config** | Instant toggle controls without window reload — toggle Run/Proceed/Accept All on the fly |
| 🐕 **Terminal Watchdog (Beta)** | Detects stuck terminal commands and auto-recovers (Enter → Ctrl+C → Kill) with optional **soft mode** (never kill) |
| 🔄 **UI Mismatch Recovery** | Detects when terminal UI shows "Running command" but shell events indicate completion — auto-reloads terminal (opt-in) |

## ⚡ Quick Start

1. Install the `.vsix` extension.
2. Extension auto-starts with your IDE — no configuration needed for most setups.
3. Status bar shows `$(check) Auto Accept` when active, plus a `$(graph-line) Auto Accept` button for the Dashboard.

> **First run & CDP setup**  
> By default, the extension will attempt a one-time CDP setup by patching your IDE's `argv.json` and (where possible) updating user-level shortcuts to add `--remote-debugging-port`. A restart is required.  
> If your environment forbids host file changes, set `"domyh-auto-accept.cdpSetup.mode": "manual"` to disable automatic `argv.json`/shortcut edits and configure CDP manually.

## 🎛️ Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `Domyh Auto Accept: Toggle On/Off` | `Ctrl+Shift+Alt+A` | Enable/disable auto-accept |
| `Domyh Auto Accept: Open Dashboard` | `Ctrl+Shift+Alt+D` | Open live stats dashboard (also available via status bar icon) |
| `Domyh Auto Accept: Probe Buttons` | — | Find buttons without clicking (debug tool) |
| `Domyh Auto Accept: Start Prompt Queue` | — | Start scheduled prompt queue |
| `Domyh Auto Accept: Pause/Resume/Skip/Stop Queue` | — | Control prompt queue |
| `Domyh Auto Accept: Reset Retry Counter` | — | Reset death loop retry counter |
| `Domyh Auto Accept: Re-run CDP Setup` | — | Reconfigure CDP connection |
| `Domyh Auto Accept: Toggle Auto-click Run` | — | Instantly toggle Run button auto-click (no reload) |
| `Domyh Auto Accept: Toggle Auto-click Proceed` | — | Instantly toggle Proceed button auto-click (no reload) |
| `Domyh Auto Accept: Toggle Auto-click Accept All` | — | Instantly toggle Accept All button auto-click (no reload) |
| `Domyh Auto Accept: Pause Terminal Watchdog` | — | Temporarily pause terminal stuck detection |
| `Domyh Auto Accept: Resume Terminal Watchdog` | — | Resume terminal stuck detection |

## ⚙️ Configuration

```jsonc
{
  // Core
  "domyh-auto-accept.enabled": true,
  "domyh-auto-accept.cdpPort": 0,           // 0 = auto-detect (recommended)
  // CDP setup mode: "auto" (patch argv.json + shortcuts where possible) or "manual" (no host changes)
  "domyh-auto-accept.cdpSetup.mode": "auto",
  "domyh-auto-accept.pollFrequency": 800,   // ms (200-5000)
  "domyh-auto-accept.bannedCommands": [],    // Additional blocked patterns (regex)
  "domyh-auto-accept.smartFocus": false,     // Focus-based toggle
  "domyh-auto-accept.autoAllowOutsideWorkspace": false,

  // Death Loop Guard
  "domyh-auto-accept.autoRetry.enabled": true,
  "domyh-auto-accept.autoRetry.maxRetries": 10,
  "domyh-auto-accept.autoRetry.windowSeconds": 300,
  "domyh-auto-accept.autoRetry.cooldownSeconds": 120,

  // Scheduler
  "domyh-auto-accept.schedule.enabled": false,
  "domyh-auto-accept.schedule.mode": "queue",       // interval | daily | queue
  "domyh-auto-accept.schedule.prompts": ["Build the login page", "Add tests"],
  "domyh-auto-accept.schedule.silenceTimeout": 30   // seconds

  // Terminal Watchdog
  "domyh-auto-accept.terminalWatchdog.enabled": true,
  "domyh-auto-accept.terminalWatchdog.defaultTimeout": 60,      // seconds
  "domyh-auto-accept.terminalWatchdog.longTimeout": 180,        // seconds (test/build)
  "domyh-auto-accept.terminalWatchdog.installTimeout": 600,     // seconds (npm install, etc.)
  "domyh-auto-accept.terminalWatchdog.recoveryStrategy": "escalating",  // enter-only | escalating | kill-only
  "domyh-auto-accept.terminalWatchdog.maxRetries": 3,
  "domyh-auto-accept.terminalWatchdog.excludePatterns": [
    "docker", "ssh", "tail -f", "watch",
    "npm run dev", "yarn dev", "pnpm dev",
    "nuxt dev", "next dev", "vite dev"
  ],
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.enabled": false,  // opt-in
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.quickEndMs": 2000,
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.graceMs": 8000
}
```

## 🖥️ Supported IDEs

| IDE | Default CDP Port | CDP Targets | Accept Commands | Special Features |
|-----|:---:|---|---|----------------|
| **Antigravity** | 9004 | page + webview + iframe | `antigravity.accept`, `antigravity.acceptAll`, `chatEditing.acceptAllFiles` | **Full iframe**, **User scroll detection** |
| **Cursor** | 9222 | page + webview + iframe | `cursorAccept`, `cursor.acceptDiff`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` | **Keep All**, **Run terminal**, **Web search Continue**, **Error popup**, **MCP tool calls** |
| **Windsurf** | 9224 | page + webview + iframe | `windsurf.accept`, `windsurf.acceptAll`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` | — |
| **Trae** | 9005 | page + webview + iframe | `trae.accept`, `trae.acceptAll`, `trae.builder.continue`, `chatEditing.acceptAllFiles` | — |
| **VS Code (Copilot)** | 9229 | page + webview + iframe | `github.copilot.acceptSuggestion`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` | — |

> **Note**: Set `cdpPort` to `0` (default) for auto-detection. The extension reads `DevToolsActivePort` first, so the port numbers above are only used as fallback when auto-detection is unavailable.

### 🎯 Cursor-Specific Features

- **Keep All Button**: Automatically clicks "Keep All" in composer panel
- **Run Terminal Commands**: Auto-clicks "Run" button for terminal tool calls with dangerous command safety
- **Web Search Continue**: Auto-clicks "Continue" when Cursor prompts to search the web
- **Error Popup Handling**: Automatically closes error popups (usage limit, network errors) and resends messages
- **MCP Tool Calls**: Supports MCP (Model Context Protocol) tool calls with safe auto-run
- **Dropdown Protection**: Prevents clicking dropdown buttons (e.g., "Use Allowlist", "Ask Every Time")

### 📜 Antigravity Scroll Support

- **User Scroll Detection**: Pauses auto-scroll and auto-click when user scrolls (wheel, scrollbar drag)
- **Chat Scrolled Up**: Does not auto-scroll/click when chat is scrolled up (user reading history)
- **Multi-Window**: Scroll detection works in chat panel iframe

## 🐕 Terminal Watchdog (Beta)

The Terminal Watchdog monitors terminal shell executions and automatically recovers from stuck commands, which is especially useful when AI agents run terminal commands that hang due to ConPTY/stdin issues on Windows.

### How It Works

1. **Command Tracking**: Monitors all terminal commands via `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`
2. **Timeout Detection**: Checks every 5 seconds for commands exceeding their timeout:
   - **Normal commands**: 60s default
   - **Test/Build commands**: 180s (e.g., `go test`, `npm run build`)
   - **Install commands**: 600s (e.g., `npm install`, `pip install`)
3. **Escalating Recovery**: When stuck command detected:
   - **Stage 1**: Send Enter (unstick stdin)
   - **Stage 2**: Send Ctrl+C (cancel command)
   - **Stage 3**: Kill terminal + notify user
4. **Ephemeral Commands**: Automatically ignores short-lived commands (`cd`, `ls`, `dir`, `pwd`, `cls`, `clear`)
5. **Exclude Patterns**: Long-running commands are excluded (dev servers, `docker`, `ssh`, `tail -f`, etc.)
6. **Optional AWF Integration**: Can be combined with the domyh‑awf system ([github.com/nockasdd/domyh-awf-code](https://github.com/nockasdd/domyh-awf-code)) to improve performance. In this extension it focuses on reducing terminal hangs; when a hang is detected, it can reload the terminal kernel.
### UI Mismatch Recovery (Opt-in)

When enabled, the watchdog can detect cases where:
- A long-running command (e.g., `go test`) ends very quickly (<2s)
- But the IDE UI still shows "Running command..." card with Cancel button
- This indicates a potential UI/terminal state mismatch

**Recovery Flow**:
1. Engine detects "Running command" card persists for 5+ consecutive polls
2. Watchdog waits grace period (8s default) for new command events
3. If no new command starts, watchdog reloads the terminal to clear stuck UI state

**Configuration**:
```jsonc
{
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.enabled": false,  // opt-in
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.quickEndMs": 2000,  // threshold
  "domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.graceMs": 8000     // grace period
}
```

> **Note**: UI mismatch recovery is **disabled by default** to avoid aggressive terminal reloads. Enable only if you experience terminal UI getting stuck after commands complete.

### Runtime Controls

- **Pause Watchdog**: Temporarily disable monitoring (useful during manual terminal work)
- **Resume Watchdog**: Re-enable monitoring
- Commands: `Domyh Auto Accept: Pause/Resume Terminal Watchdog`

## ⚙️ Runtime Configuration

The extension supports **instant runtime toggles** without requiring a window reload. Configuration changes are pushed to the injected payload script via CDP, allowing immediate effect.

### Runtime Toggle Commands

- `Domyh Auto Accept: Toggle Auto-click Run` — Instantly enable/disable Run button auto-click
- `Domyh Auto Accept: Toggle Auto-click Proceed` — Instantly enable/disable Proceed button auto-click
- `Domyh Auto Accept: Toggle Auto-click Accept All` — Instantly enable/disable Accept All button auto-click

### How It Works

1. **RuntimeConfigService**: Manages in-memory configuration state
2. **CDP Push**: Engine pushes updated config to all connected CDP targets
3. **Payload Script**: Reads config from `window.__autoAcceptConfig` on each poll
4. **Instant Effect**: Changes apply immediately without reload

This allows fine-grained control over which buttons are auto-clicked without restarting the extension.

## 🔒 Safety

- **25+ built-in banned patterns** — blocks `rm -rf /`, `format C:`, fork bombs, pipe-to-shell, database drops, git force push, etc.
- **Custom patterns** — add your own via `bannedCommands` setting (regex)
- **Death Loop Guard** — detects infinite retry cycles and auto-pauses with configurable cooldown
- **Context window full** — automatically skips retry to prevent loops
- **Outside workspace** — permission auto-allow gated behind explicit config
- **Command text validation** — parses terminal commands before auto-running to ensure safety
- **MCP tool call safety** — allows MCP tool calls (safe) while blocking dangerous terminal commands
- **Terminal Watchdog** — prevents terminal hangs from blocking AI agent workflows

## 🐛 Troubleshooting

### Buttons Not Being Clicked

1. **Check CDP Connection**: Open Dashboard (`Ctrl+Shift+Alt+D`) and verify CDP status is "Connected"
2. **Probe Buttons**: Run `Domyh Auto Accept: Probe Buttons` command to see what buttons are detected
3. **Check Logs**: Open Output panel → Select "Domyh Auto Accept" to see detailed logs
4. **Verify IDE Support**: Ensure your IDE is in the supported list above
5. **Check Runtime Config**: Verify runtime toggles are enabled (Run/Proceed/Accept All)

### Cursor-Specific Issues

- **Run Button Not Clicked**: Check if command text is being extracted correctly (see logs)
- **Keep All Not Found**: Ensure composer panel is visible and not in iframe
- **Error Popups**: Extension should auto-handle, but if stuck, manually close and retry

### CDP Connection Issues

1. **Re-run CDP Setup**: Use `Domyh Auto Accept: Re-run CDP Setup` command
2. **Check Port**: Verify `cdpPort` setting (0 = auto-detect recommended)
3. **Restart IDE**: After CDP setup, restart IDE is required

### Terminal Watchdog Issues

- **False Positives**: Adjust timeout values or add commands to `excludePatterns`
- **Watchdog Too Aggressive**: Use `recoveryStrategy: "enter-only"` or enable `"domyh-auto-accept.terminalWatchdog.softMode": true` to never kill terminals (only Enter/Ctrl+C)
- **Terminal Reloads Too Often**: Disable `uiMismatchRecovery.enabled` if not needed
- **Commands Not Tracked**: Check logs for "Ignoring ephemeral command" or "Skipping excluded command"

If a specific long-running command (e.g., a custom CI task) is being killed and you want to opt it out of monitoring entirely, add a substring of that command to `excludePatterns`. For example:

```jsonc
{
  "domyh-auto-accept.terminalWatchdog.excludePatterns": [
    "docker compose up",
    "my-custom-long-task"
  ]
}
```

## 📊 Architecture

### Core Components

- **AutoAcceptEngine**: Main orchestrator — dual approach (Commands API + CDP)
- **CDPConnector**: Chrome DevTools Protocol connection manager
- **IDEAdapter**: Per-IDE adapter with commands, selectors, and target filtering
- **PayloadManager**: Manages injected JavaScript payloads
- **RuntimeConfigService**: Runtime configuration state management
- **TerminalWatchdog**: Terminal stuck command detection and recovery
- **DeathLoopGuard**: Infinite retry cycle detection
- **Scheduler**: Prompt scheduling (interval/daily/queue)

### Data Flow

1. **Engine** polls every 800ms (adaptive: slows to 2000ms when idle)
2. **Commands API** tried first (fast path, no CDP needed)
3. **CDP Payload** injected if Commands API fails or for complex UI detection
4. **Payload Script** (`auto-accept.js`) runs in browser context, detects buttons, clicks safely
5. **Runtime Config** pushed via CDP for instant toggles
6. **Watchdog** monitors terminal events separately, triggers recovery when needed

## 📝 License

MIT © NockDev

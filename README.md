# Domyh Auto Accept

> Professional auto-accept extension for AI coding assistants — supports Antigravity, Cursor, Windsurf, Trae, and VS Code Copilot.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Auto-Accept** | Automatically clicks Accept, Accept All, Run, Retry, and Continue buttons in AI panels |
| 🛡️ **Dangerous Command Blocking** | Blocks dangerous terminal commands (`rm -rf`, `format C:`, pipe-to-shell, fork bombs, etc.) |
| 🔄 **Death Loop Guard** | Detects infinite retry cycles (429, model overloaded, context window full) and pauses with configurable cooldown |
| 📋 **Prompt Scheduler** | 3 modes: Interval, Daily, Queue — with silence detection and consume/loop queue behavior |
| 📊 **Dashboard** | Live WebView dashboard with session stats, CDP status, queue progress, and activity log |
| 🔌 **Multi-IDE** | Native adapter per IDE with IDE-specific commands, button selectors, and CDP target filtering |
| ⚡ **Smart Focus** | Optional focus-based toggle: auto-accept ON in terminal, OFF in chat |
| 🔍 **CDP Auto-Discovery** | 5-layer cascade: `DevToolsActivePort` → `argv.json` → process scan → port sweep → fallback |
| 📜 **Auto Scroll** | Automatically scrolls chat panel to bottom when new content appears |

## ⚡ Quick Start

1. Install the `.vsix` extension
2. Extension auto-starts with your IDE — no configuration needed
3. Status bar shows `$(check) Auto Accept` when active

> **First run**: The extension patches `argv.json` with `"remote-debugging-port": 0` and prompts a restart. After restart, CDP is permanently enabled.

## 🎛️ Commands

| Command | Keybinding |
|---------|------------|
| `Domyh Auto Accept: Toggle On/Off` | `Ctrl+Shift+Alt+A` |
| `Domyh Auto Accept: Open Dashboard` | `Ctrl+Shift+Alt+D` |
| `Domyh Auto Accept: Start Prompt Queue` | — |
| `Domyh Auto Accept: Pause/Resume/Skip/Stop Queue` | — |
| `Domyh Auto Accept: Reset Retry Counter` | — |

## ⚙️ Configuration

```jsonc
{
  // Core
  "domyh-auto-accept.enabled": true,
  "domyh-auto-accept.cdpPort": 0,           // 0 = auto-detect (recommended)
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
}
```

## 🖥️ Supported IDEs

| IDE | Default CDP Port | CDP Targets | Accept Commands |
|-----|:---:|---|---|
| Antigravity | 9004 | page + webview + iframe | `antigravity.accept`, `antigravity.acceptAll`, `chatEditing.acceptAllFiles` |
| Cursor | 9222 | page + webview + iframe | `cursorAccept`, `cursor.acceptDiff`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` |
| Windsurf | 9224 | page + webview + iframe | `windsurf.accept`, `windsurf.acceptAll`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` |
| Trae | 9005 | page + webview + iframe | `trae.accept`, `trae.acceptAll`, `trae.builder.continue`, `chatEditing.acceptAllFiles` |
| VS Code (Copilot) | 9229 | page + webview + iframe | `github.copilot.acceptSuggestion`, `chatEditing.acceptAllFiles`, `chatEditing.acceptFile` |

> **Note**: Set `cdpPort` to `0` (default) for auto-detection. The extension reads `DevToolsActivePort` first, so the port numbers above are only used as fallback when auto-detection is unavailable.

## 🔒 Safety

- **14 built-in banned patterns** — blocks `rm -rf /`, `format C:`, fork bombs, pipe-to-shell, etc.
- **Custom patterns** — add your own via `bannedCommands` setting (regex)
- **Death Loop Guard** — detects infinite retry cycles and auto-pauses
- **Context window full** — automatically skips retry to prevent loops
- **Outside workspace** — permission auto-allow gated behind explicit config

## License

MIT © NockDev

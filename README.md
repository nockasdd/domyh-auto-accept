# Domyh Auto Accept

> Professional auto-accept extension for AI coding assistants — supports Antigravity, Cursor, Windsurf, Trae, and VS Code Copilot.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🤖 **Auto-Accept** | Automatically clicks Accept, Accept All, Keep All, Run, Retry, and Continue buttons in AI panels |
| 🎯 **Cursor Enhanced** | Full support for Cursor IDE: Keep All, Run terminal, web search Continue, error popup handling, MCP tool calls |
| 🛡️ **Dangerous Command Blocking** | Blocks dangerous terminal commands (`rm -rf`, `format C:`, pipe-to-shell, fork bombs, etc.) with 25+ built-in patterns |
| 🔄 **Death Loop Guard** | Detects infinite retry cycles (429, model overloaded, context window full) and pauses with configurable cooldown |
| 📋 **Prompt Scheduler** | 3 modes: Interval, Daily, Queue — with silence detection and consume/loop queue behavior |
| 📊 **Dashboard** | Live WebView dashboard with session stats, CDP status, queue progress, and activity log |
| 🔌 **Multi-IDE** | Native adapter per IDE with IDE-specific commands, button selectors, and CDP target filtering |
| ⚡ **Smart Focus** | Optional focus-based toggle: auto-accept ON in terminal, OFF in chat |
| 🔍 **CDP Auto-Discovery** | 5-layer cascade: `DevToolsActivePort` → `argv.json` → process scan → port sweep → fallback |
| 📜 **Auto Scroll** | Automatically scrolls chat panel to bottom when new content appears |
| 📜 **Antigravity Scroll** | User scroll detection: pauses auto-scroll/click when user scrolls up or drags scrollbar |
| 🔧 **Probe Buttons** | Diagnostic command to find buttons without clicking (helps debug detection issues) |

## ⚡ Quick Start

1. Install the `.vsix` extension
2. Extension auto-starts with your IDE — no configuration needed
3. Status bar shows `$(check) Auto Accept` when active

> **First run**: The extension patches `argv.json` with `"remote-debugging-port": 0` and prompts a restart. After restart, CDP is permanently enabled.

## 🎛️ Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `Domyh Auto Accept: Toggle On/Off` | `Ctrl+Shift+Alt+A` | Enable/disable auto-accept |
| `Domyh Auto Accept: Open Dashboard` | `Ctrl+Shift+Alt+D` | Open live stats dashboard |
| `Domyh Auto Accept: Probe Buttons` | — | Find buttons without clicking (debug tool) |
| `Domyh Auto Accept: Start Prompt Queue` | — | Start scheduled prompt queue |
| `Domyh Auto Accept: Pause/Resume/Skip/Stop Queue` | — | Control prompt queue |
| `Domyh Auto Accept: Reset Retry Counter` | — | Reset death loop retry counter |
| `Domyh Auto Accept: Re-run CDP Setup` | — | Reconfigure CDP connection |

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

## 🔒 Safety

- **25+ built-in banned patterns** — blocks `rm -rf /`, `format C:`, fork bombs, pipe-to-shell, database drops, git force push, etc.
- **Custom patterns** — add your own via `bannedCommands` setting (regex)
- **Death Loop Guard** — detects infinite retry cycles and auto-pauses with configurable cooldown
- **Context window full** — automatically skips retry to prevent loops
- **Outside workspace** — permission auto-allow gated behind explicit config
- **Command text validation** — parses terminal commands before auto-running to ensure safety
- **MCP tool call safety** — allows MCP tool calls (safe) while blocking dangerous terminal commands

## 🐛 Troubleshooting

### Buttons Not Being Clicked

1. **Check CDP Connection**: Open Dashboard (`Ctrl+Shift+Alt+D`) and verify CDP status is "Connected"
2. **Probe Buttons**: Run `Domyh Auto Accept: Probe Buttons` command to see what buttons are detected
3. **Check Logs**: Open Output panel → Select "Domyh Auto Accept" to see detailed logs
4. **Verify IDE Support**: Ensure your IDE is in the supported list above

### Cursor-Specific Issues

- **Run Button Not Clicked**: Check if command text is being extracted correctly (see logs)
- **Keep All Not Found**: Ensure composer panel is visible and not in iframe
- **Error Popups**: Extension should auto-handle, but if stuck, manually close and retry

### CDP Connection Issues

1. **Re-run CDP Setup**: Use `Domyh Auto Accept: Re-run CDP Setup` command
2. **Check Port**: Verify `cdpPort` setting (0 = auto-detect recommended)
3. **Restart IDE**: After CDP setup, restart IDE is required

## License

MIT © NockDev

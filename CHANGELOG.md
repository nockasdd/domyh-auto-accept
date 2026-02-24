# Changelog

## [1.0.7] — 2026-02-24

### ✨ UX & Logic Refinements

- **IDE-Aware CDP Detection** — Strengthened CDP port discovery so the extension only attaches to the correct IDE:
  - `DevToolsActivePort` and `--remote-debugging-port` are now validated with **IDE-aware probes**.
  - Rejects ports where all workbench pages clearly belong to a different IDE (e.g. attaching to Chrome instead of Cursor).
  - Requires at least one workbench page whose title matches the current IDE (e.g. Cursor) before accepting a port.
- **Antigravity / Cursor JS Payload Allowances** — Internal tuning of CDP target detection and payload injection so that:
  - Antigravity and Cursor JS payloads are allowed to attach only to the correct workbench and webviews.
  - Reduces the risk of accidentally scanning unrelated browser tabs or external Chrome instances.
- **Dashboard Icon & Status Bar Entry** — Added a dedicated monochrome icon and quick access entry:
  - New `icon-mono.svg` used in the Dashboard header for a clean, production-ready look.
  - New status bar item `$(graph-line) Auto Accept` opens the Dashboard in one click.
- **CDP Status in Dashboard** — Dashboard now shows live CDP connection state:
  - `cdp:connected` with port and target count, `cdp:reconnecting` with attempt/delay, and `cdp:disconnected` reasons.
  - Helps diagnose CDP issues (e.g., port conflicts) directly from the UI.
- **Soft Watchdog Improvements (Follow-up)** — Polished messaging around soft mode and exclude patterns in README:
  - Clear examples for adding long-running commands to `terminalWatchdog.excludePatterns`.
  - Explicit documentation for `"domyh-auto-accept.terminalWatchdog.softMode": true` as a safe, non‑killing mode.

---

## [1.0.6] — 2026-02-24

### 🐕 Terminal Watchdog — Beta Hardening

- **Soft Mode (Never Kill Terminals)** — Added a conservative mode for sensitive environments:
  - New setting: `"domyh-auto-accept.terminalWatchdog.softMode": true`.
  - In soft mode, the watchdog uses **Enter → Ctrl+C** only and **never calls `killTerminal`**.
  - Keeps protection against stuck stdin while avoiding disruptive terminal kills.
- **Pre-Kill Safety Hint** — When the watchdog does kill a terminal in escalating mode:
  - Logs a clear warning with the offending command.
  - Shows a user message explaining how to add a substring of the command to `terminalWatchdog.excludePatterns`.
  - Makes it easy to whitelist legitimate long-running tasks (e.g. custom CI commands).
- **Config & Type Refinements** — Updated configuration types and readers:
  - Extended `WatchdogConfig` with `softMode` and wired it through `ConfigReader`.
  - Ensured status bar and Dashboard reflect watchdog runtime enabled/paused state accurately.
- **Internal Logic Clean-Up** — Minor logic and typings improvements to keep the engine and watchdog code easier to maintain.

---

## [1.0.5] — 2026-02-24

### 🐕 Terminal Watchdog (Beta Test)

- **Terminal Stuck Detection** — Monitors terminal shell executions and automatically recovers from stuck commands
  - Tracks commands via `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` events
  - Detects commands exceeding timeout (60s default, 180s for test/build, 600s for install)
  - Escalating recovery strategy: Enter → Ctrl+C → Kill terminal
  - Configurable recovery strategies: `enter-only`, `escalating`, `kill-only`
- **Command Classification** — Smart timeout selection based on command type
  - Normal commands: 60s timeout
  - Test/Build commands (`go test`, `npm run build`): 180s timeout
  - Install commands (`npm install`, `pip install`): 600s timeout
- **Ephemeral Command Filtering** — Automatically ignores short-lived commands
  - Filters: `cd`, `chdir`, `pwd`, `ls`, `dir`, `cls`, `clear`
  - Reduces log noise and false positives
- **Exclude Patterns** — Configurable list of long-running commands to exclude
  - Default excludes: `docker`, `ssh`, `tail -f`, `watch`, dev servers (`npm run dev`, `yarn dev`, etc.)
  - Prevents false positives for intentionally long-running commands
- **User Interaction Safety** — Respects manual terminal interaction
  - Skips first recovery attempt if user has interacted with terminal
  - Prevents interference with manual work
- **Runtime Controls** — Pause/resume watchdog without restarting extension
  - Commands: `Domyh Auto Accept: Pause/Resume Terminal Watchdog`
  - Useful during manual terminal work

### 🔄 UI Mismatch Recovery (Opt-in)

- **UI/Terminal State Mismatch Detection** — Detects when terminal UI shows "Running command" but shell events indicate completion
  - Engine tracks "Running command" cards via CDP payload detector
  - Triggers recovery when mismatch persists for 5+ consecutive polls
  - Grace period (8s default) allows new command events to arrive before recovery
- **Automatic Terminal Reload** — Reloads terminal when UI mismatch is confirmed
  - Only triggers if no new command starts during grace period
  - Respects user interaction (skips if terminal is interacted with)
  - Disabled by default (opt-in via `terminalWatchdog.uiMismatchRecovery.enabled`)
- **Fast-End Warning** — Logs warning when long-running commands end unusually fast
  - Detects commands like `go test`, `npm run build` ending in <2s
  - Indicates potential early failure or UI mismatch

### ⚙️ Runtime Configuration Service

- **Instant Toggle Support** — Runtime configuration changes without window reload
  - `RuntimeConfigService` manages in-memory configuration state
  - Engine pushes updated config to all CDP targets via `window.__autoAcceptConfig`
  - Payload script reads config dynamically on each poll
- **Runtime Toggle Commands** — New commands for instant feature toggles
  - `Domyh Auto Accept: Toggle Auto-click Run` — Instantly enable/disable Run button auto-click
  - `Domyh Auto Accept: Toggle Auto-click Proceed` — Instantly enable/disable Proceed button auto-click
  - `Domyh Auto Accept: Toggle Auto-click Accept All` — Instantly enable/disable Accept All button auto-click
- **Config Change Events** — Automatic config reload when VS Code settings change
  - `RuntimeConfigService` listens to `config.onDidChange` events
  - Emits `runtimeConfig:changed` event for engine to push updates
  - Seamless integration with existing settings UI

### 🔍 Engine-Watchdog Integration

- **UI Mismatch Telemetry** — Engine tracks "Running command" cards from payload
  - Payload detector (`detectRunningCommandCards()`) finds "Running command" UI cards
  - Engine tracks consecutive polls with UI mismatch
  - Triggers watchdog recovery when threshold (5 polls) exceeded
- **Watchdog Public API** — `triggerUIMismatchRecovery()` method for external triggers
  - Engine can trigger recovery when UI mismatch detected
  - Supports single terminal or all tracked terminals
  - Respects watchdog runtime enabled state

### 🐛 Bug Fixes

- **Fixed Infinite Skip Bug** — Watchdog now correctly handles user interaction skip logic
  - `skippedDueToInteraction` flag ensures only first recovery is skipped
  - Prevents infinite skipping that could prevent recovery
- **Improved Command End Detection** — Better handling of fast-ending commands
  - Captures exit code from `TerminalShellExecutionEndEvent`
  - Logs exit code for debugging
  - Warns when long-running commands end unusually fast

### 📝 Configuration

- **New Settings**:
  - `domyh-auto-accept.terminalWatchdog.enabled` — Enable/disable watchdog (default: `true`)
  - `domyh-auto-accept.terminalWatchdog.defaultTimeout` — Default timeout in seconds (default: `60`)
  - `domyh-auto-accept.terminalWatchdog.longTimeout` — Timeout for test/build commands (default: `180`)
  - `domyh-auto-accept.terminalWatchdog.installTimeout` — Timeout for install commands (default: `600`)
  - `domyh-auto-accept.terminalWatchdog.recoveryStrategy` — Recovery strategy (default: `"escalating"`)
  - `domyh-auto-accept.terminalWatchdog.maxRetries` — Max recovery attempts (default: `3`)
  - `domyh-auto-accept.terminalWatchdog.excludePatterns` — Commands to exclude from monitoring
  - `domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.enabled` — Enable UI mismatch recovery (default: `false`)
  - `domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.quickEndMs` — Quick-end threshold (default: `2000`)
  - `domyh-auto-accept.terminalWatchdog.uiMismatchRecovery.graceMs` — Grace period before recovery (default: `8000`)

### 🔧 Technical Improvements

- **Payload Script Enhancement** — Added `detectRunningCommandCards()` function
  - Detects "Running command" cards with Cancel button
  - Returns telemetry (`uiRunningCommand`, `uiRunningCommandCount`) to engine
  - Helps identify UI/terminal state mismatches
- **Engine State Tracking** — Added `consecutiveUIRunningCommandCount` tracking
  - Tracks consecutive polls with UI mismatch
  - Resets when mismatch clears
  - Triggers recovery at threshold (5 polls)
- **Watchdog Architecture** — Clean separation of concerns
  - `TerminalWatchdog` handles terminal event monitoring
  - `AutoAcceptEngine` handles UI detection via CDP
  - Integration via public API (`triggerUIMismatchRecovery()`)

---

## [1.0.3] — 2026-02-23

### Antigravity 1.18.4 Compatibility

- **Main-Document Chat Support** — Updated Antigravity adapter for the new chat layout (no iframe)
  - Detects `#conversation` inside `div.antigravity-agent-side-panel` on the main workbench page
  - Reuses the same scroll protection and bottom-button logic as the old iframe chat panel
  - Only auto-scrolls when user is not actively scrolling and chat is near the bottom
- **Scroll-To-Bottom Button Handling** — Automatically clicks the floating "Scroll to bottom" button when safe
  - Prefers scrolling the outer chat scrollbar to bottom first
  - Falls back to clicking the `aria-label="Scroll to bottom"` button if still not at bottom
- **Run Command Card Auto-Run** — Supports new Antigravity "Run command?" confirmation cards in the main document
  - Detects the "Run" button inside cards with header text containing "Run command?"
  - Applies the same dangerous command safety gate as Cursor before auto-running
- **Accept All in Agent Header** — Auto-clicks "Accept all" in the "1 File With Changes" header
  - Locates `span` with text "Accept all" near text "File With Changes"
  - Respects forbidden zones and clickability checks to avoid mis-clicks

> Tested with **Antigravity Version: 1.18.4**

---

## [1.0.2] — 2026-02-23

### Enhanced Cursor Support

- **Improved "Keep All" Button Detection** — Enhanced detection for Cursor's "Keep All" button in composer panel
- **Fixed "Run" Button Auto-Click** — Resolved issues with terminal "Run" button not being clicked automatically
  - Improved command text extraction from Monaco editor (handles multi-line commands, PowerShell prefixes)
  - Enhanced container detection (searches up to 30 levels, checks siblings and grandparents)
  - Better handling of MCP tool calls (allows even without command text)
  - Fixed text normalization (removes special characters like ⏎, ⇧, ⌘, etc.)
  - Improved `isInsideForbiddenZone` logic to allow composer Run buttons even in auxiliary bar
- **Web Search Confirmation Dialog** — Auto-clicks "Continue" when Cursor prompts to search the web
  - Detects `.composer-tool-former-message` with "Confirm search" / "Auto-search web"
  - Clicks Continue (primary button) instead of Cancel
- **Error Popup Auto-Handling** — Automatically handles Cursor error popups (usage limit, network errors)
  - Auto-closes error popups
  - Auto-focuses chat editor to show Send button
  - Auto-clicks Send button to resend message
  - Retry logic with cooldown and max retries protection
- **Dropdown Button Protection** — Prevents clicking dropdown buttons (e.g., "Use Allowlist", "Ask Every Time")
  - Added reject words for dropdown buttons
  - Improved `isAcceptButton` logic to skip dropdown buttons
- **Probe Buttons Command** — New diagnostic command to find buttons without clicking
  - Command: `domyh-auto-accept.probeButtons`
  - Shows detailed button detection report
  - Helps debug button detection issues

### Antigravity Scroll Support

- **User Scroll Detection** — Prevents auto-scroll and auto-click when user is manually scrolling
  - Detects mouse wheel events (wheel)
  - Detects scrollbar drag (mousedown + mousemove on scrollbar area)
  - Detects scroll position changes while mouse is down
  - Cooldown period after user scroll before resuming auto-actions
- **Chat Scrolled Up Detection** — Blocks auto-scroll/click when chat is scrolled up
  - Uses `isChatScrolledUp()` to check if chat container is away from bottom (>80px)
  - Prevents interrupting users reading previous messages
- **Multi-Window Scroll State** — Scroll detection works in both main window and iframe
  - Initializes scroll listeners per window (main + iframes)
  - Ensures Antigravity chat panel iframe has its own scroll state

### Dashboard Improvements

- **Fixed Time Saved Formatting** — Corrected calculation for remaining seconds/minutes in time saved display
- **Improved Uptime Display** — Shows "—" when session hasn't started yet
- **Fixed Queue Progress** — Prevents division by zero errors when queue total is 0
- **Better Session Start Time Handling** — Validates session start time before using it
- **Enhanced Stats Display** — All stats now update correctly in real-time

### Bug Fixes

- Fixed `formatTimeSaved()` calculation bug (incorrect remaining seconds/minutes)
- Fixed queue progress calculation when `total = 0`
- Fixed unused variables in engine.ts (removed `targetLog` and `scanSummary`)
- Improved `sessionStartTime` validation in Dashboard
- Enhanced error handling in command text extraction

### Technical Improvements

- Unified Run button safety check logic using `shouldAllowRunButton()` helper
- Improved Monaco editor text extraction (handles multiple `.view-line` elements)
- Better container detection for composer tool calls (wider search radius)
- Enhanced MCP tool call detection and handling
- Improved text normalization (removes keyboard shortcut symbols and patterns)
- Scroll detection debounce to avoid false positives from programmatic scrolls
- Outer scrollbar auto-scroll for Antigravity chat (scrolls main container to bottom)

### Features

- Initial Cursor support with basic button detection
- Terminal Run button detection (initial implementation)

---

## [1.0.0] — 2026-02-17

### Features

- **Auto-Accept Engine** — Automatically clicks Accept, Run, Retry, Continue, and Apply buttons in AI panels
- **5 IDE Support** — Antigravity, Cursor, Windsurf, Trae, VS Code Copilot with auto-detection
- **Dangerous Command Blocking** — 14 built-in patterns (`rm -rf`, `format C:`, fork bombs, `curl | sh`, etc.) + custom regex
- **Auto-Run Terminal Commands** — Terminal "Run" buttons auto-clicked with dangerous command safety filter (25+ patterns)
- **Death Loop Guard** — Detects infinite retry cycles (429, model overloaded) with configurable cooldown
- **Prompt Scheduler** — 3 modes: Interval, Daily, Queue with silence detection
- **Smart Focus** — Optional focus-based toggle (active in terminal, paused in chat)
- **Dashboard** — Live WebView with session stats, queue progress, and activity log
- **Status Bar** — Click-to-toggle with real-time state (Active / Stopped / CDP Error / Death Loop)
- **Auto Scroll** — Automatically scrolls chat to bottom when new content appears
- **CDP Auto-Discovery** — Zero-config: auto-patches `argv.json` with `port: 0`, reads `DevToolsActivePort`
- **CI/CD Pipeline** — GitHub Actions for type check, lint, test, and build

### Technical Highlights

- Chat panel iframe traversal for button discovery
- Shadow DOM piercing for nested button detection
- Strict word-boundary matching (prevents false positives on code/prose content)
- Forbidden zone protection (status bar, explorer, activity bar, notifications)
- Adaptive polling (800ms → 2000ms after idle, auto-speedup on activity)

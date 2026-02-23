# Changelog

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

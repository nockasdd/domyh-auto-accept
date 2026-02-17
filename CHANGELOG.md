# Changelog

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

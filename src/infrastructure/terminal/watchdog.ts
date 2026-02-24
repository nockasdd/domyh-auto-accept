import * as vscode from 'vscode';
import { CmdTracker, WatchdogConfig } from '../../domain/types/terminal';
import { Logger } from '../../core/logger';
import { IEventBus } from '../../domain/interfaces/event-bus';

/**
 * TerminalWatchdog
 *
 * Monitors terminal shell executions and attempts to recover when commands
 * appear stuck (e.g., ConPTY/Git Bash stdin race on Windows).
 *
 * MVP behavior:
 * - Track commands via onDidStartTerminalShellExecution / onDidEndTerminalShellExecution
 * - Periodically check for commands exceeding their timeout
 * - Apply escalating recovery:
 *   1) Enter
 *   2) Ctrl+C
 *   3) Kill terminal + notify
 */
export class TerminalWatchdog implements vscode.Disposable {
  private readonly trackers = new Map<vscode.Terminal, CmdTracker>();
  private readonly pendingUiMismatchResets = new Map<vscode.Terminal, NodeJS.Timeout>();
  private checkInterval: NodeJS.Timeout | null = null;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;
  private runtimeEnabled = true;

  // Wait between recovery stages before re-evaluating (ms)
  private static readonly RECOVERY_WAIT_MS = 5000;
  private static readonly EPHEMERAL_COMMAND_PATTERNS: RegExp[] = [
    /^\s*cd(\s+.+)?\s*$/i,
    /^\s*chdir(\s+.+)?\s*$/i,
    /^\s*(pwd|ls|dir|cls|clear)\s*$/i,
    // Common instant, non-long-running shell commands
    /^\s*echo(\s+.+)?\s*$/i,
    /^\s*export(\s+.+)?\s*$/i,
    /^\s*set(\s+.+)?\s*$/i,
    /^\s*alias(\s+.+)?\s*$/i,
  ];

  private static readonly QUICK_LONG_RUNNING_PATTERNS: RegExp[] = [
    /\bnuxt\s+build\b/i,
    /\bnext\s+build\b/i,
    /\breact-scripts\s+build\b/i,
    /\bnpm\s+run\s+build\b/i,
    /\byarn\s+build\b/i,
    /\bpnpm\s+build\b/i,
  ];

  constructor(
    private readonly config: WatchdogConfig,
    private readonly logger: Logger,
    private readonly eventBus?: IEventBus,
  ) { }

  start(): void {
    if (!this.config.enabled) {
      this.logger.debug('[Watchdog] Disabled via configuration — not starting');
      return;
    }

    this.logger.info('[Watchdog] Starting terminal watchdog');

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((e) => this.onCommandStart(e)),
      vscode.window.onDidEndTerminalShellExecution((e) => this.onCommandEnd(e)),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.trackers.delete(terminal);
        this.clearPendingUiMismatchReset(terminal);
      }),
    );

    this.checkInterval = setInterval(() => {
      try {
        this.checkAllTerminals();
      } catch (err) {
        this.logger.error('[Watchdog] checkAllTerminals failed', err);
      }
    }, 5000);
  }

  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // ignore
      }
    }
    this.disposables = [];
    this.trackers.clear();
    for (const timer of this.pendingUiMismatchResets.values()) {
      clearTimeout(timer);
    }
    this.pendingUiMismatchResets.clear();
    this.logger.info('[Watchdog] Stopped terminal watchdog');
  }

  /**
   * Runtime pause/resume controls.
   * These do NOT change the persisted VS Code settings, only in-memory behavior.
   */
  pauseRuntime(): void {
    if (!this.runtimeEnabled) return;
    this.runtimeEnabled = false;
    this.logger.info('[Watchdog] Runtime pause — will ignore new/stuck commands until resumed');
  }

  resumeRuntime(): void {
    if (this.runtimeEnabled) return;
    this.runtimeEnabled = true;
    this.logger.info('[Watchdog] Runtime resume — monitoring re-enabled');
  }

  isRuntimeEnabled(): boolean {
    return this.runtimeEnabled && this.config.enabled;
  }

  /**
   * Public method to trigger UI mismatch recovery from external sources (e.g., engine).
   * Reloads the specified terminal, or all tracked terminals if none specified.
   */
  triggerUIMismatchRecovery(terminal?: vscode.Terminal): void {
    if (!this.isRuntimeEnabled()) {
      this.logger.debug('[Watchdog] UI mismatch recovery skipped — watchdog disabled');
      return;
    }

    if (!terminal) {
      // Safety: do not ever reload all terminals from a generic trigger.
      this.logger.debug('[Watchdog] UI mismatch recovery called without terminal — ignoring to avoid reloading healthy terminals');
      return;
    }

    // Prefer a gentle Ctrl+C over hard reload to avoid losing CWD/env.
    this.logger.warn(
      `[Watchdog] UI mismatch recovery triggered for terminal: ${terminal.name || 'unnamed'} — sending Ctrl+C instead of reload`,
    );
    const tracker = this.trackers.get(terminal);
    if (tracker) {
      void this.sendCtrlC(terminal, tracker);
    } else {
      try {
        terminal.sendText('\x03', false);
      } catch (err) {
        this.logger.error('[Watchdog] Failed to send Ctrl+C for UI mismatch recovery', err);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
  }

  private onCommandStart(e: vscode.TerminalShellExecutionStartEvent): void {
    if (!this.isRuntimeEnabled()) return;
    this.clearPendingUiMismatchReset(e.terminal);

    const commandLine = e.execution.commandLine?.value ?? '<unknown>';

    if (this.isEphemeralCommand(commandLine)) {
      this.logger.debug(`[Watchdog] Ignoring ephemeral command: ${commandLine}`);
      return;
    }

    if (this.isExcluded(commandLine)) {
      this.logger.debug('[Watchdog] Skipping excluded command', commandLine);
      return;
    }

    const existing = this.trackers.get(e.terminal);
    if (existing && (existing.state === 'running' || existing.state === 'recovering')) {
      // Overlapping executions should not happen in a normal shell, but be defensive.
      this.logger.warn(
        `[Watchdog] Overlapping command detected — marking previous command as completed: "${existing.commandLine}"`,
      );
      existing.state = 'completed';
      this.trackers.delete(e.terminal);
    }

    const tracker: CmdTracker = {
      terminal: e.terminal,
      commandLine,
      startTime: Date.now(),
      lastActivity: Date.now(),
      state: 'running',
      retryCount: 0,
      skippedDueToInteraction: false,
    };

    this.trackers.set(e.terminal, tracker);
    this.logger.debug(`[Watchdog] Command started: ${commandLine}`);
  }

  private onCommandEnd(e: vscode.TerminalShellExecutionEndEvent): void {
    const tracker = this.trackers.get(e.terminal);
    if (!tracker) return;

    const now = Date.now();
    const elapsedMs = now - tracker.startTime;
    const maybeExitCode = (e as unknown as { exitCode?: number }).exitCode;
    const exitCode = typeof maybeExitCode === 'number' ? maybeExitCode : undefined;

    // Quick-end heuristic: only suspect UI mismatch for known long-running commands that
    // exited successfully but far quicker than expected.
    if (
      elapsedMs < this.config.uiMismatchQuickEndMs &&
      this.isLikelyLongRunningCommand(tracker.commandLine) &&
      exitCode === 0
    ) {
      this.logger.warn(
        `[Watchdog] Command ended unusually fast (${elapsedMs}ms): "${tracker.commandLine}"` +
        (exitCode !== undefined ? ` (exitCode=${exitCode})` : ''),
      );
      this.scheduleUiMismatchRecovery(e.terminal, tracker, elapsedMs);
    }

    tracker.exitCode = exitCode;
    tracker.endTime = now;
    tracker.state = 'completed';
    this.trackers.delete(e.terminal);
    this.logger.debug(
      `[Watchdog] Command ended: ${tracker.commandLine} (${elapsedMs}ms)` +
      (typeof maybeExitCode === 'number' ? ` exitCode=${maybeExitCode}` : ''),
    );
  }

  private checkAllTerminals(): void {
    if (!this.isRuntimeEnabled()) return;

    const now = Date.now();

    for (const [terminal, tracker] of this.trackers) {
      // Skip terminals that are not in running or recovering state
      if (tracker.state !== 'running' && tracker.state !== 'recovering') continue;

      // If recovering, wait for recovery timeout before re-checking
      if (tracker.state === 'recovering') {
        const recoveryElapsed = now - tracker.lastActivity;
        if (recoveryElapsed < TerminalWatchdog.RECOVERY_WAIT_MS) {
          continue; // Still in recovery wait period
        }
        // Recovery wait expired — check if still stuck
        const totalElapsed = now - tracker.startTime;
        const timeoutMs = this.getTimeoutMs(tracker.commandLine);
        if (totalElapsed > timeoutMs) {
          // Still stuck — continue recovery escalation
          tracker.state = 'stuck';
          void this.recover(terminal, tracker);
        } else {
          // Recovery may have worked — mark as running again to re-check
          tracker.state = 'running';
        }
        continue;
      }

      // State is 'running' — check timeout
      const elapsed = now - tracker.startTime;
      const timeoutMs = this.getTimeoutMs(tracker.commandLine);

      // Extend timeout by 2x when user is actively using terminal.
      // This avoids sending Enter/Ctrl+C while user is typing, but doesn't skip forever.
      if (terminal.state.isInteractedWith) {
        const extendedTimeout = timeoutMs * 2;
        if (elapsed <= extendedTimeout) {
          if (!tracker.skippedDueToInteraction) {
            tracker.skippedDueToInteraction = true;
            this.logger.debug(
              `[Watchdog] Terminal interactedWith=true — extending timeout to ${Math.round(extendedTimeout / 1000)}s for "${tracker.commandLine}"`,
            );
          }
          continue;
        }
        // Past 2x timeout even with interaction — proceed with recovery
      }

      if (elapsed <= timeoutMs) continue;

      this.logger.warn(
        `[Watchdog] STUCK detected: "${tracker.commandLine}" running for ${Math.round(
          elapsed / 1000,
        )}s (timeout: ${Math.round(timeoutMs / 1000)}s)`,
      );
      this.eventBus?.emit('watchdog:activity', {
        stage: 'stuck-detected',
        terminalName: terminal.name || 'Terminal',
        commandLine: tracker.commandLine,
        elapsedMs: elapsed,
      });

      tracker.state = 'stuck';
      void this.recover(terminal, tracker);
    }
  }

  private getTimeoutMs(commandLine: string): number {
    const category = this.classifyCommand(commandLine);
    switch (category) {
      case 'heavy-build':
      case 'install':
        return this.config.installTimeout * 1000;
      case 'test':
      case 'build':
        return this.config.longTimeout * 1000;
      case 'ephemeral':
      case 'default':
      default:
        return this.config.defaultTimeout * 1000;
    }
  }

  private isExcluded(commandLine: string): boolean {
    const lower = commandLine.toLowerCase();
    for (const pattern of this.config.excludePatterns) {
      if (!pattern) continue;
      if (lower.includes(pattern.toLowerCase())) return true;
    }
    return false;
  }

  private isEphemeralCommand(commandLine: string): boolean {
    const line = (commandLine || '').trim();
    if (!line) return true;
    for (const pattern of TerminalWatchdog.EPHEMERAL_COMMAND_PATTERNS) {
      if (pattern.test(line)) return true;
    }
    return false;
  }

  private isLikelyLongRunningCommand(commandLine: string): boolean {
    const category = this.classifyCommand(commandLine);
    return (
      category === 'test' ||
      category === 'build' ||
      category === 'heavy-build' ||
      category === 'install'
    );
  }

  private classifyCommand(commandLine: string): 'ephemeral' | 'default' | 'build' | 'heavy-build' | 'install' | 'test' {
    const raw = (commandLine || '').trim();
    if (!raw) return 'default';
    const lower = raw.toLowerCase();

    // Ephemeral commands are short-lived and should never be treated as long-running.
    for (const pattern of TerminalWatchdog.EPHEMERAL_COMMAND_PATTERNS) {
      if (pattern.test(raw)) return 'ephemeral';
    }

    // Heavy web builds (Nuxt / Next / React, etc.) can legitimately take many minutes.
    for (const pattern of TerminalWatchdog.QUICK_LONG_RUNNING_PATTERNS) {
      if (pattern.test(lower)) return 'heavy-build';
    }

    // Tokenize to detect generic patterns more safely.
    const tokens = lower.split(/\s+/);
    const first = tokens[0] || '';
    const second = tokens[1] || '';

    // Install / restore commands are long-running by nature.
    if (tokens.includes('install') || tokens.includes('restore')) {
      return 'install';
    }

    // Explicit test commands (go test, npm test, yarn test, pnpm test, etc.).
    if (
      (first === 'go' && second === 'test') ||
      ((first === 'npm' || first === 'yarn' || first === 'pnpm') && second === 'test')
    ) {
      return 'test';
    }

    // Generic "test"/"build" scripts: treat as long-running but one level below heavy builds.
    if (tokens.includes('test')) return 'test';
    if (tokens.includes('build')) return 'build';

    return 'default';
  }

  private scheduleUiMismatchRecovery(
    terminal: vscode.Terminal,
    tracker: CmdTracker,
    elapsedMs: number,
  ): void {
    if (!this.config.uiMismatchRecoveryEnabled) return;
    if (elapsedMs > this.config.uiMismatchQuickEndMs) return;

    this.clearPendingUiMismatchReset(terminal);
    const graceMs = Math.max(1000, this.config.uiMismatchGraceMs);

    const timer = setTimeout(() => {
      this.pendingUiMismatchResets.delete(terminal);
      if (!this.isRuntimeEnabled()) return;
      // If a new command started, do not reset.
      if (this.trackers.has(terminal)) return;
      // Respect active user interaction to avoid disruptive resets.
      if (terminal.state.isInteractedWith) {
        this.logger.debug(
          `[Watchdog] UI mismatch recovery skipped due to interacted terminal: "${tracker.commandLine}"`,
        );
        return;
      }

      this.logger.warn(
        `[Watchdog] UI mismatch suspected after quick-end "${tracker.commandLine}" — sending Ctrl+C for gentle recovery`,
      );
      // Gentle recovery: send Ctrl+C once instead of killing/reloading the terminal.
      void this.sendCtrlC(terminal, tracker);
    }, graceMs);

    this.pendingUiMismatchResets.set(terminal, timer);
  }

  private clearPendingUiMismatchReset(terminal: vscode.Terminal): void {
    const timer = this.pendingUiMismatchResets.get(terminal);
    if (timer) {
      clearTimeout(timer);
      this.pendingUiMismatchResets.delete(terminal);
    }
  }



  private async recover(
    terminal: vscode.Terminal,
    tracker: CmdTracker,
  ): Promise<void> {
    // Soft mode: never kill terminals, only attempt gentle recovery.
    if (this.config.softMode) {
      if (tracker.retryCount === 0) {
        await this.sendEnter(terminal, tracker);
        return;
      }
      if (tracker.retryCount >= this.config.maxRetries) {
        this.logger.warn(
          `[Watchdog] softMode: max retries (${this.config.maxRetries}) reached for "${tracker.commandLine}" — stopping recovery`,
        );
        tracker.state = 'completed';
        this.trackers.delete(terminal);
        return;
      }
      // For soft mode we cap at Ctrl+C and do not escalate further.
      await this.sendCtrlC(terminal, tracker);
      return;
    }

    if (this.config.recoveryStrategy === 'enter-only') {
      if (tracker.retryCount >= this.config.maxRetries) {
        this.logger.warn(
          `[Watchdog] enter-only: max retries (${this.config.maxRetries}) reached for "${tracker.commandLine}" — stopping recovery`,
        );
        tracker.state = 'completed';
        this.trackers.delete(terminal);
        this.eventBus?.emit('watchdog:activity', {
          stage: 'enter',
          terminalName: terminal.name || 'Terminal',
          commandLine: tracker.commandLine,
          elapsedMs: Date.now() - tracker.startTime,
        });
        return;
      }
      await this.sendEnter(terminal, tracker);
      return;
    }

    if (this.config.recoveryStrategy === 'kill-only') {
      if (this.shouldAvoidKill(terminal, tracker)) return;
      this.killTerminal(terminal, tracker);
      return;
    }

    // Default: escalating strategy
    if (tracker.retryCount >= this.config.maxRetries) {
      this.logger.warn(
        `[Watchdog] Max retries reached for "${tracker.commandLine}" — killing terminal`,
      );
      if (this.shouldAvoidKill(terminal, tracker)) return;
      this.killTerminal(terminal, tracker);
      return;
    }

    if (tracker.retryCount === 0) {
      await this.sendEnter(terminal, tracker);
      return;
    }

    if (tracker.retryCount === 1) {
      await this.sendCtrlC(terminal, tracker);
      return;
    }

    // 2+ retries → kill
    if (this.shouldAvoidKill(terminal, tracker)) return;
    this.killTerminal(terminal, tracker);
  }

  private async sendEnter(
    terminal: vscode.Terminal,
    tracker: CmdTracker,
  ): Promise<void> {
    this.logger.info('[Watchdog] Recovery Stage 1: Sending Enter');
    try {
      terminal.sendText('\n', false);
      tracker.retryCount += 1;
      tracker.lastActivity = Date.now();
      tracker.state = 'recovering';
      this.eventBus?.emit('watchdog:activity', {
        stage: 'enter',
        terminalName: terminal.name || 'Terminal',
        commandLine: tracker.commandLine,
      });
    } catch (err) {
      this.logger.error('[Watchdog] Failed to send Enter', err);
    }
  }

  private async sendCtrlC(
    terminal: vscode.Terminal,
    tracker: CmdTracker,
  ): Promise<void> {
    this.logger.info('[Watchdog] Recovery Stage 2: Sending Ctrl+C');
    try {
      terminal.sendText('\x03', false); // Ctrl+C
      tracker.retryCount += 1;
      tracker.lastActivity = Date.now();
      tracker.state = 'recovering';
      this.eventBus?.emit('watchdog:activity', {
        stage: 'ctrlc',
        terminalName: terminal.name || 'Terminal',
        commandLine: tracker.commandLine,
      });
    } catch (err) {
      this.logger.error('[Watchdog] Failed to send Ctrl+C', err);
    }
  }

  private shouldAvoidKill(terminal: vscode.Terminal, tracker: CmdTracker): boolean {
    if (terminal.state.isInteractedWith) {
      this.logger.warn(
        `[Watchdog] Kill skipped for interacted terminal (user activity detected) — ` +
        `command "${tracker.commandLine}" will be marked as completed instead.`,
      );
      tracker.state = 'completed';
      this.trackers.delete(terminal);
      return true;
    }
    return false;
  }


  private killTerminal(terminal: vscode.Terminal, tracker: CmdTracker): void {
    this.logger.warn(
      `[Watchdog] Recovery Stage 3: Killing terminal (command: "${tracker.commandLine}")`,
    );
    this.logger.warn(
      '[Watchdog] Hint: If this command is expected to run long, add a substring of it to "domyh-auto-accept.terminalWatchdog.excludePatterns".',
    );

    // Send Ctrl+C first for graceful shutdown (important for kill-only strategy
    // where no previous Ctrl+C was sent, and for ConPTY on Windows).
    try {
      terminal.sendText('\x03', false);
    } catch {
      // Terminal may already be unresponsive
    }

    this.trackers.delete(terminal);
    tracker.state = 'completed';

    // Grace period: allow Ctrl+C to take effect before hard kill.
    const graceMs = 2000;
    setTimeout(() => {
      try {
        terminal.dispose();
      } catch {
        // Terminal may already be closed by Ctrl+C
      }
    }, graceMs);

    void vscode.window
      .showWarningMessage(
        `Terminal watchdog: Command "${tracker.commandLine}" was stuck for ` +
        `${Math.round((Date.now() - tracker.startTime) / 1000)}s. ` +
        'Terminal was killed. You may need to re-run the command.\n\n' +
        'Tip: If this command is intentionally long-running, add part of it to "domyh-auto-accept.terminalWatchdog.excludePatterns" in your settings to avoid future kills.',
        'Open New Terminal',
        'Dismiss',
      )
      .then(
        (action) => {
          if (action === 'Open New Terminal') {
            vscode.window.createTerminal();
          }
        },
        () => {
          // ignore UI errors
        },
      );

    this.eventBus?.emit('watchdog:activity', {
      stage: 'kill',
      terminalName: terminal.name || 'Terminal',
      commandLine: tracker.commandLine,
    });
  }
}


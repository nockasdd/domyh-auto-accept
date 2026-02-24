import * as vscode from 'vscode';
import { CmdTracker, WatchdogConfig, TrackingState } from '../../domain/types/terminal';
import { Logger } from '../../core/logger';

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
  ];

  constructor(
    private readonly config: WatchdogConfig,
    private readonly logger: Logger,
  ) {}

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

    if (terminal) {
      // Reload specific terminal
      this.logger.warn(`[Watchdog] UI mismatch recovery triggered for terminal: ${terminal.name || 'unnamed'}`);
      this.reloadTerminal(terminal);
    } else {
      // Reload all tracked terminals
      const terminals = Array.from(this.trackers.keys());
      if (terminals.length === 0) {
        this.logger.debug('[Watchdog] UI mismatch recovery triggered but no terminals tracked');
        return;
      }
      this.logger.warn(`[Watchdog] UI mismatch recovery triggered for ${terminals.length} terminal(s)`);
      for (const term of terminals) {
        this.reloadTerminal(term);
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

    const elapsedMs = Date.now() - tracker.startTime;
    const maybeExitCode = (e as unknown as { exitCode?: number }).exitCode;

    if (elapsedMs < 2000 && this.isLikelyLongRunningCommand(tracker.commandLine)) {
      this.logger.warn(
        `[Watchdog] Command ended unusually fast (${elapsedMs}ms): "${tracker.commandLine}"` +
          (typeof maybeExitCode === 'number' ? ` (exitCode=${maybeExitCode})` : ''),
      );
      this.scheduleUiMismatchRecovery(e.terminal, tracker, elapsedMs);
    }

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
        if (recoveryElapsed >= TerminalWatchdog.RECOVERY_WAIT_MS) {
          // Command is still stuck after recovery attempt
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
        }
        continue;
      }

      // State is 'running' — check timeout
      const elapsed = now - tracker.startTime;
      const timeoutMs = this.getTimeoutMs(tracker.commandLine);

      // Basic safety: if user has interacted with this terminal, be more cautious
      if (
        terminal.state.isInteractedWith &&
        tracker.retryCount === 0 &&
        !tracker.skippedDueToInteraction
      ) {
        // Skip first recovery attempt to avoid interfering with manual work
        tracker.skippedDueToInteraction = true;
        this.logger.debug(
          `[Watchdog] Terminal interactedWith=true — skipping first recovery for "${tracker.commandLine}"`,
        );
        continue;
      }

      if (elapsed <= timeoutMs) continue;

      this.logger.warn(
        `[Watchdog] STUCK detected: "${tracker.commandLine}" running for ${Math.round(
          elapsed / 1000,
        )}s (timeout: ${Math.round(timeoutMs / 1000)}s)`,
      );

      tracker.state = 'stuck';
      void this.recover(terminal, tracker);
    }
  }

  private getTimeoutMs(commandLine: string): number {
    const cmd = commandLine.toLowerCase();

    // Heavy web builds (Nuxt / Next / React, etc.) can legitimately take many minutes.
    // Treat these as "installTimeout" (highest) by default.
    if (
      cmd.includes('nuxt build') ||
      cmd.includes('next build') ||
      cmd.includes('react-scripts build') ||
      cmd.includes('npm run build') ||
      cmd.includes('yarn build') ||
      cmd.includes('pnpm build')
    ) {
      return this.config.installTimeout * 1000;
    }

    // Generic build/test commands get longTimeout (medium).
    if (cmd.includes('test') || cmd.includes('build')) {
      return this.config.longTimeout * 1000;
    }

    // Install / package restore commands are also long-running by nature.
    if (cmd.includes('install') || cmd.includes('restore')) {
      return this.config.installTimeout * 1000;
    }

    // Everything else: default timeout.
    return this.config.defaultTimeout * 1000;
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
    const cmd = (commandLine || '').toLowerCase();
    return (
      cmd.includes(' test') ||
      cmd.startsWith('test ') ||
      cmd.includes('go test') ||
      cmd.includes(' build') ||
      cmd.startsWith('build ') ||
      cmd.includes('npm run build') ||
      cmd.includes('yarn build') ||
      cmd.includes('pnpm build')
    );
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
        `[Watchdog] UI mismatch suspected after quick-end "${tracker.commandLine}" — reloading terminal`,
      );
      this.reloadTerminal(terminal);
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

  private reloadTerminal(terminal: vscode.Terminal): void {
    try {
      const name = terminal.name || 'Terminal';
      terminal.dispose();
      const fresh = vscode.window.createTerminal({ name });
      fresh.show(true);
    } catch (err) {
      this.logger.error('[Watchdog] Failed to reload terminal', err);
    }
  }

  private async recover(
    terminal: vscode.Terminal,
    tracker: CmdTracker,
  ): Promise<void> {
    if (this.config.recoveryStrategy === 'enter-only') {
      await this.sendEnter(terminal, tracker);
      return;
    }

    if (this.config.recoveryStrategy === 'kill-only') {
      this.killTerminal(terminal, tracker);
      return;
    }

    // Default: escalating strategy
    if (tracker.retryCount >= this.config.maxRetries) {
      this.logger.warn(
        `[Watchdog] Max retries reached for "${tracker.commandLine}" — killing terminal`,
      );
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
    } catch (err) {
      this.logger.error('[Watchdog] Failed to send Enter', err);
    }

    setTimeout(() => this.maybeMarkStuck(tracker), TerminalWatchdog.RECOVERY_WAIT_MS);
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
    } catch (err) {
      this.logger.error('[Watchdog] Failed to send Ctrl+C', err);
    }

    setTimeout(() => this.maybeMarkStuck(tracker), TerminalWatchdog.RECOVERY_WAIT_MS);
  }

  private maybeMarkStuck(_tracker: CmdTracker): void {
    // This is called after RECOVERY_WAIT_MS timeout.
    // If still in 'recovering' state, it means recovery didn't work.
    // checkAllTerminals() will handle the next recovery stage.
    // We don't change state here — let checkAllTerminals() decide based on elapsed time.
    // Parameter is kept for API compatibility but not used.
  }

  private killTerminal(terminal: vscode.Terminal, tracker: CmdTracker): void {
    this.logger.warn(
      `[Watchdog] Recovery Stage 3: Killing terminal (command: "${tracker.commandLine}")`,
    );
    try {
      terminal.dispose();
    } catch (err) {
      this.logger.error('[Watchdog] Failed to dispose terminal', err);
    }

    this.trackers.delete(terminal);
    tracker.state = 'completed' as TrackingState;

    void vscode.window
      .showWarningMessage(
        `Terminal watchdog: Command "${tracker.commandLine}" was stuck for ` +
          `${Math.round((Date.now() - tracker.startTime) / 1000)}s. ` +
          'Terminal was killed. You may need to re-run the command.',
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
  }
}


import type * as vscode from 'vscode';
import type { WatchdogState } from '../types/terminal';

/**
 * Public interface for the Terminal Watchdog service.
 *
 * Implementations are responsible for:
 * - Tracking terminal commands
 * - Detecting stuck executions
 * - Applying recovery strategies
 */
export interface ITerminalWatchdog extends vscode.Disposable {
  /** Start monitoring terminals */
  start(): void;

  /** Stop monitoring and clear all trackers */
  stop(): void;

  /** Optional: expose last known state for UI integrations */
  getState?(): WatchdogState;
}


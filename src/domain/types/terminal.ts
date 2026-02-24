/**
 * Terminal Watchdog types
 *
 * Detect and recover from stuck terminal commands, primarily for AI agents.
 */

import * as vscode from 'vscode';

/** Runtime state of a tracked terminal command */
export type TrackingState = 'idle' | 'running' | 'recovering' | 'stuck' | 'completed';

/** Configuration for the terminal watchdog */
export interface WatchdogConfig {
  readonly enabled: boolean;
  /** Default timeout in seconds for normal commands */
  readonly defaultTimeout: number;
  /** Timeout in seconds for long-running commands like test/build */
  readonly longTimeout: number;
  /** Timeout in seconds for install commands (npm/pip/dotnet restore, etc.) */
  readonly installTimeout: number;
  /** Maximum number of recovery attempts before giving up */
  readonly maxRetries: number;
  /** Recovery strategy */
  readonly recoveryStrategy: 'enter-only' | 'escalating' | 'kill-only';
  /**
   * Soft mode: when true, the watchdog will never kill terminals.
   * Recovery is limited to Enter/Ctrl+C even if recoveryStrategy is "escalating" or "kill-only".
   */
  readonly softMode: boolean;
  /** Commands that should never be monitored (long-running by design) */
  readonly excludePatterns: string[];
  /**
   * Optional recovery for UI/terminal mismatch cases where a long-running command
   * appears to end too quickly while IDE UI still shows "Running command...".
   * Disabled by default (opt-in) to avoid aggressive resets.
   */
  readonly uiMismatchRecoveryEnabled: boolean;
  /** Command end elapsed threshold (ms) to classify as suspicious quick-end */
  readonly uiMismatchQuickEndMs: number;
  /** Grace time (ms) before terminal reset, allowing new command/start events to arrive */
  readonly uiMismatchGraceMs: number;
}

/** Per-terminal command tracking */
export interface CmdTracker {
  readonly terminal: vscode.Terminal;
  readonly commandLine: string;
  readonly startTime: number;
  lastActivity: number;
  state: TrackingState;
  retryCount: number;
  /**
   * Guard to ensure we only skip ONE recovery cycle when terminal was manually interacted.
   * Without this, interacted terminals can be skipped forever and never recover.
   */
  skippedDueToInteraction: boolean;
  /** Optional exit code reported by the shell execution (undefined if unknown/interrupted) */
  exitCode?: number;
  /** Timestamp (ms since epoch) when the command finished, if known */
  endTime?: number;
}

/** High-level watchdog status for UI (status bar / dashboard) */
export interface WatchdogState {
  readonly status: 'monitoring' | 'stuck-detected' | 'recovering' | 'killed';
  readonly retryCount?: number;
  readonly elapsedMs?: number;
  readonly commandLine?: string;
}


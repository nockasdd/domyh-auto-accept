/**
 * Extension configuration types
 */

import { QueueMode } from '../enums';
import { WatchdogConfig } from './terminal';
import { AutoAcceptRuntimeConfig } from './auto-accept-config';

/** Top-level extension configuration */
export interface ExtensionConfig {
  readonly enabled: boolean;
  readonly cdpPort: number;
  readonly pollFrequency: number;
  /**
   * CDP setup mode:
   * - "auto": patch argv.json + shortcuts where possible (current default behavior)
   * - "manual": do not modify host files, only use existing CDP configuration
   */
  readonly cdpSetupMode: 'auto' | 'manual';
  readonly bannedCommands: string[];
  readonly autoAllowOutsideWorkspace: boolean;
  readonly smartFocus: boolean;
  readonly debugMode: boolean;
  readonly autoRetry: AutoRetryConfig;
  readonly schedule: ScheduleConfig;
  readonly terminalWatchdog: WatchdogConfig;
  /**
   * Runtime configuration snapshot used by the auto-accept payload.
   * This is derived from other config values plus a few dedicated flags.
   */
  readonly autoAcceptRuntime: AutoAcceptRuntimeConfig;
}

/** Auto-retry configuration */
export interface AutoRetryConfig {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly windowSeconds: number;
  readonly cooldownSeconds: number;
}

/** Scheduler configuration */
export interface ScheduleConfig {
  readonly enabled: boolean;
  readonly mode: 'interval' | 'daily' | 'queue';
  readonly value: string;
  readonly prompt: string;
  readonly prompts: string[];
  readonly queueMode: QueueMode;
  readonly silenceTimeout: number;
}

/** Per-IDE static configuration */
export interface IDEConfig {
  readonly defaultPort: number;
  readonly appNamePattern: string;
  readonly launchFlag: string;
}

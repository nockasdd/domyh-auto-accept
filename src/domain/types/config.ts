/**
 * Extension configuration types
 */

import { QueueMode } from '../enums';

/** Top-level extension configuration */
export interface ExtensionConfig {
  readonly enabled: boolean;
  readonly cdpPort: number;
  readonly pollFrequency: number;
  readonly bannedCommands: string[];
  readonly autoAllowOutsideWorkspace: boolean;
  readonly smartFocus: boolean;
  readonly debugMode: boolean;
  readonly autoRetry: AutoRetryConfig;
  readonly schedule: ScheduleConfig;
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

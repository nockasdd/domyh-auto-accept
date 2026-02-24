/**
 * Runtime configuration shape for the auto-accept payload.
 *
 * NOTE: This type is consumed by the extension side (TypeScript)
 * and serialized to a plain JSON object that the payload reads
 * via `window.__autoAcceptConfig`.
 */

export type AutoAcceptLogLevel = 'none' | 'info' | 'debug';

export interface AutoAcceptRuntimeConfig {
  // Global enable/disable
  readonly enabled: boolean;

  // Per-action feature flags
  readonly clickRun: boolean;
  readonly clickProceed: boolean;
  readonly clickAcceptAll: boolean;
  readonly clickAllowOnce: boolean;
  readonly clickAllowConversation: boolean;
  readonly clickSend: boolean;

  // Command safety
  readonly bannedCommands: string[];
  readonly dangerousCommands: string[];

  // Extra UI constraints
  readonly forbiddenZonesExtra: string[];

  // Timing / throttling
  readonly pollFrequencyMs: number;
  readonly proceedThrottleMs: number;
  readonly userScrollCooldownMs: number;

  // Safety limits
  readonly maxClicksPerCycle: number;

  // Diagnostics
  readonly logLevel: AutoAcceptLogLevel;
}


/**
 * Strongly-typed event definitions
 */

import { EngineState, IDEType, QueueMode } from '../enums';
import { ButtonMatch } from './button';
import { SessionStats } from './stats';

/** All events in the system — strongly typed */
export interface EventMap {
  // Engine events
  'engine:stateChanged': { from: EngineState; to: EngineState };
  'engine:buttonClicked': { match: ButtonMatch; adapter: IDEType };
  'engine:commandBlocked': { command: string; pattern: string };
  'engine:statsUpdated': SessionStats;
  'engine:deathLoopDetected': { retryCount: number; windowSeconds: number };
  'engine:deathLoopReset': undefined;

  // CDP connection events
  'cdp:connected': { port: number; targets: number };
  'cdp:disconnected': { reason: string };
  'cdp:reconnecting': { attempt: number; delay: number };
  'cdp:targetFound': { id: string; title: string };

  // Scheduler events
  'scheduler:promptSent': { text: string; target: string };
  'scheduler:queueAdvanced': { index: number; total: number };
  'scheduler:silenceDetected': { duration: number };
  'scheduler:completed': { mode: QueueMode };

  // Lock events
  'lock:acquired': { instanceId: string };
  'lock:denied': { holder: string };

  // Smart focus events
  'focus:autoEnabled': { reason: string };
  'focus:autoDisabled': { reason: string };

  // Permission events
  'permission:autoAllowed': { dialogType: string };
  'permission:blocked': { dialogType: string; reason: string };

  // Runtime config events
  'runtimeConfig:changed': {
    old: import('./auto-accept-config').AutoAcceptRuntimeConfig;
    new: import('./auto-accept-config').AutoAcceptRuntimeConfig;
  };

  // Terminal watchdog events
  'watchdog:activity': {
    stage: 'stuck-detected' | 'enter' | 'ctrlc' | 'kill' | 'ui-mismatch';
    terminalName: string;
    commandLine: string;
    elapsedMs?: number;
  };
}

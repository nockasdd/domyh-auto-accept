/**
 * IIDEAdapter — The extensibility key
 *
 * Adding a new IDE = implement this interface + register in registry.
 * Zero changes to engine, CDP, scheduler, safety, or UI code.
 */

import { IDEType } from '../enums';
import {
  ButtonSelectorConfig,
  ButtonMatch,
  ElementInfo,
  RetryPattern,
  PermissionPattern,
} from '../types/button';
import { CDPTarget, CDPConnection } from '../types/connection';

export interface IIDEAdapter {
  readonly id: IDEType;
  readonly displayName: string;
  readonly defaultCDPPort: number;
  readonly launchFlag: string;

  // === Approach 1: VS Code Commands API ===
  /** Return internal VS Code command IDs for accepting agent steps */
  getAcceptCommands(): string[];
  /** Return internal VS Code command IDs for rejecting agent steps */
  getRejectCommands(): string[];
  /** Whether this IDE exposes internal accept/reject commands */
  supportsCommandsAPI(): boolean;

  // === Approach 2: CDP DOM button detection ===
  /** Return CSS selectors and text patterns for button matching */
  getButtonSelectors(): ButtonSelectorConfig;
  /** Match a specific DOM element against adapter's patterns */
  matchButton(element: ElementInfo): ButtonMatch | null;

  // === Chat input ===
  /** CSS selector for the chat input field */
  getChatInputSelector(): string;
  /** Payload JS for injecting text into chat and sending */
  getSendPromptPayload(): string;

  // === Connection filtering ===
  /** Filter CDP targets to find the correct webview */
  filterTargets(targets: CDPTarget[]): CDPTarget[];

  // === Error/retry patterns ===
  /** Return patterns for matching retry/error dialogs */
  getRetryPatterns(): RetryPattern[];
  /** Return patterns for permission dialogs (outside-workspace, etc.) */
  getPermissionPatterns(): PermissionPattern[];

  // === Optional overrides ===
  /** Custom JS payload to inject instead of default */
  getCustomPayload?(): string;
  /** Hook called when CDP connection established */
  onConnected?(connection: CDPConnection): Promise<void>;
  /** Hook called when a button is clicked */
  onButtonClicked?(match: ButtonMatch): void;
  /** URL patterns to identify agent panel iframes for CDP context targeting */
  getIframePatterns?(): string[];
}

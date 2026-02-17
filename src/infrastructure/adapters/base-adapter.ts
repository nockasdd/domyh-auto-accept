/**
 * BaseIDEAdapter — Template Method pattern
 *
 * Extracts shared logic from IDE adapters:
 * - matchButton: text + class pattern matching with priority mapping
 * - filterTargets: default page filter
 * - getRetryPatterns: common error patterns (429, overloaded, timeout, context full)
 * - getPriority: ButtonType → ButtonPriority mapping
 *
 * Subclasses implement only what differs:
 *   getAcceptCommands, getRejectCommands, getButtonSelectors, filterTargets (optional)
 */

import { IIDEAdapter } from '../../domain/interfaces/ide-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonMatch,
  ButtonType,
  ButtonPriority,
  ElementInfo,
  RetryPattern,
  PermissionPattern,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';

export abstract class BaseIDEAdapter implements IIDEAdapter {
  abstract readonly id: IDEType;
  abstract readonly displayName: string;
  abstract readonly defaultCDPPort: number;
  abstract readonly launchFlag: string;

  // ── ABSTRACT — subclasses MUST implement ──────────

  abstract getAcceptCommands(): string[];
  abstract getRejectCommands(): string[];
  abstract getButtonSelectors(): ButtonSelectorConfig;

  // ── SHARED — default implementations ─────────────

  supportsCommandsAPI(): boolean {
    return true;
  }

  getChatInputSelector(): string {
    return '[contenteditable="true"]';
  }

  getSendPromptPayload(): string {
    return ''; // Uses default PayloadManager send-prompt
  }

  // ── Template Method: button matching ─────────────

  matchButton(element: ElementInfo): ButtonMatch | null {
    const text = (element.ariaLabel || element.textContent).trim();
    if (!text || element.disabled || !element.visible) return null;

    const config = this.getButtonSelectors();

    // Check text patterns first (highest confidence)
    for (const [typeStr, patterns] of Object.entries(config.textPatterns)) {
      const type = typeStr as ButtonType;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return {
            type,
            priority: this.getPriority(type),
            text,
            element,
            commandText: element.commandText,
            blocked: false,
          };
        }
      }
    }

    // Then check CSS class patterns (fallback)
    if (config.classPatterns) {
      for (const [typeStr, patterns] of Object.entries(config.classPatterns)) {
        const type = typeStr as ButtonType;
        for (const pattern of patterns) {
          if (pattern.test(element.className)) {
            return {
              type,
              priority: this.getPriority(type),
              text,
              element,
              commandText: element.commandText,
              blocked: false,
            };
          }
        }
      }
    }

    return null;
  }

  // ── Default target filtering ─────────────────────

  filterTargets(targets: CDPTarget[]): CDPTarget[] {
    return targets.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl,
    );
  }

  // ── Shared retry patterns ────────────────────────

  getRetryPatterns(): RetryPattern[] {
    return [
      {
        errorTextPattern: /429|too many requests/i,
        retryButtonText: /^(retry|try\s*again)$/i,
        delayMs: 5000,
        skipRetry: false,
      },
      {
        errorTextPattern: /model\s*(is\s+)?overloaded/i,
        retryButtonText: /^(retry|please\s*(try\s*again|retry))$/i,
        delayMs: 30_000,
        skipRetry: false,
      },
      {
        errorTextPattern: /network\s*(error|timeout)|timed?\s*out/i,
        retryButtonText: /^(retry|try\s*again)$/i,
        delayMs: 5000,
        skipRetry: false,
      },
      {
        // Context window full — DO NOT retry (death loop risk)
        errorTextPattern: /context\s*(window|length)\s*(full|exceeded|limit)/i,
        retryButtonText: /^$/,
        delayMs: 0,
        skipRetry: true,
      },
    ];
  }

  getPermissionPatterns(): PermissionPattern[] {
    return [];
  }

  // ── Priority mapping ─────────────────────────────

  protected getPriority(type: ButtonType): ButtonPriority {
    const map: Record<ButtonType, ButtonPriority> = {
      [ButtonType.AcceptAll]: ButtonPriority.AcceptAll,
      [ButtonType.Accept]: ButtonPriority.AcceptSingle,
      [ButtonType.Run]: ButtonPriority.RunCommand,
      [ButtonType.Retry]: ButtonPriority.Retry,
      [ButtonType.Continue]: ButtonPriority.Continue,
      [ButtonType.Permission]: ButtonPriority.Permission,
      [ButtonType.Dismiss]: ButtonPriority.Dismiss,
    };
    return map[type] ?? ButtonPriority.Dismiss;
  }
}

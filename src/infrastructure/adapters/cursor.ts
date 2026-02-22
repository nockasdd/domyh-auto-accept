/**
 * CursorAdapter — IDE adapter for Cursor (VS Code fork)
 *
 * Cursor-specific:
 * - cursorAccept, cursor.acceptDiff for accepting AI suggestions
 * - Agent hunk accept/reject for per-hunk review
 * - CDP port 9222 (Cursor default)
 */

import { BaseIDEAdapter } from './base-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonType,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';

export class CursorAdapter extends BaseIDEAdapter {
  readonly id = IDEType.Cursor;
  readonly displayName = 'Cursor';
  readonly defaultCDPPort = 9222;
  readonly launchFlag = '--remote-debugging-port=9222';

  getAcceptCommands(): string[] {
    return [
      'cursorAccept',
      'cursor.acceptDiff',
      'cursor.agentAcceptFocusedHunk',
      'editor.action.inlineSuggest.commit',
      // Chat editing: Accept file changes in chat panel
      'chatEditing.acceptAllFiles',
      'chatEditing.acceptFile',
    ];
  }

  getRejectCommands(): string[] {
    return [
      'cursorReject',
      'cursor.rejectDiff',
      'cursor.agentRejectFocusedHunk',
    ];
  }

  getButtonSelectors(): ButtonSelectorConfig {
    return {
      containerSelectors: [
        'button',
        '[role="button"]',
        '.action-item a',
        // Cursor may render action buttons as <span> with Tailwind classes
        'span[class*="bg-ide-button"]',
        'span[class*="cursor-pointer"][class*="select-none"]',
        // Cursor-specific: Anysphere button classes (confirmed via DOM dump)
        '.anysphere-secondary-button',
        '.anysphere-text-button',
        '.anysphere-focus-outline-button',
        // Generic clickable indicator used on all interactive Anysphere buttons
        '[data-click-ready="true"]',
      ],
      textPatterns: {
        [ButtonType.AcceptAll]: [
          /^keep\s*all$/i, /^accept\s*all$/i,
          /^apply\s*all$/i, /^accept\s*all\s*files$/i,
        ],
        [ButtonType.Accept]: [
          /^accept$/i, /^accept\s+change/i,
          // Handle "Accept ^⏎" keyboard shortcut suffix in Cursor UI
          /^accept\s*[\^⏎↵⌃⌘⇧\s]*$/i,
        ],
        [ButtonType.Run]: [/^run$/i, /^run\s+command$/i, /^run\s+everything$/i],
        [ButtonType.Retry]: [/^retry$/i, /^try\s*again$/i],
        [ButtonType.Continue]: [/^continue$/i, /^yes$/i],
        [ButtonType.Permission]: [/^allow$/i, /^trust$/i],
        [ButtonType.Dismiss]: [/^ok$/i, /^got\s*it$/i, /^dismiss$/i],
      },
    };
  }

  filterTargets(targets: CDPTarget[]): CDPTarget[] {
    // Other IDE names to explicitly reject — prevents cross-IDE connection
    // when multiple VS Code forks share overlapping CDP port ranges
    const otherIDEs = /\b(antigravity|windsurf|trae)\b/i;

    return targets.filter((t) => {
      if (!t.webSocketDebuggerUrl) return false;

      const titleLower = (t.title || '').toLowerCase();

      // CRITICAL: Reject targets that belong to another IDE.
      // All VS Code forks have 'workbench' in their page URL, so URL alone
      // is NOT sufficient to distinguish. Title format: "{workspace} - {IDE}"
      if (otherIDEs.test(t.title)) return false;

      // Webview targets (agent panels, chat) — IDE-agnostic, include if not rejected above
      if (t.type === 'webview') return true;

      // Page targets: must be a workbench page
      if (t.type === 'page') {
        if (!t.url.includes('workbench')) return false;
        // Skip empty-title pages (background/preload pages)
        if (!titleLower) return false;
        return true;
      }

      return false;
    });
  }
}

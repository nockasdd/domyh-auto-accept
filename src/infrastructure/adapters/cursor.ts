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
        // Cursor-specific: Anysphere button class (confirmed via YOLO script)
        '.anysphere-secondary-button',
      ],
      textPatterns: {
        [ButtonType.AcceptAll]: [/^keep\s*all$/i, /^accept\s*all$/i],
        [ButtonType.Accept]: [/^accept$/i, /^accept\s+change/i],
        [ButtonType.Run]: [/^run$/i, /^run\s+command$/i],
        [ButtonType.Retry]: [/^retry$/i, /^try\s*again$/i],
        [ButtonType.Continue]: [/^continue$/i, /^yes$/i],
        [ButtonType.Permission]: [/^allow$/i, /^trust$/i],
        [ButtonType.Dismiss]: [/^ok$/i, /^got\s*it$/i, /^dismiss$/i],
      },
    };
  }

  filterTargets(targets: CDPTarget[]): CDPTarget[] {
    return targets.filter(
      (t) =>
        t.webSocketDebuggerUrl &&
        (t.type === 'webview' ||
         t.type === 'iframe' ||
         (t.type === 'page' &&
          (t.url.includes('workbench') || t.title.includes('Cursor')))),
    );
  }
}

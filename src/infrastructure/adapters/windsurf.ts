/**
 * WindsurfAdapter — IDE adapter for Windsurf (Codeium)
 *
 * Windsurf-specific:
 * - windsurf.accept for accepting Cascade AI suggestions
 * - Cascade action bar buttons (Accept/Reject)
 * - Alt+A keyboard shortcut for accepting
 * - CDP port 9224
 */

import { BaseIDEAdapter } from './base-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonType,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';

export class WindsurfAdapter extends BaseIDEAdapter {
  readonly id = IDEType.Windsurf;
  readonly displayName = 'Windsurf';
  readonly defaultCDPPort = 9224;
  readonly launchFlag = '--remote-debugging-port=9224';

  getAcceptCommands(): string[] {
    return [
      'windsurf.accept',
      'windsurf.acceptAll',
      'editor.action.inlineSuggest.commit',
      'chatEditing.acceptAllFiles',
      'chatEditing.acceptFile',
    ];
  }

  getRejectCommands(): string[] {
    return [
      'windsurf.reject',
      'windsurf.rejectAll',
    ];
  }

  getButtonSelectors(): ButtonSelectorConfig {
    return {
      containerSelectors: [
        'button',
        '[role="button"]',
        '.action-item a',
        '.cascade-action-bar button',
        // Windsurf may render action buttons as <span> with Tailwind classes
        'span[class*="bg-ide-button"]',
        'span[class*="cursor-pointer"][class*="select-none"]',
      ],
      textPatterns: {
        [ButtonType.AcceptAll]: [/^accept\s*all$/i],
        [ButtonType.Accept]: [/^accept$/i, /^accept\s+change/i],
        [ButtonType.Run]: [/^run$/i, /^run\s+command$/i, /^execute$/i],
        [ButtonType.Retry]: [/^retry$/i, /^try\s*again$/i],
        [ButtonType.Continue]: [/^continue$/i, /^yes$/i, /^proceed$/i],
        [ButtonType.Permission]: [/^allow$/i, /^trust$/i],
        [ButtonType.Dismiss]: [/^ok$/i, /^dismiss$/i, /^got\s*it$/i],
      },
    };
  }

  getChatInputSelector(): string {
    return '[contenteditable="true"].cascade-input, [contenteditable="true"]';
  }

  filterTargets(targets: CDPTarget[]): CDPTarget[] {
    return targets.filter(
      (t) =>
        t.webSocketDebuggerUrl &&
        (t.type === 'webview' ||
         t.type === 'iframe' ||
         (t.type === 'page' &&
          (t.url.includes('workbench') || t.title.includes('Windsurf')))),
    );
  }
}

/**
 * TraeAdapter — IDE adapter for Trae (ByteDance)
 *
 * Trae-specific:
 * - trae.accept for accepting AI suggestions
 * - Builder mode "Accept All" / "Approve" buttons
 * - ByteDance LLM integration (GPT-4o / Claude 3.5 Sonnet)
 * - CDP port 9226
 */

import { BaseIDEAdapter } from './base-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonType,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';

export class TraeAdapter extends BaseIDEAdapter {
  readonly id = IDEType.Trae;
  readonly displayName = 'Trae';
  readonly defaultCDPPort = 9005;
  readonly launchFlag = '--remote-debugging-port=9005';

  getAcceptCommands(): string[] {
    return [
      'trae.accept',
      'trae.acceptAll',
      'trae.builder.accept',
      'trae.builder.continue',
      'editor.action.inlineSuggest.commit',
      'chatEditing.acceptAllFiles',
      'chatEditing.acceptFile',
    ];
  }

  getRejectCommands(): string[] {
    return [
      'trae.reject',
      'trae.rejectAll',
      'trae.builder.reject',
    ];
  }

  getButtonSelectors(): ButtonSelectorConfig {
    return {
      containerSelectors: [
        'button',
        '[role="button"]',
        '.action-item a',
        '.builder-action-bar button',
        // Trae may render action buttons as <span> with Tailwind classes
        'span[class*="bg-ide-button"]',
        'span[class*="cursor-pointer"][class*="select-none"]',
      ],
      textPatterns: {
        [ButtonType.AcceptAll]: [/^accept\s*all$/i, /^approve\s*all$/i],
        [ButtonType.Accept]: [/^accept$/i, /^approve$/i],
        [ButtonType.Run]: [/^run$/i, /^execute$/i, /^run\s+command$/i],
        [ButtonType.Retry]: [/^retry$/i, /^try\s*again$/i],
        [ButtonType.Continue]: [/^continue$/i, /^yes$/i, /^proceed$/i],
        [ButtonType.Permission]: [/^allow$/i, /^trust$/i, /^enable$/i],
        [ButtonType.Dismiss]: [/^ok$/i, /^dismiss$/i, /^got\s*it$/i],
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
          (t.url.includes('workbench') || t.title.includes('Trae')))),
    );
  }
}

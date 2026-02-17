/**
 * VSCodeCopilotAdapter — IDE adapter for VS Code with GitHub Copilot
 *
 * Fallback adapter for vanilla VS Code:
 * - editor.action.inlineSuggest.commit for inline suggestions
 * - github.copilot.* commands for Copilot panel
 * - Generic button patterns (Accept/Run)
 * - CDP port 9229
 */

import { BaseIDEAdapter } from './base-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonType,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';

export class VSCodeCopilotAdapter extends BaseIDEAdapter {
  readonly id = IDEType.VSCode;
  readonly displayName = 'VS Code (Copilot)';
  readonly defaultCDPPort = 9229;
  readonly launchFlag = '--remote-debugging-port=9229';

  getAcceptCommands(): string[] {
    return [
      'editor.action.inlineSuggest.commit',
      'github.copilot.acceptCursorPanelSolution',
      'github.copilot.acceptSuggestion',
      'chatEditing.acceptAllFiles',
      'chatEditing.acceptFile',
    ];
  }

  getRejectCommands(): string[] {
    return [
      'editor.action.inlineSuggest.hide',
      'github.copilot.dismissSuggestion',
    ];
  }

  getButtonSelectors(): ButtonSelectorConfig {
    return {
      containerSelectors: [
        'button',
        '[role="button"]',
        '.action-item a',
        // VS Code may render action buttons as <span> with Tailwind classes
        'span[class*="bg-ide-button"]',
        'span[class*="cursor-pointer"][class*="select-none"]',
      ],
      textPatterns: {
        [ButtonType.AcceptAll]: [/^accept\s*all$/i],
        [ButtonType.Accept]: [/^accept$/i],
        [ButtonType.Run]: [/^run$/i, /^run\s+command$/i],
        [ButtonType.Retry]: [/^retry$/i, /^try\s*again$/i],
        [ButtonType.Continue]: [/^continue$/i, /^yes$/i],
        [ButtonType.Permission]: [/^allow$/i, /^trust$/i],
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
         (t.type === 'page' && t.url.includes('workbench'))),
    );
  }
}

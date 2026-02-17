/**
 * AntigravityAdapter — IDE adapter for Antigravity AI IDE
 *
 * Extends BaseIDEAdapter with:
 * - Dual-approach: 16+ VS Code internal commands + CDP button detection
 * - Retry patterns for 429, model overloaded, network timeout
 * - Permission patterns for outside-workspace file access
 */

import { BaseIDEAdapter } from './base-adapter';
import { IDEType } from '../../domain/enums';
import {
  ButtonSelectorConfig,
  ButtonType,
  PermissionPattern,
} from '../../domain/types/button';
import { CDPTarget } from '../../domain/types/connection';
import * as vscode from 'vscode';

export class AntigravityAdapter extends BaseIDEAdapter {
  readonly id = IDEType.Antigravity;
  readonly displayName = 'Antigravity';
  readonly defaultCDPPort = 9004;
  readonly launchFlag = '--remote-debugging-port=9004';

  // ── Approach 1: VS Code Commands API ──────────────

  getAcceptCommands(): string[] {
    return [
      // ── TIER 1: Confirmed working (Reddit + Munkhin community) ──
      'antigravity.agent.acceptAgentStep',     // Chat panel — accept current agent step
      'antigravity.command.accept',            // Inline command accept
      'antigravity.terminalCommand.accept',    // Terminal command suggestion accept
      // ── Chat editing: Accept file changes in chat panel ──
      'chatEditing.acceptAllFiles',            // Accept all file diffs in chat panel
    ];
  }

  /** All candidate commands including unverified — for discovery */
  getAllCandidateCommands(): string[] {
    return [
      ...this.getAcceptCommands(),
      // ── TIER 2: May exist in some versions — validated at startup ──
      'antigravity.prioritized.agentAcceptAllInFile',
      'antigravity.prioritized.agentAcceptFocusedHunk',
      'antigravity.prioritized.supercompleteAccept',
      'antigravity.acceptCompletion',
      'antigravity.prioritized.terminalSuggestion.accept',
      'antigravity.action.acceptStep',
      // ── Chat editing candidates ──
      'chatEditing.acceptFile',                // Accept single file diff
      'chatEditor.action.acceptHunk',          // Accept single code block
    ];
  }

  getRejectCommands(): string[] {
    return [
      'antigravity.agent.rejectAgentStep',
      'antigravity.command.reject',
      'antigravity.prioritized.agentRejectFocusedHunk',
    ];
  }

  // ── Approach 2: CDP DOM button detection ──────────

  getButtonSelectors(): ButtonSelectorConfig {
    return {
      containerSelectors: [
        'button',
        '[role="button"]',
        'a[class*="button"]',
        '.action-item a',
        // Antigravity renders Accept/Reject as <span> with Tailwind classes
        'span[class*="bg-ide-button"]',
        '.bg-ide-button-background',
        'span[class*="cursor-pointer"][class*="select-none"]',
      ],
      textPatterns: {
        // Broad matching: open-source repos use includes() not strict anchors.
        // Relaxed patterns catch button text variations across Antigravity versions.
        [ButtonType.AcceptAll]: [/accept\s*all/i, /keep\s*all/i, /apply\s*all/i],
        [ButtonType.Accept]: [/^accept$/i, /accept\s+this/i, /^apply$/i, /^save$/i, /^approve$/i, /^overwrite$/i],
        [ButtonType.Run]: [/^run$/i, /run\s+(command|all)/i, /^execute$/i],
        [ButtonType.Retry]: [/^retry$/i, /try\s*again/i, /^please\s*(try\s*again|retry)$/i],
        [ButtonType.Continue]: [/^continue$/i, /^proceed$/i, /^yes$/i, /^confirm$/i],
        [ButtonType.Permission]: [
          /^allow$/i,
          /allow\s+once/i,
          /allow\s+this/i,
          /^trust$/i,
          /^enable$/i,
          /^install$/i,
          /^update$/i,
        ],
        [ButtonType.Dismiss]: [/^ok$/i, /got\s*it/i, /^dismiss$/i, /^deny$/i],
      },
      classPatterns: {
        [ButtonType.AcceptAll]: [/bg-ide-button/i],
        [ButtonType.Accept]: [/bg-ide-button-bac/i, /hover:bg-ide-button-hover/i],
        [ButtonType.Run]: [/bg-ide-button/i],
        [ButtonType.Retry]: [],
        [ButtonType.Continue]: [],
        [ButtonType.Permission]: [],
        [ButtonType.Dismiss]: [],
      },
    };
  }

  // ── Chat input ────────────────────────────────────

  getChatInputSelector(): string {
    return '[contenteditable="true"].cursor-text';
  }

  // ── Connection filtering ──────────────────────────

  filterTargets(targets: CDPTarget[]): CDPTarget[] {
    // Get current workspace name for multi-window session isolation.
    // When multiple IDE windows share the same CDP port, each workbench page
    // has a title like "{workspaceFolderName} - Antigravity". We MUST only
    // connect to OUR window's workbench — otherwise we click another window's buttons.
    const workspaceName = vscode.workspace.name ?? '';

    return targets.filter((t) => {
      if (!t.webSocketDebuggerUrl) return false;

      const urlLower = t.url.toLowerCase();

      // Exclude OUR OWN extension's webview panels (by URL only).
      // DO NOT filter by title — workspace folder names like "extension-auto-accept"
      // appear in the workbench page title, wrongly excluding the main target.
      if (
        urlLower.includes('domyh-auto-accept') ||
        urlLower.includes('domyh.auto-accept')
      ) {
        return false;
      }

      // Webview types: agent/chat panels — always include
      if (t.type === 'webview') return true;

      // Iframe types: chat webview panels — include for direct injection
      // The chat webview appears as type 'iframe' in Antigravity CDP
      if (t.type === 'iframe') return true;

      // Page type: include the MAIN WORKBENCH page.
      if (t.type === 'page') {
        if (!urlLower.includes('workbench')) return false;
        // Skip Launchpad — no useful UI for auto-accept
        const titleLower = (t.title || '').toLowerCase();
        if (titleLower === 'launchpad') return false;

        // ── Multi-window session isolation ──
        // Only include the workbench page that belongs to THIS window.
        // CDP target title format: "{workspaceFolderName} - Antigravity"
        // If we can't determine workspace name, include all (fallback for single-window).
        if (workspaceName) {
          const expectedPrefix = workspaceName.toLowerCase();
          if (!titleLower.startsWith(expectedPrefix)) {
            return false; // This workbench belongs to another window
          }
        }

        return true;
      }

      return false;
    });
  }

  // ── Permission patterns (Antigravity-specific) ────

  getPermissionPatterns(): PermissionPattern[] {
    return [
      {
        dialogTextPattern: /access\s*(to\s+)?files?\s*outside/i,
        allowButtonText: /^allow$/i,
        requiresConfig: true,
        configKey: 'autoAllowOutsideWorkspace',
      },
      {
        dialogTextPattern: /extension.*recommend/i,
        allowButtonText: /^dismiss$/i,
        requiresConfig: false,
      },
    ];
  }
  // ── Iframe patterns for CDP context targeting ──────

  getIframePatterns(): string[] {
    return [
      'cascade-panel',     // Agent panel iframe (cascade-panel.html)
      'agentPanel',        // Iframe ID attribute
      'chat-panel',        // Alternative chat panel name
      'antigravity.agent', // Webview panel origin prefix
    ];
  }
}

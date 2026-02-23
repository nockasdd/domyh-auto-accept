/**
 * NotificationManager — Centralized notification handling
 *
 * Subscribes to EventBus events and shows VS Code notifications.
 * Extracts notification logic from extension.ts into a dedicated manager.
 */

import * as vscode from 'vscode';
import { IEventBus } from '../domain/interfaces/event-bus';
import { DisposableStore } from '../core/disposable';
import { Logger } from '../core/logger';

export class NotificationManager {
  constructor(
    eventBus: IEventBus,
    logger: Logger,
    disposables: DisposableStore,
  ) {
    // Death loop detected — critical warning
    disposables.add(
      eventBus.on('engine:deathLoopDetected', () => {
        vscode.window
          .showWarningMessage(
            '⚠️ Death loop detected! Auto-accept paused for cooldown.',
            'Reset Counter',
          )
          .then((action) => {
            if (action === 'Reset Counter') {
              vscode.commands.executeCommand('domyh-auto-accept.resetRetry');
            }
          });
        logger.warn('Death loop notification shown');
      }),
    );

    // Queue completed — info
    disposables.add(
      eventBus.on('scheduler:completed', () => {
        vscode.window.showInformationMessage(
          '✅ Prompt queue completed!',
        );
      }),
    );

    // Prompt sent — log only (avoid notification spam)
    disposables.add(
      eventBus.on('scheduler:promptSent', ({ text }: { text: string; target: string }) => {
        const preview = text.length > 50
          ? text.substring(0, 50) + '...'
          : text;
        logger.info(`Prompt sent: ${preview}`);
      }),
    );

    // Permission auto-allowed — REMOVED: event never emitted (see audit_2026-02-23)
    // If implementing auto-allow feature, re-enable this subscription

    // Command blocked by safety guard
    disposables.add(
      eventBus.on('engine:commandBlocked', ({ command, pattern }: { command: string; pattern: string }) => {
        vscode.window.showWarningMessage(
          `🛡️ Blocked: "${command}" — matched pattern: ${pattern}`,
        );
        logger.warn(`Command blocked: ${command} — pattern: ${pattern}`);
      }),
    );
  }
}

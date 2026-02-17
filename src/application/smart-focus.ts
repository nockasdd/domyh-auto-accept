/**
 * SmartFocus — Auto-toggle auto-accept based on focus context
 *
 * Enables auto-accept when editor or terminal is focused.
 * Disables when chat/sidebar is focused.
 * Prevents accidental execution during chat input.
 *
 * v2: Tracks editor/terminal/other state to prevent terminal→null
 *     from incorrectly disabling auto-accept.
 */

import * as vscode from 'vscode';
import { IEventBus } from '../domain/interfaces/event-bus';
import { Logger } from '../core/logger';
import { DisposableStore } from '../core/disposable';

type FocusState = 'editor' | 'terminal' | 'other';

export class SmartFocus {
  private enabled = false;
  private autoAcceptEnabled = true;
  private focusState: FocusState = 'editor';
  private disposables = new DisposableStore();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
  ) {}

  /** Start monitoring focus */
  start(): void {
    if (this.enabled) return;
    this.enabled = true;

    this.disposables.add(
      vscode.window.onDidChangeActiveTerminal((term) => {
        if (term) {
          this.focusState = 'terminal';
          this.setAutoAccept(true, 'Terminal focused → auto-accept ON');
        }
      }),
    );

    this.disposables.add(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.focusState = 'editor';
          this.setAutoAccept(true, 'Editor focused → auto-accept ON');
        } else if (this.focusState !== 'terminal') {
          // No editor AND not in terminal → likely chat panel or sidebar
          this.focusState = 'other';
          this.setAutoAccept(false, 'Chat/sidebar focused → auto-accept OFF');
        }
        // If focusState is 'terminal', keep auto-accept ON
        // (terminal focus fires onDidChangeActiveTerminal, not this event)
      }),
    );

    this.logger.info('Smart Focus monitoring started');
  }

  /** Stop monitoring */
  stop(): void {
    this.enabled = false;
    this.disposables.dispose();
    this.disposables = new DisposableStore(); // Fresh store for next start()
    this.logger.info('Smart Focus monitoring stopped');
  }

  /** Whether auto-accept should be active based on focus */
  get shouldAutoAccept(): boolean {
    return this.autoAcceptEnabled;
  }

  /** Current focus state for debugging */
  get currentFocusState(): FocusState {
    return this.focusState;
  }

  dispose(): void {
    this.stop();
  }

  private setAutoAccept(value: boolean, reason: string): void {
    if (this.autoAcceptEnabled === value) return;
    this.autoAcceptEnabled = value;

    if (value) {
      this.eventBus.emit('focus:autoEnabled', { reason });
      this.logger.debug(`Smart Focus: ON — ${reason}`);
    } else {
      this.eventBus.emit('focus:autoDisabled', { reason });
      this.logger.debug(`Smart Focus: OFF — ${reason}`);
    }
  }
}

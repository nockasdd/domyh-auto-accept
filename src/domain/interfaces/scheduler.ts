/**
 * IScheduler — Prompt scheduling interface
 *
 * SRP: Only manages when and what prompts to send.
 * OCP: New schedule modes can be added without modifying existing code.
 */

import { Disposable } from 'vscode';

export interface IScheduler extends Disposable {
  /** Whether the scheduler is currently active */
  readonly isActive: boolean;
  /** Current queue index (for queue mode) */
  readonly currentIndex: number;
  /** Total items in queue */
  readonly queueLength: number;

  /** Start the scheduler */
  start(): void;
  /** Stop the scheduler */
  stop(): void;
  /** Pause the scheduler (queue mode) */
  pause(): void;
  /** Resume the scheduler (queue mode) */
  resume(): void;
  /** Skip current prompt (queue mode) */
  skip(): void;

  /** Get the next prompt to send */
  getNextPrompt(): string | null;
  /** Report that the current task has completed (silence detected) */
  onTaskCompleted(): void;
}

/**
 * IEventBus — Strongly-typed event system
 *
 * Observer pattern for decoupled communication between engine, UI, and services.
 */

import { Disposable } from 'vscode';
import { EventMap } from '../types/events';

export interface IEventBus extends Disposable {
  /** Emit a typed event */
  emit<T extends keyof EventMap>(event: T, data: EventMap[T]): void;

  /** Subscribe to a typed event, returns disposable to unsubscribe */
  on<T extends keyof EventMap>(
    event: T,
    handler: (data: EventMap[T]) => void,
  ): Disposable;

  /** Subscribe to a typed event, fires only once */
  once<T extends keyof EventMap>(
    event: T,
    handler: (data: EventMap[T]) => void,
  ): Disposable;
}

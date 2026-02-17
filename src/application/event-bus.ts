/**
 * TypedEventBus — Strongly-typed event system implementation
 *
 * Observer pattern for decoupled communication.
 * All events are compile-time type-checked via EventMap.
 */

import { Disposable } from 'vscode';
import { IEventBus } from '../domain/interfaces/event-bus';
import { EventMap } from '../domain/types/events';

type Handler<T> = (data: T) => void;

export class TypedEventBus implements IEventBus {
  private readonly handlers = new Map<string, Set<Handler<unknown>>>();

  emit<T extends keyof EventMap>(event: T, data: EventMap[T]): void {
    const set = this.handlers.get(event as string);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[EventBus] Error in handler for '${String(event)}':`, err);
      }
    }
  }

  on<T extends keyof EventMap>(
    event: T,
    handler: (data: EventMap[T]) => void,
  ): Disposable {
    const key = event as string;
    if (!this.handlers.has(key)) {
      this.handlers.set(key, new Set());
    }
    const set = this.handlers.get(key)!;
    const h = handler as Handler<unknown>;
    set.add(h);

    return {
      dispose: () => {
        set.delete(h);
        if (set.size === 0) {
          this.handlers.delete(key);
        }
      },
    };
  }

  once<T extends keyof EventMap>(
    event: T,
    handler: (data: EventMap[T]) => void,
  ): Disposable {
    const disposable = this.on(event, (data) => {
      disposable.dispose();
      handler(data);
    });
    return disposable;
  }

  dispose(): void {
    this.handlers.clear();
  }
}

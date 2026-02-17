import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TypedEventBus } from '../src/application/event-bus';

describe('TypedEventBus', () => {
  let bus: TypedEventBus;

  beforeEach(() => {
    bus = new TypedEventBus();
  });

  it('should emit and receive events', () => {
    const handler = vi.fn();
    bus.on('engine:statsUpdated', handler);

    const stats = {
      totalClicks: 10,
      blockedCommands: 2,
      retriesAttempted: 1,
      promptsSent: 0,
      estimatedTimeSaved: 30,
      sessionStartTime: Date.now(),
      lastClickTime: Date.now(),
      clicksByType: { accept: 8, retry: 2 },
    };

    bus.emit('engine:statsUpdated', stats);
    expect(handler).toHaveBeenCalledWith(stats);
  });

  it('should support multiple handlers for same event', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('engine:deathLoopReset', h1);
    bus.on('engine:deathLoopReset', h2);

    bus.emit('engine:deathLoopReset', undefined as any);
    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe when dispose is called', () => {
    const handler = vi.fn();
    const sub = bus.on('engine:deathLoopReset', handler);

    sub.dispose();
    bus.emit('engine:deathLoopReset', undefined as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should not throw when emitting with no handlers', () => {
    expect(() => bus.emit('engine:deathLoopReset', undefined as any)).not.toThrow();
  });

  it('should isolate different event types', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('engine:deathLoopReset', h1);
    bus.on('engine:deathLoopDetected', h2);

    bus.emit('engine:deathLoopReset', undefined as any);
    expect(h1).toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('should pass correct event data', () => {
    const handler = vi.fn();
    bus.on('engine:deathLoopDetected', handler);

    bus.emit('engine:deathLoopDetected', { retryCount: 5, windowSeconds: 60 });
    expect(handler).toHaveBeenCalledWith({ retryCount: 5, windowSeconds: 60 });
  });
});

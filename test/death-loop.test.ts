import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { DeathLoopGuard } from '../src/application/death-loop-guard';
import { TypedEventBus } from '../src/application/event-bus';
import { Logger } from '../src/core/logger';

describe('DeathLoopGuard', () => {
  let guard: DeathLoopGuard;
  let eventBus: TypedEventBus;
  let logger: Logger;
  const defaultConfig = {
    enabled: true,
    maxRetries: 5,
    windowSeconds: 60,
    cooldownSeconds: 120,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventBus();
    logger = new Logger();
    guard = new DeathLoopGuard(defaultConfig, eventBus, logger);
  });

  afterEach(() => {
    guard.dispose();
    vi.useRealTimers();
  });

  it('should allow retries below threshold', () => {
    expect(guard.paused).toBe(false);
    expect(guard.recordRetry()).toBe(true);  // allowed
    expect(guard.recordRetry()).toBe(true);  // still allowed
    expect(guard.paused).toBe(false);
  });

  it('should block after exceeding max retries in window', () => {
    // maxRetries=5, so the 6th retry should trigger death loop
    for (let i = 0; i < defaultConfig.maxRetries; i++) {
      guard.recordRetry();
    }
    // The (maxRetries+1)th call triggers the loop
    const result = guard.recordRetry();
    expect(result).toBe(false);
    expect(guard.paused).toBe(true);
  });

  it('should emit engine:deathLoopDetected event when triggered', () => {
    const handler = vi.fn();
    eventBus.on('engine:deathLoopDetected', handler);

    // Fill up to max then one more
    for (let i = 0; i <= defaultConfig.maxRetries; i++) {
      guard.recordRetry();
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        windowSeconds: defaultConfig.windowSeconds,
      }),
    );
  });

  it('should reset guard state', () => {
    for (let i = 0; i <= defaultConfig.maxRetries; i++) {
      guard.recordRetry();
    }
    expect(guard.paused).toBe(true);

    guard.reset();
    expect(guard.paused).toBe(false);
  });

  it('should emit engine:deathLoopReset event on reset', () => {
    const handler = vi.fn();
    eventBus.on('engine:deathLoopReset', handler);

    guard.reset();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should auto-unblock after cooldown period', () => {
    for (let i = 0; i <= defaultConfig.maxRetries; i++) {
      guard.recordRetry();
    }
    expect(guard.paused).toBe(true);

    // Advance time past cooldown
    vi.advanceTimersByTime(defaultConfig.cooldownSeconds * 1000 + 100);
    expect(guard.paused).toBe(false);
  });

  it('should track retries within sliding window only', () => {
    guard.recordRetry();
    guard.recordRetry();

    // Advance time past the window
    vi.advanceTimersByTime(defaultConfig.windowSeconds * 1000 + 100);

    // New window — retries should be allowed again
    expect(guard.recordRetry()).toBe(true);
    expect(guard.paused).toBe(false);
  });

  it('should record success and reset consecutive errors', () => {
    guard.recordRetry();
    guard.recordRetry();
    guard.recordSuccess();
    // After success, consecutive counter resets — still should be allowed
    expect(guard.recordRetry()).toBe(true);
  });
});

/**
 * DeathLoopGuard — Prevents infinite retry cycles
 *
 * Tracks retry attempts within a sliding window.
 * If retries exceed max within window → pause auto-retry and notify user.
 */

import { IEventBus } from '../domain/interfaces/event-bus';
import { AutoRetryConfig } from '../domain/types/config';
import { Logger } from '../core/logger';

export class DeathLoopGuard {
  private retryTimestamps: number[] = [];
  private consecutiveErrors = 0;
  private isPaused = false;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: AutoRetryConfig,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
  ) { }

  /** Record a retry attempt. Returns true if retry is allowed. */
  recordRetry(): boolean {
    if (this.isPaused) {
      this.logger.debug('Death loop guard: retry blocked (paused)');
      return false;
    }

    const now = Date.now();
    this.retryTimestamps.push(now);
    this.consecutiveErrors++;

    // Clean old timestamps outside window
    const windowStart = now - this.config.windowSeconds * 1000;
    this.retryTimestamps = this.retryTimestamps.filter((t) => t > windowStart);

    // Check if we've exceeded the limit
    if (this.retryTimestamps.length > this.config.maxRetries) {
      this.triggerDeathLoop();
      return false;
    }

    // Check consecutive errors (no successful clicks between retries)
    if (this.consecutiveErrors > 5) {
      this.logger.warn('5+ consecutive errors — consider switching model or waiting');
    }

    return true;
  }

  /** Record a successful action (resets consecutive error counter) */
  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  /** Manually reset the guard */
  reset(): void {
    this.retryTimestamps = [];
    this.consecutiveErrors = 0;
    this.isPaused = false;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.eventBus.emit('engine:deathLoopReset', undefined);
    this.logger.info('Death loop guard reset');
  }

  /** Whether the guard is currently blocking retries */
  get paused(): boolean {
    return this.isPaused;
  }

  dispose(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  private triggerDeathLoop(): void {
    this.isPaused = true;
    this.logger.error(
      `Death loop detected! ${this.retryTimestamps.length} retries in ${this.config.windowSeconds}s window. ` +
      `Auto-retry paused for ${this.config.cooldownSeconds}s.`,
    );

    this.eventBus.emit('engine:deathLoopDetected', {
      retryCount: this.retryTimestamps.length,
      windowSeconds: this.config.windowSeconds,
    });

    // Auto-resume after cooldown
    this.cooldownTimer = setTimeout(() => {
      this.isPaused = false;
      this.retryTimestamps = [];
      this.consecutiveErrors = 0;
      this.logger.info('Death loop cooldown expired. Auto-retry resumed.');
      this.eventBus.emit('engine:deathLoopReset', undefined);
    }, this.config.cooldownSeconds * 1000);
  }
}

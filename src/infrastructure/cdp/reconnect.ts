/**
 * ReconnectStrategy — Exponential backoff with jitter
 *
 * Config: baseDelay=200ms, maxDelay=10s, multiplier=2.0, jitter=20%, maxRetries=5
 * Sequence: 200ms → 400ms → 800ms → 1600ms → 3200ms → give up
 */

import { ReconnectConfig } from '../../domain/types/connection';

/** Default reconnection configuration */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  baseDelayMs: 200,
  maxDelayMs: 10_000,
  multiplier: 2.0,
  jitterPercent: 20,
  maxRetries: 5,
};

export class ReconnectStrategy {
  private attempt = 0;
  private readonly config: ReconnectConfig;

  constructor(config: Partial<ReconnectConfig> = {}) {
    this.config = { ...DEFAULT_RECONNECT_CONFIG, ...config };
  }

  /** Get the delay for the next retry attempt, or null if max retries exceeded */
  nextDelay(): number | null {
    if (this.attempt >= this.config.maxRetries) {
      return null;
    }
    const baseDelay = Math.min(
      this.config.baseDelayMs * Math.pow(this.config.multiplier, this.attempt),
      this.config.maxDelayMs,
    );
    const jitter = baseDelay * (this.config.jitterPercent / 100);
    const delay = baseDelay + (Math.random() * 2 - 1) * jitter;
    this.attempt++;
    return Math.max(0, Math.round(delay));
  }

  /** Get current attempt number */
  get currentAttempt(): number {
    return this.attempt;
  }

  /** Reset attempt counter (call after successful connection) */
  reset(): void {
    this.attempt = 0;
  }

  /** Whether we've exceeded max retries */
  get exhausted(): boolean {
    return this.attempt >= this.config.maxRetries;
  }
}

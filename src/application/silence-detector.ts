/**
 * SilenceDetector — Monitors click activity to detect agent idle periods
 *
 * SRP: Only monitors click activity via Engine stats events.
 * Used by Scheduler to know when a task is complete and the next prompt can be sent.
 *
 * Algorithm:
 * 1. Subscribe to `engine:statsUpdated` events
 * 2. If clicks changed → update lastActivityTime
 * 3. Poll every 5s: if elapsed >= minRuntime AND silence >= silenceTimeout → fire onSilence
 */

import { IEventBus } from '../domain/interfaces/event-bus';
import { SessionStats } from '../domain/types/stats';
import { Logger } from '../core/logger';
import { DisposableStore } from '../core/disposable';

/** Configuration for silence detection */
export interface SilenceConfig {
  /** Seconds of no click activity to consider task complete */
  readonly silenceTimeoutSec: number;
  /** Minimum seconds to wait before checking for silence (avoids false positives) */
  readonly minRuntimeSec: number;
  /** Polling interval in milliseconds */
  readonly pollIntervalMs: number;
}

const DEFAULT_CONFIG: SilenceConfig = {
  silenceTimeoutSec: 30,
  minRuntimeSec: 10,
  pollIntervalMs: 5_000,
};

export class SilenceDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastClickCount = 0;
  private lastActivityTime = 0;
  private taskStartTime = 0;
  private onSilenceCallback: (() => void) | null = null;
  private config: SilenceConfig = DEFAULT_CONFIG;
  private readonly disposables = new DisposableStore();

  constructor(
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
  ) {}

  /**
   * Start monitoring for silence after a prompt is sent.
   * Calls `onSilence` when the agent appears to have completed its task.
   */
  startMonitoring(
    config: Partial<SilenceConfig>,
    onSilence: () => void,
  ): void {
    this.stopMonitoring();

    this.config = { ...DEFAULT_CONFIG, ...config };
    this.onSilenceCallback = onSilence;
    this.taskStartTime = Date.now();
    this.lastActivityTime = Date.now();
    this.lastClickCount = 0;

    this.logger.debug(
      `[SilenceDetector] Started monitoring (timeout=${this.config.silenceTimeoutSec}s, minRuntime=${this.config.minRuntimeSec}s)`,
    );

    // Subscribe to engine stats updates to track click activity
    this.disposables.add(
      this.eventBus.on('engine:statsUpdated', (stats: SessionStats) => {
        if (stats.totalClicks > this.lastClickCount) {
          this.lastClickCount = stats.totalClicks;
          this.lastActivityTime = Date.now();
          this.logger.debug(`[SilenceDetector] Activity detected: ${stats.totalClicks} total clicks`);
        }
      }),
    );

    // Poll periodically to check silence conditions
    this.pollTimer = setInterval(() => {
      this.poll();
    }, this.config.pollIntervalMs);
  }

  /** Stop monitoring */
  stopMonitoring(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.onSilenceCallback = null;
    this.logger.debug('[SilenceDetector] Stopped monitoring');
  }

  /** Whether monitoring is active */
  get isMonitoring(): boolean {
    return this.pollTimer !== null;
  }

  /** Current silence duration in seconds */
  get silenceDurationSec(): number {
    if (!this.lastActivityTime) return 0;
    return Math.floor((Date.now() - this.lastActivityTime) / 1_000);
  }

  /** How long the current task has been running in seconds */
  get runtimeSec(): number {
    if (!this.taskStartTime) return 0;
    return Math.floor((Date.now() - this.taskStartTime) / 1_000);
  }

  // ────────────────────────────────────────────────────

  private poll(): void {
    // Check silence conditions based on lastActivityTime
    const now = Date.now();
    const runtimeMs = now - this.taskStartTime;
    const silenceMs = now - this.lastActivityTime;
    const minRuntimeMs = this.config.minRuntimeSec * 1_000;
    const silenceTimeoutMs = this.config.silenceTimeoutSec * 1_000;

    if (runtimeMs >= minRuntimeMs && silenceMs >= silenceTimeoutMs) {
      this.logger.info(
        `[SilenceDetector] Silence detected after ${Math.floor(silenceMs / 1_000)}s ` +
        `(runtime: ${Math.floor(runtimeMs / 1_000)}s)`,
      );
      const callback = this.onSilenceCallback;
      this.stopMonitoring();
      callback?.();
    }
  }

  dispose(): void {
    this.stopMonitoring();
    this.disposables.dispose();
  }
}

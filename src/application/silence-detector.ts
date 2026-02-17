/**
 * SilenceDetector — Monitors CDP click state to detect agent idle periods
 *
 * SRP: Only monitors click activity via CDP evaluation.
 * Used by Scheduler to know when a task is complete and the next prompt can be sent.
 *
 * Algorithm:
 * 1. Poll `window.__autoAcceptState.clicks` via CDP every 5s
 * 2. If clicks changed → update lastActivityTime
 * 3. If elapsed >= minRuntime AND silence >= silenceTimeout → fire onSilence
 */

import { ICDPConnector } from '../domain/interfaces/cdp-connector';
import { Logger } from '../core/logger';

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

/** Result from reading CDP click state */
interface ClickState {
  clicks: number;
  lastClick: number;
}

export class SilenceDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastClickCount = 0;
  private lastActivityTime = 0;
  private taskStartTime = 0;
  private onSilenceCallback: (() => void) | null = null;
  private config: SilenceConfig = DEFAULT_CONFIG;

  constructor(
    private readonly cdp: ICDPConnector,
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

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        this.logger.warn(`[SilenceDetector] Poll error: ${err}`);
      });
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

  private async poll(): Promise<void> {
    try {
      const result = await this.cdp.evaluate(
        'JSON.stringify({ clicks: window.__autoAcceptState?.clicks || 0, lastClick: window.__autoAcceptState?.lastClick || 0 })',
        3_000,
      );

      if (!result.success || typeof result.value !== 'string') {
        return; // CDP not connected or no state — skip this poll
      }

      let state: ClickState;
      try {
        state = JSON.parse(result.value as string);
      } catch {
        return; // Malformed response — skip
      }

      // Detect activity
      if (state.clicks > this.lastClickCount) {
        this.lastClickCount = state.clicks;
        this.lastActivityTime = Date.now();
        this.logger.debug(`[SilenceDetector] Activity detected: ${state.clicks} total clicks`);
        return;
      }

      // Check silence conditions
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
    } catch (err) {
      // CDP may be disconnected — continue polling until stopped
      this.logger.debug(`[SilenceDetector] CDP error during poll: ${err}`);
    }
  }

  dispose(): void {
    this.stopMonitoring();
  }
}

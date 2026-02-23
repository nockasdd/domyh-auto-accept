/**
 * Scheduler — Prompt scheduling with 3 modes
 *
 * SRP: Manages when and what prompts to send.
 * OCP: New schedule modes can be added without modifying existing code.
 *
 * Modes:
 * - interval: Send a prompt every N minutes
 * - daily: Send a prompt at a specific time (HH:MM)
 * - queue: Sequential prompts with silence detection between them
 */


import { IScheduler } from '../domain/interfaces/scheduler';
import { ICDPConnector } from '../domain/interfaces/cdp-connector';
import { IEventBus } from '../domain/interfaces/event-bus';
import { QueueMode } from '../domain/enums';
import { ScheduleConfig } from '../domain/types/config';
import { ConfigReader } from '../core/config';
import { Logger } from '../core/logger';
import { PayloadManager } from '../infrastructure/cdp/payload-manager';
import { SilenceDetector } from './silence-detector';

export class Scheduler implements IScheduler {
  // ── IScheduler state ──────────────────────────────
  private _isActive = false;
  private _currentIndex = 0;
  private _isPaused = false;
  private _promptHistory: Array<{ text: string; sentAt: number; completedAt?: number }> = [];

  // ── Internal timers ───────────────────────────────
  private timer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private readonly silenceDetector: SilenceDetector;

  constructor(
    private readonly cdp: ICDPConnector,
    private readonly eventBus: IEventBus,
    private readonly payloads: PayloadManager,
    private readonly config: ConfigReader,
    private readonly logger: Logger,
  ) {
    this.silenceDetector = new SilenceDetector(eventBus, logger);
  }

  // ── IScheduler implementation ─────────────────────

  get isActive(): boolean {
    return this._isActive;
  }

  get currentIndex(): number {
    return this._currentIndex;
  }

  get queueLength(): number {
    return this.getScheduleConfig().prompts.length;
  }

  /** Start the scheduler based on config mode */
  start(): void {
    if (this._isActive) {
      this.logger.warn('[Scheduler] Already active, ignoring start()');
      return;
    }

    const scheduleConfig = this.getScheduleConfig();
    if (!scheduleConfig.enabled) {
      this.logger.info('[Scheduler] Schedule not enabled in config');
      return;
    }

    this._isActive = true;
    this._isPaused = false;
    this._currentIndex = 0;
    this.logger.info(`[Scheduler] Starting in ${scheduleConfig.mode} mode`);

    switch (scheduleConfig.mode) {
      case 'interval':
        this.startInterval(scheduleConfig);
        break;
      case 'daily':
        this.startDaily(scheduleConfig);
        break;
      case 'queue':
        this.startQueue(scheduleConfig);
        break;
      default:
        this.logger.error(`[Scheduler] Unknown mode: ${scheduleConfig.mode}`);
        this._isActive = false;
    }
  }

  /** Stop the scheduler and clear all timers */
  stop(): void {
    this.clearTimers();
    this.silenceDetector.stopMonitoring();
    this._isActive = false;
    this._isPaused = false;
    this.logger.info('[Scheduler] Stopped');
  }

  /** Pause the scheduler (queue mode only) */
  pause(): void {
    if (!this._isActive || this._isPaused) return;
    this._isPaused = true;
    this.silenceDetector.stopMonitoring();
    this.logger.info('[Scheduler] Paused');
  }

  /** Resume the scheduler (queue mode only) */
  resume(): void {
    if (!this._isActive || !this._isPaused) return;
    this._isPaused = false;
    this.logger.info('[Scheduler] Resumed');

    const scheduleConfig = this.getScheduleConfig();
    if (scheduleConfig.mode === 'queue') {
      // Re-send current prompt and restart silence monitoring
      this.executeQueueStep(scheduleConfig);
    }
  }

  /** Skip current prompt and advance to next (queue mode only) */
  skip(): void {
    if (!this._isActive) return;

    const scheduleConfig = this.getScheduleConfig();
    if (scheduleConfig.mode !== 'queue') {
      this.logger.warn('[Scheduler] skip() only works in queue mode');
      return;
    }

    this.silenceDetector.stopMonitoring();
    this.logger.info(`[Scheduler] Skipping prompt at index ${this._currentIndex}`);
    this.advanceQueue(scheduleConfig);
  }

  /** Get the next prompt to send */
  getNextPrompt(): string | null {
    const scheduleConfig = this.getScheduleConfig();

    switch (scheduleConfig.mode) {
      case 'interval':
      case 'daily':
        return scheduleConfig.prompt || null;

      case 'queue': {
        const prompts = scheduleConfig.prompts;
        if (!prompts.length) return null;
        if (this._currentIndex >= prompts.length) return null;
        return prompts[this._currentIndex];
      }

      default:
        return null;
    }
  }

  /** Report that the current task has completed (called by silence detector) */
  onTaskCompleted(): void {
    if (!this._isActive) return;

    const scheduleConfig = this.getScheduleConfig();
    const lastEntry = this._promptHistory[this._promptHistory.length - 1];
    if (lastEntry && !lastEntry.completedAt) {
      lastEntry.completedAt = Date.now();
    }

    this.eventBus.emit('scheduler:silenceDetected', {
      duration: this.silenceDetector.silenceDurationSec,
    });

    if (scheduleConfig.mode === 'queue') {
      this.advanceQueue(scheduleConfig);
    }
  }

  /** Get prompt history */
  getHistory(): ReadonlyArray<{ text: string; sentAt: number; completedAt?: number }> {
    return this._promptHistory;
  }

  /** Whether the scheduler is paused */
  get isPaused(): boolean {
    return this._isPaused;
  }

  dispose(): void {
    this.stop();
    this.silenceDetector.dispose();
  }

  // ── Interval mode ─────────────────────────────────

  private startInterval(config: ScheduleConfig): void {
    const minutes = parseInt(config.value, 10);
    if (isNaN(minutes) || minutes <= 0) {
      this.logger.error(`[Scheduler] Invalid interval value: "${config.value}"`);
      this._isActive = false;
      return;
    }

    const intervalMs = minutes * 60_000;
    this.logger.info(`[Scheduler] Interval mode: every ${minutes} minutes`);

    // Send first prompt immediately
    this.sendPrompt(config.prompt);

    // Then repeat at interval
    this.intervalTimer = setInterval(() => {
      if (this._isPaused) return;
      this.sendPrompt(config.prompt);
    }, intervalMs);
  }

  // ── Daily mode ────────────────────────────────────

  private startDaily(config: ScheduleConfig): void {
    const match = config.value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      this.logger.error(`[Scheduler] Invalid daily value: "${config.value}" (expected HH:MM)`);
      this._isActive = false;
      return;
    }

    const targetHour = parseInt(match[1], 10);
    const targetMinute = parseInt(match[2], 10);

    if (targetHour < 0 || targetHour > 23 || targetMinute < 0 || targetMinute > 59) {
      this.logger.error(`[Scheduler] Invalid time: ${targetHour}:${targetMinute}`);
      this._isActive = false;
      return;
    }

    this.logger.info(`[Scheduler] Daily mode: at ${config.value}`);
    this.scheduleDailyTimer(targetHour, targetMinute, config);
  }

  private scheduleDailyTimer(hour: number, minute: number, config: ScheduleConfig): void {
    const now = new Date();
    const target = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      hour,
      minute,
      0,
      0,
    );

    // If target time has passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    const delayMs = target.getTime() - now.getTime();
    this.logger.debug(`[Scheduler] Next daily send in ${Math.floor(delayMs / 60_000)} minutes`);

    this.timer = setTimeout(() => {
      if (!this._isActive || this._isPaused) return;
      this.sendPrompt(config.prompt);

      // Re-schedule for next day
      this.scheduleDailyTimer(hour, minute, config);
    }, delayMs);
  }

  // ── Queue mode ────────────────────────────────────

  private startQueue(config: ScheduleConfig): void {
    if (!config.prompts.length) {
      this.logger.error('[Scheduler] Queue mode requires at least one prompt in prompts array');
      this._isActive = false;
      return;
    }

    this.logger.info(`[Scheduler] Queue mode: ${config.prompts.length} prompts, mode=${config.queueMode}`);
    this._currentIndex = 0;
    this.executeQueueStep(config);
  }

  private executeQueueStep(config: ScheduleConfig): void {
    const prompt = config.prompts[this._currentIndex];
    if (!prompt) {
      this.logger.warn(`[Scheduler] No prompt at index ${this._currentIndex}`);
      return;
    }

    // Send the prompt
    this.sendPrompt(prompt);

    // Emit queue advanced event
    this.eventBus.emit('scheduler:queueAdvanced', {
      index: this._currentIndex,
      total: config.prompts.length,
    });

    // Start monitoring for silence (task completion)
    this.silenceDetector.startMonitoring(
      {
        silenceTimeoutSec: config.silenceTimeout,
        minRuntimeSec: 10,
      },
      () => this.onTaskCompleted(),
    );
  }

  private advanceQueue(config: ScheduleConfig): void {
    const prompts = config.prompts;

    if (config.queueMode === QueueMode.Consume) {
      // Consume mode: advance index, stop when exhausted
      this._currentIndex++;
      if (this._currentIndex >= prompts.length) {
        this.logger.info('[Scheduler] Queue exhausted (consume mode)');
        this.eventBus.emit('scheduler:completed', { mode: config.queueMode });
        this.stop();
        return;
      }
    } else {
      // Loop mode: wrap around
      this._currentIndex = (this._currentIndex + 1) % prompts.length;
      if (this._currentIndex === 0) {
        this.logger.info('[Scheduler] Queue looped back to start');
      }
    }

    this.logger.info(`[Scheduler] Advancing to prompt ${this._currentIndex + 1}/${prompts.length}`);
    this.executeQueueStep(config);
  }

  // ── Prompt sending ────────────────────────────────

  private sendPrompt(text: string): void {
    if (!text.trim()) {
      this.logger.warn('[Scheduler] Empty prompt text, skipping');
      return;
    }

    this.logger.info(`[Scheduler] Sending prompt: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    // Record in history
    this._promptHistory.push({ text, sentAt: Date.now() });
    if (this._promptHistory.length > 50) {
      this._promptHistory.shift(); // Keep last 50
    }

    // Use PayloadManager to inject prompt via CDP
    // Use evaluateAll to ensure prompt reaches chat panel (may be in webview/iframe)
    const payload = this.payloads.getSendPrompt(text, '');
    this.cdp.evaluateAll(payload, 10_000).then((results) => {
      // Check if any target succeeded
      const success = results.some(r => r.success);
      if (success) {
        this.logger.info('[Scheduler] Prompt sent successfully');
        this.eventBus.emit('scheduler:promptSent', { text, target: 'cdp' });
      } else {
        const errors = results.map(r => r.error).filter(Boolean).join('; ');
        this.logger.error(`[Scheduler] Failed to send prompt to all targets: ${errors || 'unknown error'}`);
      }
    }).catch((err) => {
      this.logger.error(`[Scheduler] CDP error sending prompt: ${err}`);
    });
  }

  // ── Helpers ───────────────────────────────────────

  private getScheduleConfig(): ScheduleConfig {
    return this.config.getSchedule();
  }

  private clearTimers(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

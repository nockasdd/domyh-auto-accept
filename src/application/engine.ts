/**
 * AutoAcceptEngine — The core orchestrator
 *
 * Dual-approach: VS Code Commands API + CDP DOM injection.
 * Priority: Commands API (fast path) → CDP (background/retry fallback).
 *
 * State Machine: Idle → Starting → Connected → Polling → Error
 *
 * v2: Command discovery at startup, adaptive polling, toggle persistence,
 *     stats tracking for Commands API, DeathLoopGuard wiring.
 */

import * as vscode from 'vscode';
import { EngineState } from '../domain/enums';
import { IIDEAdapter } from '../domain/interfaces/ide-adapter';
import { ICDPConnector } from '../domain/interfaces/cdp-connector';
import { IEventBus } from '../domain/interfaces/event-bus';

import { ConnectionState } from '../domain/types/connection';
import { SessionStats, createSessionStats } from '../domain/types/stats';
import { ConfigReader } from '../core/config';
import { Logger } from '../core/logger';
import { DisposableStore } from '../core/disposable';
import { DeathLoopGuard } from './death-loop-guard';
import { SmartFocus } from './smart-focus';
import { PayloadManager } from '../infrastructure/cdp/payload-manager';
import { IDEDetector } from '../infrastructure/detection/ide-detector';

export class AutoAcceptEngine {
  private state = EngineState.Idle;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private cdpRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private cdpRetryAttempt = 0;
  private stats: SessionStats = createSessionStats();
  private readonly disposables = new DisposableStore();

  /** Commands validated to exist in the current IDE at startup */
  private validCommands: string[] = [];
  /** Commands safe to fire every poll (no-op when nothing pending) */
  private safeCommands: string[] = [];
  /** Commands that may cause side effects (fire only with CDP confirmation) */
  private contextualCommands: string[] = [];
  /** Track consecutive polls with no action for adaptive frequency */
  private consecutiveNoOps = 0;
  private currentPollMs = AutoAcceptEngine.FAST_POLL_MS;
  /** Diagnostic: total poll count for rate-limited logging */
  private pollCount = 0;
  /** Re-entrancy guard: prevent concurrent pollTick execution */
  private pollRunning = false;
  /** Startup grace: skip first N polls to let UI settle after toggle-ON */
  private startupGracePollsRemaining = 0;
  private static readonly FAST_POLL_MS = 800;
  private static readonly SLOW_POLL_MS = 2000;
  private static readonly NOOP_THRESHOLD = 10;
  private static readonly CDP_RETRY_MAX = 10;
  private static readonly CDP_RETRY_BASE_MS = 30_000;
  private static readonly CDP_RETRY_CAP_MS = 300_000;
  private static readonly STARTUP_GRACE_POLLS = 2;

  constructor(
    private readonly adapter: IIDEAdapter,
    private readonly cdp: ICDPConnector,
    private readonly eventBus: IEventBus,
    private readonly deathLoopGuard: DeathLoopGuard,
    private readonly smartFocus: SmartFocus | null,
    private readonly payloads: PayloadManager,
    private readonly config: ConfigReader,
    private readonly logger: Logger,
  ) {
    // Listen for CDP state changes
    this.disposables.add(
      cdp.onStateChange((newState) => {
        this.handleCDPStateChange(newState);
      }),
    );

    // Wire scheduler prompt events to session stats
    this.disposables.add(
      this.eventBus.on('scheduler:promptSent', () => {
        this.stats = {
          ...this.stats,
          promptsSent: this.stats.promptsSent + 1,
        };
        this.eventBus.emit('engine:statsUpdated', this.stats);
      }),
    );
  }

  /** Start the engine */
  async start(): Promise<void> {
    if (this.state === EngineState.Polling) {
      this.logger.info('Engine already running');
      return;
    }

    this.setState(EngineState.Starting);
    this.stats = createSessionStats();
    this.consecutiveNoOps = 0;

    // CRITICAL: Clear command arrays to prevent accumulation across restarts
    this.validCommands = [];
    this.safeCommands = [];
    this.contextualCommands = [];

    // Discover & validate commands at startup
    if (this.adapter.supportsCommandsAPI()) {
      await this.discoverCommands();
      this.splitCommandsByRisk();
      this.logger.info(
        `Commands API: ${this.safeCommands.length} safe, ${this.contextualCommands.length} contextual`,
      );
    }

    // Approach 2: Try CDP connection
    // Dynamic port discovery: process.argv → PID scan → DevToolsActivePort → port sweep → default
    const configPort = this.config.get<number>('cdpPort', 0);
    const detector = new IDEDetector();
    const discovered = await detector.discoverCDPPort(
      this.adapter.id,
      configPort || this.adapter.defaultCDPPort,
    );
    const port = discovered.port;
    this.logger.info(
      `CDP port resolved: ${port} (source: ${discovered.source}` +
      (discovered.validated ? ', validated ✓' : ', not validated') + ')',
    );

    try {
      // Dump ALL targets before filtering for diagnostic purposes
      const allTargets = await this.cdp.getTargets(port);
      this.logger.info(`CDP targets found (pre-filter): ${allTargets.length}`);
      for (const t of allTargets) {
        this.logger.info(`  [${t.type}] "${t.title}" — ${t.url.substring(0, 80)}${t.url.length > 80 ? '...' : ''}`);
      }

      await this.cdp.connect(port, (t) => this.adapter.filterTargets(t));
      this.setState(EngineState.Connected);
      this.logger.info(`CDP connected on port ${port}`);

      // Inject probe to verify connection
      if (this.payloads.has('probe')) {
        const probeResult = await this.cdp.evaluate(this.payloads.getProbe());
        if (probeResult.success) {
          this.logger.info(`Probe OK: ${JSON.stringify(probeResult.value)}`);
        }
      }

      // Enable Runtime events for iframe execution context tracking
      await this.cdp.enableRuntimeEvents();
      const iframePatterns = this.adapter.getIframePatterns?.() ?? [];
      if (iframePatterns.length > 0) {
        this.logger.info(`Iframe targeting enabled — patterns: ${iframePatterns.join(', ')}`);
      }

      // Start polling
      this.startPolling();
      this.startupGracePollsRemaining = AutoAcceptEngine.STARTUP_GRACE_POLLS;
    } catch {
      this.logger.warn(`CDP not available on port ${port} — running Commands API only`);

      // NOTE: CDP setup (argv.json + shortcut modification) is handled ONLY
      // in extension.ts with persistent globalState guard.
      // DO NOT show any setup prompt here — it causes infinite nag loop
      // because engine's in-memory flags reset on every IDE restart.

      // Still start polling — Commands API works without CDP
      this.startPolling();
      this.startupGracePollsRemaining = AutoAcceptEngine.STARTUP_GRACE_POLLS;
      this.startCDPRetry();
    }
  }

  /** Stop the engine */
  async stop(): Promise<void> {
    this.stopPolling();
    this.stopCDPRetry();
    await this.cdp.disconnect();
    this.setState(EngineState.Idle);
    this.logger.info(`Engine stopped. Session stats: ${this.stats.totalClicks} clicks`);
  }

  /** Get current engine state */
  getState(): EngineState {
    return this.state;
  }

  /** Get current session stats */
  getStats(): SessionStats {
    return { ...this.stats };
  }

  /** Toggle engine on/off — persists state to settings */
  async toggle(): Promise<boolean> {
    if (this.state === EngineState.Polling) {
      await this.stop();
      await this.config.set('enabled', false);
      return false;
    } else {
      await this.start();
      await this.config.set('enabled', true);
      return true;
    }
  }

  dispose(): void {
    this.stopPolling();
    this.stopCDPRetry();
    this.disposables.dispose();
  }

  // ── Private methods ────────────────────────────────

  /** Discover which accept commands actually exist in the current IDE */
  private async discoverCommands(): Promise<void> {
    try {
      const allCommands = await vscode.commands.getCommands(true);
      const commandSet = new Set(allCommands);

      // Start with confirmed commands
      const confirmedCommands = this.adapter.getAcceptCommands();

      // Also try candidate commands that may exist in some IDE versions
      const candidateCommands = 'getAllCandidateCommands' in this.adapter
        ? (this.adapter as { getAllCandidateCommands(): string[] }).getAllCandidateCommands()
        : confirmedCommands;

      this.validCommands = candidateCommands.filter(cmd => commandSet.has(cmd));

      if (this.validCommands.length === 0) {
        // Fallback: use confirmed commands even if not discovered
        // (some commands may not appear in getCommands but still work)
        this.validCommands = confirmedCommands;
        this.logger.warn(`No commands discovered — using ${confirmedCommands.length} confirmed commands as fallback`);
      } else {
        this.logger.info(`Discovered ${this.validCommands.length}/${candidateCommands.length} valid commands: ${this.validCommands.join(', ')}`);
      }
    } catch (err) {
      // Fallback on error
      this.validCommands = this.adapter.getAcceptCommands();
      this.logger.warn(`Command discovery failed, using ${this.validCommands.length} default commands: ${err}`);
    }
  }

  private startPolling(frequencyMs?: number): void {
    const frequency = frequencyMs ?? this.config.get<number>('pollFrequency', AutoAcceptEngine.FAST_POLL_MS);
    this.currentPollMs = frequency;
    this.setState(EngineState.Polling);
    this.logger.info(`Polling started (${frequency}ms interval)`);

    this.pollTimer = setInterval(() => {
      this.pollTick().catch((err) => {
        this.logger.error('Poll tick error', err);
      });
    }, frequency);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Retry CDP connection with exponential backoff + dynamic port re-discovery.
   * Sequence: 30s → 60s → 120s → 240s → 300s (cap) — max 10 attempts.
   * IMPORTANT: Re-discovers port on EVERY retry (not same stale port).
   */
  private startCDPRetry(): void {
    if (this.cdpRetryTimer) return; // already running
    this.cdpRetryAttempt = 0;
    this.scheduleCDPRetry();
  }

  private scheduleCDPRetry(): void {
    if (this.cdpRetryAttempt >= AutoAcceptEngine.CDP_RETRY_MAX) {
      this.logger.info(
        `CDP retry exhausted after ${this.cdpRetryAttempt} attempts — ` +
        `will connect automatically on next IDE restart`,
      );
      return;
    }

    const delay = Math.min(
      AutoAcceptEngine.CDP_RETRY_BASE_MS * Math.pow(2, this.cdpRetryAttempt),
      AutoAcceptEngine.CDP_RETRY_CAP_MS,
    );

    if (this.cdpRetryAttempt === 0) {
      this.logger.info(`CDP retry timer started (backoff from ${delay / 1000}s, max ${AutoAcceptEngine.CDP_RETRY_MAX} attempts)`);
    }

    this.cdpRetryTimer = setTimeout(async () => {
      this.cdpRetryAttempt++;

      try {
        if (this.cdp.state === ConnectionState.Connected) {
          this.stopCDPRetry();
          return;
        }

        // Re-discover port on each retry — port may have changed
        const detector = new IDEDetector();
        const configPort = this.config.get<number>('cdpPort', 0);
        const discovered = await detector.discoverCDPPort(
          this.adapter.id,
          configPort || this.adapter.defaultCDPPort,
        );

        this.logger.debug(
          `CDP retry #${this.cdpRetryAttempt}: trying port ${discovered.port} (${discovered.source})`,
        );

        await this.cdp.connect(discovered.port, (t) => this.adapter.filterTargets(t));
        this.setState(EngineState.Connected);
        this.logger.info(
          `CDP connected on retry #${this.cdpRetryAttempt} (port ${discovered.port}, source: ${discovered.source}) ✅`,
        );
        this.stopCDPRetry();

        // Inject probe to verify
        if (this.payloads.has('probe')) {
          const probeResult = await this.cdp.evaluate(this.payloads.getProbe());
          if (probeResult.success) {
            this.logger.info(`Probe OK after retry: ${JSON.stringify(probeResult.value)}`);
          }
        }

        // Switch to dual-approach polling mode
        this.setState(EngineState.Polling);
      } catch {
        // Expected during retry — log at DEBUG to avoid ERROR spam
        this.logger.debug(`CDP retry #${this.cdpRetryAttempt}: CDP not available yet`);
        // Schedule next attempt with longer delay
        this.scheduleCDPRetry();
      }
    }, delay);
  }

  /** Stop CDP retry timer */
  private stopCDPRetry(): void {
    if (this.cdpRetryTimer) {
      clearTimeout(this.cdpRetryTimer);
      this.cdpRetryTimer = null;
      this.cdpRetryAttempt = 0;
      this.logger.debug('CDP retry timer stopped');
    }
  }



  /** Single poll cycle — dual-approach */
  private async pollTick(): Promise<void> {
    // Re-entrancy guard: prevent concurrent ticks from setInterval
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      await this.pollTickInner();
    } finally {
      this.pollRunning = false;
    }
  }

  private async pollTickInner(): Promise<void> {
    // Smart focus gate
    if (this.smartFocus && !this.smartFocus.shouldAutoAccept) {
      return;
    }

    // Death loop guard gate
    if (this.deathLoopGuard.paused) {
      return;
    }

    // Startup grace period: skip first N polls to let UI settle after toggle-ON
    if (this.startupGracePollsRemaining > 0) {
      this.startupGracePollsRemaining--;
      this.logger.debug(`Startup grace: skipping poll (${this.startupGracePollsRemaining} remaining)`);
      return;
    }

    this.pollCount++;

    let cdpHadActivity = false;

    // ── CDP: Precision-targeted button clicking ──────────────────
    // The payload ONLY scans within chat panel + editor diff containers.
    // It does NOT scan the entire DOM — so it's safe to run every tick.
    if (this.cdp.state === ConnectionState.Connected) {
      cdpHadActivity = await this.executeCDP();
    }

    // ── Commands API ──────────────────────────────────────────────
    // Safe commands: fire only when CDP detected active content, OR in commands-only fallback
    if (this.adapter.supportsCommandsAPI() && this.safeCommands.length > 0) {
      if (cdpHadActivity) {
        // Dual-approach mode: CDP confirmed active buttons — safe to fire all commands
        await this.executeCommandSet(this.safeCommands);
      } else if (this.cdp.state !== ConnectionState.Connected) {
        // Commands-only fallback: fire ONLY chatEditing.* which are true no-ops
        const chatEditingOnly = this.safeCommands.filter(c => c.startsWith('chatEditing.'));
        if (chatEditingOnly.length > 0) {
          await this.executeCommandSet(chatEditingOnly);
        }
      }
    }

    // Contextual commands: ONLY fire when CDP confirmed active buttons
    // (e.g. acceptAgentStep opens Agent Manager when no step is active)
    if (cdpHadActivity && this.adapter.supportsCommandsAPI() && this.contextualCommands.length > 0) {
      this.logger.info(`[Poll #${this.pollCount}] CDP found buttons — firing ${this.contextualCommands.length} contextual commands`);
      await this.executeCommandSet(this.contextualCommands);
    }

    const hadActivity = cdpHadActivity;

    // Adaptive polling: slow down if idle, speed up on activity
    if (!hadActivity) {
      this.consecutiveNoOps++;
      // Slow down after NOOP_THRESHOLD consecutive idle polls
      if (
        this.consecutiveNoOps === AutoAcceptEngine.NOOP_THRESHOLD &&
        this.currentPollMs < AutoAcceptEngine.SLOW_POLL_MS
      ) {
        this.logger.debug(`Adaptive polling: slowing to ${AutoAcceptEngine.SLOW_POLL_MS}ms after ${this.consecutiveNoOps} idle polls`);
        this.stopPolling();
        this.startPolling(AutoAcceptEngine.SLOW_POLL_MS);
      }
    } else {
      // Speed back up on activity
      if (this.consecutiveNoOps >= AutoAcceptEngine.NOOP_THRESHOLD && this.currentPollMs > AutoAcceptEngine.FAST_POLL_MS) {
        this.logger.debug('Adaptive polling: speeding up to fast mode');
        this.stopPolling();
        this.startPolling(AutoAcceptEngine.FAST_POLL_MS);
      }
      this.consecutiveNoOps = 0;
    }
  }

  /**
   * REMOVED: buildPayloadConfig() was computing an 8-field config that was injected
   * into auto-accept.js but never consumed by the payload. Settings like bannedCommands,
   * autoAllowOutsideWorkspace, containerSelectors had NO effect.
   * TODO: When refactoring auto-accept.js to read dynamic config, re-implement this.
   */

  /**
   * Split validated commands into safe (no side effects) and contextual (may open UI).
   *
   * Safe commands are chatEditing.* and similar no-op-when-idle commands.
   * Contextual commands have side effects when fired without active content
   * (e.g. acceptAgentStep opens Agent Manager, autocomplete interferes with typing).
   */
  private splitCommandsByRisk(): void {
    // Clear before splitting to prevent duplicates on re-entry
    this.safeCommands = [];
    this.contextualCommands = [];

    const contextualPatterns = [
      'supercompleteAccept',   // Autocomplete — may interfere with typing
      'acceptCompletion',      // Autocomplete — may interfere with typing
      'acceptAgentStep',       // Opens Agent Manager when no step is pending
      'action.acceptStep',     // Same as above — may have side effects
      'antigravity.command.',   // Generic accept — can interact with any focused UI
      'antigravity.terminalCommand.',  // Terminal suggestion — side effects
      'antigravity.prioritized.',     // Agent actions — side effects when no agent step
    ];

    for (const cmd of this.validCommands) {
      if (contextualPatterns.some(p => cmd.includes(p))) {
        this.contextualCommands.push(cmd);
      } else {
        this.safeCommands.push(cmd);
      }
    }
  }

  /** Execute a specific set of commands in parallel */
  private async executeCommandSet(commands: string[]): Promise<void> {
    // Log on first poll and then every 50 polls for debugging
    if (this.pollCount <= 1 || this.pollCount % 50 === 0) {
      this.logger.info(`[Commands] Firing ${commands.length} commands: ${commands.join(', ')}`);
    }

    const results = await Promise.allSettled(
      commands.map(cmd => vscode.commands.executeCommand(cmd)),
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled').length;
    const rejected = results.filter(r => r.status === 'rejected').length;

    if (rejected > 0) {
      // Log individual failures for debugging
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          this.logger.warn(`[Commands] REJECTED: ${commands[i]} — ${r.reason}`);
        }
      });
      this.logger.info(`[Commands] ${fulfilled}/${commands.length} fulfilled, ${rejected} rejected`);
    }
  }

  /** Execute CDP payload for button clicking. Returns true if buttons were clicked. */
  private async executeCDP(): Promise<boolean> {
    try {
      if (!this.payloads.has('auto-accept')) return false;

      // TODO: Refactor auto-accept.js to consume dynamic config (bannedCommands, containerSelectors, etc.)
      const payload = this.payloads.getAutoAccept({});

      // Phase 1: Evaluate across ALL connected targets (pages + webviews)
      let totalClicks = 0;
      let totalBlocked = 0;
      let totalMatches = 0;
      let clickedType: string | null = null;

      const allResults = await this.cdp.evaluateAll(payload, 3000);
      for (const result of allResults) {
        if (result.success && result.value) {
          try {
            const data = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
            const clickData = data as { clicks?: number; blocked?: number; total?: number; clickedType?: string };
            totalClicks += clickData.clicks ?? 0;
            totalBlocked += clickData.blocked ?? 0;
            totalMatches += clickData.total ?? 0;
            if (clickData.clickedType && !clickedType) clickedType = clickData.clickedType;

            // Log Cursor dialog handling (usage limit, submit-previous, etc.)
            if (data.dialogAction) {
              this.logger.info(`[CDP] Cursor dialog: ${JSON.stringify(data.dialogAction)}`);
            }

            if ((clickData.total ?? 0) > 0) {
              this.logger.debug(`[CDP:target] ${clickData.total} matches, ${clickData.clicks} clicked`);
            }
          } catch (parseErr) {
            this.logger.debug(`[CDP:target] JSON parse error: ${parseErr}`);
          }
        }
      }

      // Phase 2: Fall back to iframe execution contexts if no clicks from targets
      if (totalClicks === 0) {
        const iframePatterns = this.adapter.getIframePatterns?.() ?? [];
        const iframeContexts = this.cdp.getIframeContexts(iframePatterns.length > 0 ? iframePatterns : undefined);

        for (const ctx of iframeContexts) {
          try {
            const iframeResult = await this.cdp.evaluateInContext(payload, ctx.contextId, 3000);
            if (iframeResult.success && iframeResult.value) {
              const data = typeof iframeResult.value === 'string' ? JSON.parse(iframeResult.value) : iframeResult.value;
              const clickData = data as { clicks: number; blocked: number; total: number; clickedType?: string };
              totalClicks += clickData.clicks;
              totalBlocked += clickData.blocked;
              totalMatches += clickData.total;
              if (clickData.clickedType && !clickedType) clickedType = clickData.clickedType;

              if (clickData.total > 0) {
                this.logger.debug(
                  `[CDP:iframe:${ctx.name || ctx.contextId}] ${clickData.total} matches, ${clickData.clicks} clicked`,
                );
              }

              // Stop scanning after first successful click in an iframe
              if (clickData.clicks > 0) break;
            }
          } catch (iframeErr) {
            // Iframe context may have been destroyed — skip silently
            this.logger.debug(`[CDP:iframe:${ctx.contextId}] eval error: ${iframeErr}`);
          }
        }
      }

      // Aggregate results
      this.logger.debug(
        `[CDP] Scan: ${totalMatches} matches, ${totalClicks} clicked` +
        (clickedType ? ` (${clickedType})` : '') +
        (totalBlocked > 0 ? `, ${totalBlocked} blocked` : ''),
      );

      if (totalClicks > 0) {
        const updatedClicksByType = { ...this.stats.clicksByType };
        if (clickedType) {
          updatedClicksByType[clickedType] = (updatedClicksByType[clickedType] || 0) + totalClicks;
        }
        this.stats = {
          ...this.stats,
          totalClicks: this.stats.totalClicks + totalClicks,
          lastClickTime: Date.now(),
          estimatedTimeSaved: this.stats.estimatedTimeSaved + totalClicks * 5,
          clicksByType: updatedClicksByType,
        };
        this.deathLoopGuard.recordSuccess();
        this.eventBus.emit('engine:statsUpdated', this.stats);
        this.logger.debug(`Clicked ${totalClicks} buttons`);
        return true;
      }

      if (totalBlocked > 0) {
        this.stats = {
          ...this.stats,
          blockedCommands: this.stats.blockedCommands + totalBlocked,
        };
        this.eventBus.emit('engine:statsUpdated', this.stats);
      }

      return false;
    } catch (err) {
      this.logger.debug(`CDP eval error: ${err}`);

      // Track retry in session stats
      this.stats = {
        ...this.stats,
        retriesAttempted: this.stats.retriesAttempted + 1,
      };
      this.eventBus.emit('engine:statsUpdated', this.stats);

      // Wire DeathLoopGuard — record retry on CDP errors
      const autoRetry = this.config.getAll().autoRetry;
      if (autoRetry.enabled) {
        // recordRetry() returns false if death loop triggered (guard pauses itself & emits event)
        this.deathLoopGuard.recordRetry();
      }

      return false;
    }
  }

  private handleCDPStateChange(newState: ConnectionState): void {
    switch (newState) {
      case ConnectionState.Disconnected:
        if (this.state === EngineState.Polling) {
          this.logger.warn('CDP disconnected during polling');
          // DON'T stop polling — Commands API still works
          // CDP will auto-reconnect via scheduleReconnect()
        }
        break;
      case ConnectionState.Reconnecting:
        this.setState(EngineState.Reconnecting);
        break;
      case ConnectionState.Connected:
        if (this.state === EngineState.Reconnecting) {
          this.setState(EngineState.Polling);
        }
        break;
      case ConnectionState.Failed:
        if (!this.adapter.supportsCommandsAPI()) {
          this.setState(EngineState.Error);
        }
        break;
    }
  }

  private setState(newState: EngineState): void {
    const oldState = this.state;
    if (oldState === newState) return;
    this.state = newState;
    this.eventBus.emit('engine:stateChanged', { from: oldState, to: newState });
    this.logger.debug(`Engine: ${oldState} → ${newState}`);
  }
}

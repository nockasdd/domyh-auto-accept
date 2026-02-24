/**
 * StatusBar — VS Code status bar integration
 *
 * Shows engine state with real-time stats.
 * Click to toggle on/off.
 */

import * as vscode from 'vscode';
import { EngineState } from '../domain/enums';
import { IEventBus } from '../domain/interfaces/event-bus';
import { SessionStats } from '../domain/types/stats';
import { DisposableStore } from '../core/disposable';
import { RuntimeConfigService } from '../application/runtime-config-service';
import { TerminalWatchdog } from '../infrastructure/terminal/watchdog';

const STATE_ICONS: Record<EngineState, string> = {
  [EngineState.Idle]: '$(circle-outline)',
  [EngineState.Starting]: '$(sync~spin)',
  [EngineState.NoCDP]: '$(warning)',
  [EngineState.Relaunching]: '$(sync~spin)',
  [EngineState.Connected]: '$(check)',
  [EngineState.Injecting]: '$(loading~spin)',
  [EngineState.Polling]: '$(check-all)',
  [EngineState.Error]: '$(error)',
  [EngineState.Reconnecting]: '$(sync~spin)',
};

const STATE_COLORS: Record<string, vscode.ThemeColor | undefined> = {
  [EngineState.Polling]: new vscode.ThemeColor('statusBarItem.warningForeground'),
  [EngineState.Error]: new vscode.ThemeColor('statusBarItem.errorForeground'),
};

export class StatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly dashboardItem: vscode.StatusBarItem;
  private readonly disposables = new DisposableStore();
  private watchdogPollTimer: ReturnType<typeof setInterval> | null = null;
  private clicks = 0;
  private queueInfo: { index: number; total: number } | null = null;
  private watchdogEnabled = true;
  private runtimeConfig: { clickRun: boolean; clickProceed: boolean; clickAcceptAll: boolean } | null = null;

  constructor(
    eventBus: IEventBus,
    runtimeConfigService?: RuntimeConfigService,
    watchdog?: TerminalWatchdog,
  ) {
    // Main status item: shows engine state & stats, toggles engine on click
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'domyh-auto-accept.toggle';
    this.item.tooltip = 'Domyh Auto Accept — Click to toggle';

    // Secondary item: quick entry to open dashboard
    this.dashboardItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.dashboardItem.text = '$(graph-line) Auto Accept';
    this.dashboardItem.tooltip = 'Domyh Auto Accept — Open Dashboard';
    this.dashboardItem.command = 'domyh-auto-accept.openDashboard';

    // Subscribe to events
    this.disposables.add(
      eventBus.on('engine:stateChanged', ({ to }) => {
        this.updateState(to);
      }),
    );
    this.disposables.add(
      eventBus.on('engine:statsUpdated', (stats) => {
        this.updateStats(stats);
      }),
    );
    this.disposables.add(
      eventBus.on('engine:deathLoopDetected', () => {
        this.item.text = `$(error) Auto Accept: PAUSED (death loop)`;
        this.item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      }),
    );
    this.disposables.add(
      eventBus.on('scheduler:queueAdvanced', ({ index, total }) => {
        this.queueInfo = { index, total };
        this.refreshText();
      }),
    );
    this.disposables.add(
      eventBus.on('scheduler:completed', () => {
        this.queueInfo = null;
        this.refreshText();
      }),
    );

    // Watchdog state tracking
    if (watchdog) {
      this.watchdogEnabled = watchdog.isRuntimeEnabled();
      // Note: Watchdog doesn't emit events, so we track it via periodic check
      this.watchdogPollTimer = setInterval(() => {
        const newState = watchdog.isRuntimeEnabled();
        if (newState !== this.watchdogEnabled) {
          this.watchdogEnabled = newState;
          this.refreshTooltip();
        }
      }, 2000);
    }

    // Runtime config tracking
    if (runtimeConfigService) {
      this.runtimeConfig = {
        clickRun: runtimeConfigService.get().clickRun,
        clickProceed: runtimeConfigService.get().clickProceed,
        clickAcceptAll: runtimeConfigService.get().clickAcceptAll,
      };
      this.disposables.add(
        eventBus.on('runtimeConfig:changed', ({ new: newConfig }) => {
          this.runtimeConfig = {
            clickRun: newConfig.clickRun,
            clickProceed: newConfig.clickProceed,
            clickAcceptAll: newConfig.clickAcceptAll,
          };
          this.refreshTooltip();
        }),
      );
    }

    this.updateState(EngineState.Idle);
    this.item.show();
    this.dashboardItem.show();
  }

  private currentState = EngineState.Idle;

  private updateState(state: EngineState): void {
    this.currentState = state;
    this.refreshText();
  }

  private updateStats(stats: SessionStats): void {
    this.clicks = stats.totalClicks;
    this.refreshText();
    this.refreshTooltip(stats);
  }

  private refreshTooltip(stats?: SessionStats): void {
    const lines: string[] = [
      `Domyh Auto Accept — Click to toggle`,
      `────────────────`,
    ];

    if (stats) {
      lines.push(
        `✅ Clicks: ${stats.totalClicks}`,
        `🚫 Blocked: ${stats.blockedCommands}`,
        `🔄 Retries: ${stats.retriesAttempted}`,
        `⏱️ Time saved: ~${stats.estimatedTimeSaved}s`,
        this.queueInfo ? `📋 Queue: ${this.queueInfo.index + 1}/${this.queueInfo.total}` : '',
      );
    }

    if (this.runtimeConfig) {
      lines.push(
        `────────────────`,
        `⚙️ Runtime Config:`,
        `  ${this.runtimeConfig.clickRun ? '✅' : '❌'} Run`,
        `  ${this.runtimeConfig.clickProceed ? '✅' : '❌'} Proceed`,
        `  ${this.runtimeConfig.clickAcceptAll ? '✅' : '❌'} Accept All`,
      );
    }

    lines.push(
      `────────────────`,
      `🐕 Watchdog: ${this.watchdogEnabled ? '✅ Enabled' : '⏸️ Paused'}`,
    );

    this.item.tooltip = lines.filter(Boolean).join('\n');
  }

  private refreshText(): void {
    const state = this.currentState;
    const icon = STATE_ICONS[state] || '$(question)';
    const label = state === EngineState.Polling
      ? `Auto Accept: ON (${this.clicks})`
      : `Auto Accept: ${state}`;
    const queueSuffix = this.queueInfo
      ? ` 📋 ${this.queueInfo.index + 1}/${this.queueInfo.total}`
      : '';
    this.item.text = `${icon} ${label}${queueSuffix}`;
    this.item.color = STATE_COLORS[state];
  }

  dispose(): void {
    if (this.watchdogPollTimer) {
      clearInterval(this.watchdogPollTimer);
      this.watchdogPollTimer = null;
    }
    this.item.dispose();
    this.dashboardItem.dispose();
    this.disposables.dispose();
  }
}

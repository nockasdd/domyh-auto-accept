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
  private readonly disposables = new DisposableStore();
  private clicks = 0;
  private queueInfo: { index: number; total: number } | null = null;

  constructor(eventBus: IEventBus) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.command = 'domyh-auto-accept.toggle';
    this.item.tooltip = 'Domyh Auto Accept — Click to toggle';

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

    this.updateState(EngineState.Idle);
    this.item.show();
  }

  private currentState = EngineState.Idle;

  private updateState(state: EngineState): void {
    this.currentState = state;
    this.refreshText();
  }

  private updateStats(stats: SessionStats): void {
    this.clicks = stats.totalClicks;
    this.refreshText();
    this.item.tooltip = [
      `Domyh Auto Accept — Click to toggle`,
      `────────────────`,
      `✅ Clicks: ${stats.totalClicks}`,
      `🚫 Blocked: ${stats.blockedCommands}`,
      `🔄 Retries: ${stats.retriesAttempted}`,
      `⏱️ Time saved: ~${stats.estimatedTimeSaved}s`,
      this.queueInfo ? `📋 Queue: ${this.queueInfo.index + 1}/${this.queueInfo.total}` : '',
    ].filter(Boolean).join('\n');
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
    this.item.dispose();
    this.disposables.dispose();
  }
}

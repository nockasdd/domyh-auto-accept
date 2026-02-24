/**
 * RuntimeConfigService — Manages runtime configuration state for auto-accept payload
 *
 * SRP: Centralized state management for runtime config that can be updated
 * dynamically without requiring window reload.
 *
 * This service:
 * - Holds the current runtime config state
 * - Provides update() method to change config partially
 * - Emits events when config changes
 * - Can be used by StatusBar/Dashboard for instant toggles
 */

import { Disposable } from 'vscode';
import { AutoAcceptRuntimeConfig } from '../domain/types/auto-accept-config';
import { IEventBus } from '../domain/interfaces/event-bus';
import { ConfigReader } from '../core/config';
import { Logger } from '../core/logger';

export class RuntimeConfigService implements Disposable {
  private currentConfig: AutoAcceptRuntimeConfig;

  constructor(
    private readonly config: ConfigReader,
    private readonly eventBus: IEventBus,
    private readonly logger: Logger,
  ) {
    // Initialize from ConfigReader
    this.currentConfig = config.getAutoAcceptRuntimeConfig();
  }

  /** Get current runtime config */
  get(): Readonly<AutoAcceptRuntimeConfig> {
    return this.currentConfig;
  }

  /**
   * Update runtime config partially.
   * Merges with current config and emits change event.
   */
  update(partial: Partial<AutoAcceptRuntimeConfig>): void {
    const oldConfig = { ...this.currentConfig };
    this.currentConfig = {
      ...this.currentConfig,
      ...partial,
    };

    // Emit event for listeners (e.g., engine will push to payload)
    this.eventBus.emit('runtimeConfig:changed', {
      old: oldConfig,
      new: this.currentConfig,
    });

    this.logger.debug(
      `RuntimeConfig updated: ${Object.keys(partial).join(', ')}`,
    );
  }

  /**
   * Reload config from ConfigReader (e.g., when VS Code settings change).
   * This is called automatically by extension.ts on config.onDidChange.
   */
  reload(): void {
    const newConfig = this.config.getAutoAcceptRuntimeConfig();
    const oldConfig = { ...this.currentConfig };
    this.currentConfig = newConfig;

    // Only emit if actually changed
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      this.eventBus.emit('runtimeConfig:changed', {
        old: oldConfig,
        new: this.currentConfig,
      });
      this.logger.debug('RuntimeConfig reloaded from VS Code settings');
    }
  }

  dispose(): void {
    // No cleanup needed
  }
}

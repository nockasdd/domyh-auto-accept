/**
 * Type-safe Config Reader
 *
 * SRP: Only reads VS Code workspace configuration with type safety.
 */

import * as vscode from 'vscode';
import { ExtensionConfig, AutoRetryConfig, ScheduleConfig } from '../domain/types/config';
import { QueueMode } from '../domain/enums';

const SECTION = 'domyh-auto-accept';

export class ConfigReader {
  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
  }

  /** Get the full typed config */
  getAll(): ExtensionConfig {
    return {
      enabled: this.config.get<boolean>('enabled', true),
      cdpPort: this.config.get<number>('cdpPort', 0),
      pollFrequency: this.config.get<number>('pollFrequency', 800),
      bannedCommands: this.config.get<string[]>('bannedCommands', []),
      autoAllowOutsideWorkspace: this.config.get<boolean>('autoAllowOutsideWorkspace', false),
      smartFocus: this.config.get<boolean>('smartFocus', false),
      debugMode: this.config.get<boolean>('debugMode', false),
      autoRetry: this.getAutoRetry(),
      schedule: this.getSchedule(),
    };
  }

  /** Get auto-retry config */
  getAutoRetry(): AutoRetryConfig {
    return {
      enabled: this.config.get<boolean>('autoRetry.enabled', true),
      maxRetries: this.config.get<number>('autoRetry.maxRetries', 10),
      windowSeconds: this.config.get<number>('autoRetry.windowSeconds', 300),
      cooldownSeconds: this.config.get<number>('autoRetry.cooldownSeconds', 120),
    };
  }

  /** Get schedule config */
  getSchedule(): ScheduleConfig {
    return {
      enabled: this.config.get<boolean>('schedule.enabled', false),
      mode: this.config.get<'interval' | 'daily' | 'queue'>('schedule.mode', 'interval'),
      value: this.config.get<string>('schedule.value', '30'),
      prompt: this.config.get<string>('schedule.prompt', 'Status report'),
      prompts: this.config.get<string[]>('schedule.prompts', []),
      queueMode: this.config.get<QueueMode>('schedule.queueMode', QueueMode.Consume),
      silenceTimeout: this.config.get<number>('schedule.silenceTimeout', 30),
    };
  }

  /** Get a single config value */
  get<T>(key: string, defaultValue: T): T {
    return this.config.get<T>(key, defaultValue);
  }

  /** Update a config value */
  async set(key: string, value: unknown, global = false): Promise<void> {
    await this.config.update(
      key,
      value,
      global ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
    );
  }

  /** Listen for configuration changes */
  onDidChange(handler: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        handler();
      }
    });
  }
}

/**
 * Type-safe Config Reader
 *
 * SRP: Only reads VS Code workspace configuration with type safety.
 */

import * as vscode from 'vscode';
import { ExtensionConfig, AutoRetryConfig, ScheduleConfig } from '../domain/types/config';
import { WatchdogConfig } from '../domain/types/terminal';
import { QueueMode } from '../domain/enums';
import { AutoAcceptRuntimeConfig } from '../domain/types/auto-accept-config';

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
      terminalWatchdog: this.getTerminalWatchdog(),
      autoAcceptRuntime: this.getAutoAcceptRuntimeConfig(),
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

  /** Get terminal watchdog config */
  getTerminalWatchdog(): WatchdogConfig {
    return {
      enabled: this.config.get<boolean>('terminalWatchdog.enabled', true),
      defaultTimeout: this.config.get<number>('terminalWatchdog.defaultTimeout', 60),
      longTimeout: this.config.get<number>('terminalWatchdog.longTimeout', 180),
      installTimeout: this.config.get<number>('terminalWatchdog.installTimeout', 600),
      recoveryStrategy: this.config.get<'enter-only' | 'escalating' | 'kill-only'>(
        'terminalWatchdog.recoveryStrategy',
        'escalating',
      ),
      maxRetries: this.config.get<number>('terminalWatchdog.maxRetries', 3),
      excludePatterns: this.config.get<string[]>(
        'terminalWatchdog.excludePatterns',
        [
          'docker',
          'ssh',
          'tail -f',
          'watch',
          // Common dev servers / long-running watchers — do not treat as stuck by default
          'npm run dev',
          'yarn dev',
          'pnpm dev',
          'nuxt dev',
          'next dev',
          'vite dev',
        ],
      ),
      uiMismatchRecoveryEnabled: this.config.get<boolean>(
        'terminalWatchdog.uiMismatchRecovery.enabled',
        false,
      ),
      uiMismatchQuickEndMs: this.config.get<number>(
        'terminalWatchdog.uiMismatchRecovery.quickEndMs',
        2000,
      ),
      uiMismatchGraceMs: this.config.get<number>(
        'terminalWatchdog.uiMismatchRecovery.graceMs',
        8000,
      ),
    };
  }

  /** Build runtime config for the auto-accept payload */
  getAutoAcceptRuntimeConfig(): AutoAcceptRuntimeConfig {
    const enabled = this.config.get<boolean>('enabled', true);
    const pollFrequency = this.config.get<number>('pollFrequency', 800);

    // Feature flags — can be exposed as explicit settings later.
    const clickRun = this.config.get<boolean>('autoAccept.clickRun', true);
    const clickProceed = this.config.get<boolean>('autoAccept.clickProceed', true);
    const clickAcceptAll = this.config.get<boolean>('autoAccept.clickAcceptAll', true);
    const clickAllowOnce = this.config.get<boolean>('autoAccept.clickAllowOnce', true);
    const clickAllowConversation = this.config.get<boolean>(
      'autoAccept.clickAllowConversation',
      true,
    );
    const clickSend = this.config.get<boolean>('autoAccept.clickSend', true);

    const bannedCommands = this.config.get<string[]>('bannedCommands', []);
    const dangerousCommands = this.config.get<string[]>(
      'autoAccept.dangerousCommands',
      [],
    );

    const forbiddenZonesExtra = this.config.get<string[]>(
      'autoAccept.forbiddenZonesExtra',
      [],
    );

    const proceedThrottleMs = this.config.get<number>(
      'autoAccept.proceedThrottleMs',
      4000,
    );
    const userScrollCooldownMs = this.config.get<number>(
      'autoAccept.userScrollCooldownMs',
      3000,
    );

    const maxClicksPerCycle = this.config.get<number>(
      'autoAccept.maxClicksPerCycle',
      20,
    );

    const logLevel = this.config.get<'none' | 'info' | 'debug'>(
      'autoAccept.logLevel',
      this.config.get<boolean>('debugMode', false) ? 'debug' : 'none',
    );

    const runtimeConfig: AutoAcceptRuntimeConfig = {
      enabled,
      clickRun,
      clickProceed,
      clickAcceptAll,
      clickAllowOnce,
      clickAllowConversation,
      clickSend,
      bannedCommands,
      dangerousCommands,
      forbiddenZonesExtra,
      pollFrequencyMs: pollFrequency,
      proceedThrottleMs,
      userScrollCooldownMs,
      maxClicksPerCycle,
      logLevel,
    };

    return runtimeConfig;
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

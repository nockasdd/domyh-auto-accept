import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { TerminalWatchdog } from '../src/infrastructure/terminal/watchdog';
import { Logger } from '../src/core/logger';
import { WatchdogConfig, CmdTracker } from '../src/domain/types/terminal';

function createTerminal(name = 'Test'): vscode.Terminal {
  return {
    name,
    sendText: vi.fn(),
    dispose: vi.fn(),
    show: vi.fn(),
    state: { isInteractedWith: false },
  } as unknown as vscode.Terminal;
}

const baseConfig: WatchdogConfig = {
  enabled: true,
  defaultTimeout: 60,
  longTimeout: 180,
  installTimeout: 600,
  maxRetries: 3,
  recoveryStrategy: 'escalating',
  softMode: false,
  excludePatterns: [],
  uiMismatchRecoveryEnabled: false,
  uiMismatchQuickEndMs: 2000,
  uiMismatchGraceMs: 8000,
};

describe('TerminalWatchdog', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = new Logger();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('getTimeoutMs maps build/test/install to longer buckets', () => {
    const watchdog = new TerminalWatchdog(baseConfig, logger) as any;

    expect(watchdog.getTimeoutMs('npm run build')).toBe(baseConfig.installTimeout * 1000);
    expect(watchdog.getTimeoutMs('go test ./...')).toBe(baseConfig.longTimeout * 1000);
    expect(watchdog.getTimeoutMs('npm install')).toBe(baseConfig.installTimeout * 1000);
    expect(watchdog.getTimeoutMs('echo hello')).toBe(baseConfig.defaultTimeout * 1000);
  });

  it('classifyCommand distinguishes npm test/build/install correctly', () => {
    const watchdog = new TerminalWatchdog(baseConfig, logger) as any;

    // npm/yarn/pnpm test → test (longTimeout)
    expect(watchdog.classifyCommand('npm test')).toBe('test');
    expect(watchdog.classifyCommand('yarn test')).toBe('test');
    expect(watchdog.classifyCommand('pnpm test')).toBe('test');

    // npm run build/npm install should not be misclassified as test
    expect(watchdog.classifyCommand('npm run build')).toBe('heavy-build');
    expect(watchdog.classifyCommand('npm install')).toBe('install');
  });

  it('softMode never calls killTerminal and uses Enter/Ctrl+C only', async () => {
    const config: WatchdogConfig = { ...baseConfig, softMode: true };
    const watchdog = new TerminalWatchdog(config, logger) as any;
    const terminal = createTerminal();

    const tracker: CmdTracker = {
      terminal,
      commandLine: 'long-running-task',
      startTime: Date.now(),
      lastActivity: Date.now(),
      state: 'running',
      retryCount: 0,
      skippedDueToInteraction: false,
    };

    const killSpy = vi.spyOn(watchdog, 'killTerminal');
    const sendEnterSpy = vi.spyOn(watchdog, 'sendEnter');
    const sendCtrlCSpy = vi.spyOn(watchdog, 'sendCtrlC');

    // First recovery attempt should send Enter
    await watchdog.recover(terminal, tracker);
    expect(sendEnterSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();

    // Second attempt should send Ctrl+C, still no kill
    tracker.retryCount = 1;
    await watchdog.recover(terminal, tracker);
    expect(sendCtrlCSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('softMode stops recovery at maxRetries instead of infinite Ctrl+C', async () => {
    const config: WatchdogConfig = { ...baseConfig, softMode: true, maxRetries: 2 };
    const watchdog = new TerminalWatchdog(config, logger) as any;
    const terminal = createTerminal();

    const tracker: CmdTracker = {
      terminal,
      commandLine: 'stuck-task',
      startTime: Date.now(),
      lastActivity: Date.now(),
      state: 'stuck',
      retryCount: 2, // Already at maxRetries
      skippedDueToInteraction: false,
    };

    const killSpy = vi.spyOn(watchdog, 'killTerminal');
    const sendCtrlCSpy = vi.spyOn(watchdog, 'sendCtrlC');

    await watchdog.recover(terminal, tracker);

    // Should NOT send Ctrl+C (would cause infinite loop)
    expect(sendCtrlCSpy).not.toHaveBeenCalled();
    // Should NOT kill (softMode)
    expect(killSpy).not.toHaveBeenCalled();
    // Should mark as completed and stop tracking
    expect(tracker.state).toBe('completed');
  });

  it('never kills interacted terminals even in escalating strategy', async () => {
    const watchdog = new TerminalWatchdog(baseConfig, logger) as any;
    const terminal = createTerminal();
    // Simulate user interaction
    (terminal.state as any).isInteractedWith = true;

    const tracker: CmdTracker = {
      terminal,
      commandLine: 'long-running-task',
      startTime: Date.now(),
      lastActivity: Date.now(),
      state: 'stuck',
      retryCount: 2, // would normally lead to killTerminal()
      skippedDueToInteraction: false,
    };

    const killSpy = vi.spyOn(watchdog, 'killTerminal');

    await watchdog.recover(terminal, tracker);

    expect(killSpy).not.toHaveBeenCalled();
    expect(tracker.state).toBe('completed');
  });

  it('enter-only stops recovery at maxRetries', async () => {
    const config: WatchdogConfig = {
      ...baseConfig,
      recoveryStrategy: 'enter-only',
      maxRetries: 2,
    };
    const watchdog = new TerminalWatchdog(config, logger) as any;
    const terminal = createTerminal();

    const tracker: CmdTracker = {
      terminal,
      commandLine: 'stuck-task',
      startTime: Date.now(),
      lastActivity: Date.now(),
      state: 'stuck',
      retryCount: 2, // Already at maxRetries
      skippedDueToInteraction: false,
    };

    const sendEnterSpy = vi.spyOn(watchdog, 'sendEnter');
    const killSpy = vi.spyOn(watchdog, 'killTerminal');

    await watchdog.recover(terminal, tracker);

    expect(sendEnterSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(tracker.state).toBe('completed');
  });

  it('killTerminal sends Ctrl+C before dispose', () => {
    const watchdog = new TerminalWatchdog(baseConfig, logger) as any;
    const terminal = createTerminal();

    const tracker: CmdTracker = {
      terminal,
      commandLine: 'stuck-task',
      startTime: Date.now() - 120000,
      lastActivity: Date.now() - 60000,
      state: 'stuck',
      retryCount: 3,
      skippedDueToInteraction: false,
    };

    watchdog.killTerminal(terminal, tracker);

    // Ctrl+C should be sent immediately
    expect(terminal.sendText).toHaveBeenCalledWith('\x03', false);
    // dispose is deferred (setTimeout 2s), so not called yet
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(tracker.state).toBe('completed');

    // After grace period, dispose should be called
    vi.advanceTimersByTime(2000);
    expect(terminal.dispose).toHaveBeenCalledTimes(1);
  });
});


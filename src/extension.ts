/**
 * Extension Entry Point — Domyh Auto Accept
 *
 * Bootstraps the IoC container, registers adapters, and starts the engine.
 * Activation: onStartupFinished (no impact on IDE boot time).
 *
 * Multi-window: Each window runs independently. Commands API works in all windows.
 * CDP supports multiple simultaneous clients (Chrome 63+), so no lock needed.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { container, Tokens } from './core/container';
import { Logger } from './core/logger';
import { ConfigReader } from './core/config';
import { DisposableStore } from './core/disposable';
import { TypedEventBus } from './application/event-bus';
import { AutoAcceptEngine } from './application/engine';

import { DeathLoopGuard } from './application/death-loop-guard';
import { SmartFocus } from './application/smart-focus';
import { Scheduler } from './application/scheduler';
import { CDPConnector } from './infrastructure/cdp/connector';
import { PayloadManager } from './infrastructure/cdp/payload-manager';
import { IDEDetector } from './infrastructure/detection/ide-detector';
import { IDEAdapterRegistry } from './infrastructure/adapters/registry';
import { AntigravityAdapter } from './infrastructure/adapters/antigravity';
import { CursorAdapter } from './infrastructure/adapters/cursor';
import { WindsurfAdapter } from './infrastructure/adapters/windsurf';
import { TraeAdapter } from './infrastructure/adapters/trae';
import { VSCodeCopilotAdapter } from './infrastructure/adapters/vscode-copilot';
import { TerminalWatchdog } from './infrastructure/terminal/watchdog';
import { StatusBar } from './presentation/status-bar';
import { DashboardPanel } from './presentation/dashboard/panel';
import { NotificationManager } from './presentation/notifications';
import { IEventBus } from './domain/interfaces/event-bus';
import { RuntimeConfigService } from './application/runtime-config-service';

const disposables = new DisposableStore();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // ── 1. Bootstrap core services ───────────────────
  const logger = new Logger();
  const config = new ConfigReader();
  const eventBus = new TypedEventBus();
  const fullConfig = config.getAll();

  logger.setDebugMode(fullConfig.debugMode);
  const extensionPkg = require('../package.json') as { version: string };
  logger.info(`Domyh Auto Accept v${extensionPkg.version} activating...`);

  // Register core services in IoC
  container.register(Tokens.Logger, () => logger);
  container.register(Tokens.Config, () => config);
  container.register(Tokens.EventBus, () => eventBus);

  // ── 2. Detect IDE ────────────────────────────────
  const detector = new IDEDetector();
  const detection = detector.detect();
  logger.info(`IDE detected: ${detection.ideType} (source: ${detection.source}, port: ${detection.defaultPort})`);
  // ── 2b. CDP auto-setup ──────────────────────────────
  // Ensures IDE starts with --remote-debugging-port flag.
  //   - If IDE already has flag → skip
  //   - Always: patch argv.json + modify shortcut (idempotent, no harm)
  //   - Popup prompt: shown ONCE via cdpPromptShown flag
  {
    const { Relauncher } = await import('./infrastructure/cdp/relauncher');
    const cdpSetupMode = fullConfig.cdpSetupMode ?? 'auto';
    const port = detection.defaultPort;
    const relauncher = new Relauncher(logger, port);
    const hasCDPFlag = relauncher.hasFlag();
    logger.info(`CDP setup: hasFlag=${hasCDPFlag}, argv=[${process.argv.filter(a => a.startsWith('--remote')).join(', ') || 'none'}]`);

    if (cdpSetupMode === 'manual') {
      if (hasCDPFlag) {
        logger.info('CDP setup: mode=manual — IDE already has --remote-debugging-port flag ✓ (no host changes performed)');
      } else {
        logger.info(
          'CDP setup: mode=manual — IDE does not have --remote-debugging-port flag. ' +
          'Auto Accept will use Commands API and any manually configured CDP only. ' +
          'See README for manual CDP configuration instructions.',
        );
      }
    } else if (hasCDPFlag) {
      logger.info('CDP setup: IDE has --remote-debugging-port flag ✓');
    } else {
      // Always patch argv.json (idempotent — only writes if not already set)
      try {
        const { CDPSetup } = await import('./infrastructure/cdp/cdp-setup');
        const cdpSetup = new CDPSetup(detection.ideType, port, logger);
        if (!cdpSetup.isCDPConfigured()) {
          const result = await cdpSetup.enableCDP();
          if (result.patched) {
            logger.info(`CDP setup: argv.json patched with port ${port}`);
          }
        } else {
          logger.info('CDP setup: argv.json already configured ✓');
        }
      } catch { /* argv.json may not exist for Cursor — that's OK */ }

      // Always modify ALL shortcuts (idempotent — skips if already has flag)
      const failedShortcuts: Awaited<ReturnType<typeof relauncher.findIDEShortcuts>> = [];
      try {
        const shortcuts = await relauncher.findIDEShortcuts();
        logger.info(`CDP setup: found ${shortcuts.length} shortcut(s)`);
        let modifiedCount = 0;
        let alreadyOkCount = 0;
        for (const shortcut of shortcuts) {
          const modResult = await relauncher.ensureShortcutHasFlag(shortcut);
          const status = modResult.modified ? 'MODIFIED' : (shortcut.hasFlag ? 'already OK' : 'FAILED');
          logger.info(`CDP setup: [${shortcut.type}] ${shortcut.path.split(/[/\\]/).pop()} → ${status} (${modResult.message})`);
          if (modResult.modified) modifiedCount++;
          else if (shortcut.hasFlag) alreadyOkCount++;
          else failedShortcuts.push(shortcut);
        }
        if (shortcuts.length === 0) {
          logger.info('CDP setup: no shortcuts found — user must start with --remote-debugging-port manually');
        } else {
          logger.info(`CDP setup: ${modifiedCount}/${shortcuts.length} modified, ${alreadyOkCount} already OK, ${failedShortcuts.length} failed`);
        }
      } catch (err) {
        logger.info(`CDP setup: shortcut modification failed: ${err}`);
      }

      // Log any failed shortcuts for debugging (no admin popup)
      if (failedShortcuts.length > 0) {
        logger.info(`CDP setup: ${failedShortcuts.length} shortcut(s) failed — will use direct relaunch instead`);
      }

      // Show setup prompt ONCE — guarded by cdpPromptShown
      const promptShown = context.globalState.get<boolean>('cdpPromptShown', false);
      if (!promptShown && failedShortcuts.length === 0) {
        logger.info('CDP setup: showing setup prompt (first time)...');
        const setupResult = await relauncher.showSetupPrompt();
        await context.globalState.update('cdpPromptShown', true);

        if (setupResult === 'relaunched') {
          return; // IDE is quitting
        }
        logger.info(`CDP setup: ${setupResult} — continuing with Commands API`);
      } else if (failedShortcuts.length === 0) {
        logger.info('CDP setup: prompt already shown — skipping (use "Re-run CDP Setup" to reset)');
      }
    }
  }

  // ── 3. Register adapters ─────────────────────────
  const registry = new IDEAdapterRegistry(logger);
  registry.register(new AntigravityAdapter());
  registry.register(new CursorAdapter());
  registry.register(new WindsurfAdapter());
  registry.register(new TraeAdapter());
  registry.register(new VSCodeCopilotAdapter());
  container.register(Tokens.IDERegistry, () => registry);

  // Get adapter for detected IDE
  const adapter = registry.get(detection.ideType);

  if (!adapter) {
    logger.warn(`No adapter for ${detection.ideType}. Extension will try generic commands.`);
  }

  // ── 4. Create infrastructure services ────────────
  const cdp = new CDPConnector(logger);
  const deathLoopGuard = new DeathLoopGuard(fullConfig.autoRetry, eventBus, logger);

  // Load JS payloads
  const payloads = new PayloadManager(logger);
  const payloadDir = path.join(context.extensionPath, 'dist', 'payload');
  const payloadNames = ['auto-accept', 'probe', 'probe-buttons', 'send-prompt'];
  for (const name of payloadNames) {
    const filePath = path.join(payloadDir, `${name}.js`);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      payloads.register(name, content);
    } catch {
      logger.debug(`Payload file not found: ${filePath}`);
    }
  }

  container.register(Tokens.CDPConnector, () => cdp);
  container.register(Tokens.DeathLoopGuard, () => deathLoopGuard);

  // Smart focus (optional)
  let smartFocus: SmartFocus | null = null;
  if (fullConfig.smartFocus) {
    smartFocus = new SmartFocus(eventBus, logger);
    smartFocus.start();
    container.register(Tokens.SmartFocus, () => smartFocus!);
  }

  // ── 5. Create runtime config service (Phase 3: instant toggle support) ──
  // Must be created before engine so engine can receive it.
  const runtimeConfigService = new RuntimeConfigService(config, eventBus, logger);
  disposables.add(runtimeConfigService);

  // ── 5d. Start terminal watchdog (Windows terminal hang protection) ──
  const watchdog = new TerminalWatchdog(fullConfig.terminalWatchdog, logger, eventBus);
  watchdog.start();
  disposables.add(watchdog);

  // ── 5b. Create the engine ─────────────────────────
  const fallbackAdapter = adapter ?? new AntigravityAdapter();
  const engine = new AutoAcceptEngine(
    fallbackAdapter,
    cdp,
    eventBus,
    deathLoopGuard,
    smartFocus,
    payloads,
    config,
    logger,
    runtimeConfigService, // Pass service so engine can read instant toggle state
    watchdog, // Pass watchdog for UI mismatch recovery
  );
  container.register(Tokens.Engine, () => engine);

  // ── 5c. Create the scheduler ────────────────────
  const scheduler = new Scheduler(cdp, eventBus, payloads, config, logger);
  container.register(Tokens.Scheduler, () => scheduler);

  // ── 6. UI ────────────────────────────────────────
  const statusBar = new StatusBar(eventBus, runtimeConfigService, watchdog);
  disposables.add(statusBar);

  // ── 7. Register commands ─────────────────────────
  registerCommands(context, engine, scheduler, eventBus, runtimeConfigService, watchdog);

  // ── 8. Subscribe to config changes ───────────────
  disposables.add(
    config.onDidChange(() => {
      const newConfig = config.getAll();
      logger.setDebugMode(newConfig.debugMode);
      logger.info('Configuration reloaded');

      // Reload runtime config service (will emit event → engine pushes to payload)
      runtimeConfigService.reload();
    }),
  );

  // ── 8b. Subscribe to runtime config changes (Phase 3: instant toggle) ──
  // When runtime config changes (from service.update() or service.reload()),
  // engine will push new config to all CDP targets immediately.
  disposables.add(
    eventBus.on('runtimeConfig:changed', () => {
      void engine.pushRuntimeConfig();
    }),
  );

  // ── 9. Notifications (centralized) ──────────────
  new NotificationManager(eventBus, logger, disposables);

  // ── 10. Auto-start if enabled ────────────────────
  // engine.start() auto-tries CDP on default port → falls back to Commands-only
  if (fullConfig.enabled) {
    await engine.start();
  }

  logger.info('Domyh Auto Accept activated ✓');

  // ── Cleanup on deactivation ──────────────────────
  context.subscriptions.push({
    dispose: () => {
      scheduler.dispose();
      engine.dispose();
      cdp.dispose();
      deathLoopGuard.dispose();
      smartFocus?.dispose();
      eventBus.dispose();
      disposables.dispose();
      container.clear();
      logger.info('Domyh Auto Accept deactivated');
      logger.dispose();
    },
  });
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions
}

// ── Command Registration ─────────────────────────────

function registerCommands(
  context: vscode.ExtensionContext,
  engine: AutoAcceptEngine | null,
  scheduler: Scheduler | null,
  eventBus: IEventBus,
  runtimeConfigService: RuntimeConfigService,
  watchdog: TerminalWatchdog,
): void {
  const register = (id: string, handler: () => void | Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  register('domyh-auto-accept.toggle', async () => {
    if (!engine) {
      vscode.window.showWarningMessage('Auto Accept is in passive mode (another window is active).');
      return;
    }
    const isRunning = await engine.toggle();
    vscode.window.showInformationMessage(
      `Auto Accept: ${isRunning ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.start', async () => {
    if (!engine) return;
    await engine.start();
    vscode.window.showInformationMessage('Auto Accept started ✅');
  });

  register('domyh-auto-accept.stop', async () => {
    if (!engine) return;
    await engine.stop();
    vscode.window.showInformationMessage('Auto Accept stopped ❌');
  });

  register('domyh-auto-accept.resetRetry', () => {
    if (container.has(Tokens.DeathLoopGuard)) {
      container.resolve<DeathLoopGuard>(Tokens.DeathLoopGuard).reset();
      vscode.window.showInformationMessage('Retry counter reset ✅');
    }
  });

  register('domyh-auto-accept.resetCDPSetup', async () => {
    await context.globalState.update('cdpSetupDone', undefined);
    await context.globalState.update('cdpSetupAttempts', undefined);
    await context.globalState.update('cdpPromptShown', undefined);
    vscode.window.showInformationMessage(
      'CDP setup reset ✅ — Restart the IDE to re-run setup.',
    );
  });

  register('domyh-auto-accept.probeButtons', async () => {
    if (!engine) {
      vscode.window.showWarningMessage('Engine not ready.');
      return;
    }
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Probing buttons...' },
      async () => {
        try {
          const report = await engine.probeButtons();
          const doc = await vscode.workspace.openTextDocument({
            content: report,
            language: 'json',
          });
          await vscode.window.showTextDocument(doc, { preview: false });
          try {
            const parsed = JSON.parse(report);
            if (parsed.error) {
              vscode.window.showErrorMessage(`❌ Probe failed: ${parsed.error}`);
              if (parsed.error.includes('Not connected') || parsed.error.includes('CDP')) {
                vscode.window.showInformationMessage(
                  '💡 Tip: Ensure Auto Accept is started and CDP is connected. Try: Domyh Auto Accept: Start',
                );
              }
              return;
            }
            if (parsed.keepAllFound) {
              vscode.window.showInformationMessage('✅ Keep All found and would be clicked');
            } else if (parsed.keepAllDetails) {
              const details = parsed.keepAllDetails;
              vscode.window.showWarningMessage(
                `⚠️ Keep All found but blocked:\n` +
                `- inForbidden: ${details.inForbiddenZone}\n` +
                `- inCode: ${details.inCodeOrProse}\n` +
                `- clickable: ${details.isClickable}\n` +
                `- isAcceptButton: ${details.isAcceptButton}\n` +
                `- text: "${details.text}"\n` +
                `- classes: ${details.classes}`,
              );
            } else {
              const diag = parsed.diagnostics || {};
              vscode.window.showWarningMessage(
                `❌ Keep All not found in scan\n` +
                `Containers: ${parsed.containersFound || 0}, Buttons scanned: ${parsed.buttonsScanned || 0}\n` +
                `composerHeaderById: ${diag.composerHeaderById}, composerPaneByQuery: ${diag.composerPaneByQuery}\n` +
                `anysphereButtons: ${diag.anysphereButtons || 0}, dataClickReady: ${diag.dataClickReadyButtons || 0}`,
              );
            }
          } catch (parseErr) {
            vscode.window.showErrorMessage(`Failed to parse probe result: ${parseErr}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`Probe failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
  });

  register('domyh-auto-accept.openDashboard', () => {
    DashboardPanel.createOrShow(
      context.extensionUri,
      eventBus,
      {
        stats: engine?.getStats(),
        engineState: engine?.getState(),
      },
      runtimeConfigService,
      watchdog,
    );
  });

  // Queue commands — wired to Scheduler
  register('domyh-auto-accept.startQueue', () => {
    if (!scheduler) return;
    scheduler.start();
    vscode.window.showInformationMessage(
      `Prompt queue started (${scheduler.queueLength} prompts) 📋`,
    );
  });
  register('domyh-auto-accept.pauseQueue', () => {
    if (!scheduler) return;
    scheduler.pause();
    vscode.window.showInformationMessage('Prompt queue paused ⏸️');
  });
  register('domyh-auto-accept.resumeQueue', () => {
    if (!scheduler) return;
    scheduler.resume();
    vscode.window.showInformationMessage('Prompt queue resumed ▶️');
  });
  register('domyh-auto-accept.skipQueue', () => {
    if (!scheduler) return;
    scheduler.skip();
    vscode.window.showInformationMessage(
      `Skipped to prompt ${scheduler.currentIndex + 1}/${scheduler.queueLength} ⏭️`,
    );
  });
  register('domyh-auto-accept.stopQueue', () => {
    if (!scheduler) return;
    scheduler.stop();
    vscode.window.showInformationMessage('Prompt queue stopped ⏹️');
  });

  // ── Terminal watchdog runtime controls (Phase 4) ──
  register('domyh-auto-accept.watchdog.pause', () => {
    watchdog.pauseRuntime();
    vscode.window.showWarningMessage('Terminal Watchdog: PAUSED ⏸️ (runtime only)');
  });

  register('domyh-auto-accept.watchdog.resume', () => {
    watchdog.resumeRuntime();
    vscode.window.showInformationMessage('Terminal Watchdog: RESUMED ▶️');
  });

  // ── Runtime config toggle commands (Phase 3: instant toggle) ──
  register('domyh-auto-accept.toggleClickRun', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickRun: !current.clickRun });
    vscode.window.showInformationMessage(
      `Auto-click "Run": ${!current.clickRun ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.toggleClickProceed', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickProceed: !current.clickProceed });
    vscode.window.showInformationMessage(
      `Auto-click "Proceed": ${!current.clickProceed ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.toggleClickAcceptAll', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickAcceptAll: !current.clickAcceptAll });
    vscode.window.showInformationMessage(
      `Auto-click "Accept All": ${!current.clickAcceptAll ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.toggleClickAllowOnce', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickAllowOnce: !current.clickAllowOnce });
    vscode.window.showInformationMessage(
      `Auto-click "Allow once": ${!current.clickAllowOnce ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.toggleClickAllowConversation', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickAllowConversation: !current.clickAllowConversation });
    vscode.window.showInformationMessage(
      `Auto-click "Allow this conversation": ${!current.clickAllowConversation ? 'ON ✅' : 'OFF ❌'}`,
    );
  });

  register('domyh-auto-accept.toggleClickSend', () => {
    const current = runtimeConfigService.get();
    runtimeConfigService.update({ clickSend: !current.clickSend });
    vscode.window.showInformationMessage(
      `Auto-click "Send": ${!current.clickSend ? 'ON ✅' : 'OFF ❌'}`,
    );
  });
}

// ── Dashboard HTML ───────────────────────────────────

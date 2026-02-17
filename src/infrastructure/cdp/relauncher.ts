/**
 * Relauncher — Ensure IDE is started with --remote-debugging-port flag.
 *
 * Cross-platform: relaunches IDE when CDP flag is missing.
 *
 * Flow:
 * 1. Check process.argv for existing --remote-debugging-port flag
 * 2. If missing → relaunch IDE with flag via process.execPath
 */

import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as os from 'os';
import { Logger } from '../../core/logger';

const DEFAULT_CDP_PORT = 9004;

export class Relauncher {
  private readonly platform: NodeJS.Platform;
  private readonly cdpFlag: string;

  constructor(
    private readonly logger: Logger,
    port: number = DEFAULT_CDP_PORT,
  ) {
    this.platform = os.platform();
    this.cdpFlag = `--remote-debugging-port=${port}`;
  }

  /**
   * Get the human-readable name of the IDE.
   */
  private getIdeName(): string {
    const appName = vscode.env.appName || '';
    if (appName.toLowerCase().includes('antigravity')) return 'Antigravity';
    if (appName.toLowerCase().includes('cursor')) return 'Cursor';
    if (appName.toLowerCase().includes('windsurf')) return 'Windsurf';
    if (appName.toLowerCase().includes('trae')) return 'Trae';
    return 'Code';
  }

  /**
   * Check if the current process was launched with the CDP flag.
   */
  hasFlag(): boolean {
    return process.argv.join(' ').includes(this.cdpFlag);
  }

  /**
   * Relaunch the IDE with the CDP flag.
   * Uses spawn with argument arrays (not shell strings) to prevent injection.
   * Spawns a delayed process then quits the current instance.
   */
  async relaunch(): Promise<void> {
    const folderPaths = (vscode.workspace.workspaceFolders || [])
      .map(f => f.uri.fsPath);

    const exePath = process.execPath;
    this.logger.info(`[Relauncher] Relaunching: ${exePath} ${this.cdpFlag} ${folderPaths.join(' ')}`);

    if (this.platform === 'win32') {
      // Use cmd /c with timeout, then spawn the exe with proper args
      const args = ['/c', 'timeout', '/t', '2', '/nobreak', '>nul', '&', exePath, this.cdpFlag, ...folderPaths];
      spawn('cmd.exe', args, { detached: true, stdio: 'ignore' }).unref();
    } else if (this.platform === 'darwin') {
      const ideName = this.getIdeName();
      const appPath = ideName === 'Code'
        ? '/Applications/Visual Studio Code.app'
        : `/Applications/${ideName}.app`;
      // macOS 'open' command: safe arg passing via --args
      spawn('open', ['-a', appPath, '--args', this.cdpFlag, ...folderPaths], {
        detached: true, stdio: 'ignore',
      }).unref();
    } else {
      // Linux: direct spawn with args after a brief sleep via bash
      const args = ['-c', `sleep 2 && exec "$@"`, '--', exePath, this.cdpFlag, ...folderPaths];
      spawn('bash', args, { detached: true, stdio: 'ignore' }).unref();
    }

    // Quit current instance after short delay
    setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 500);
  }
}


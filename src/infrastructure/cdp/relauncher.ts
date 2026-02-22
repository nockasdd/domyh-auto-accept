/**
 * Relauncher — Ensure IDE is started with --remote-debugging-port flag.
 *
 * Cross-platform approach based on open-source research:
 * - Windows: Modify .lnk shortcut Arguments via PowerShell + relaunch via batch
 * - macOS:   'open -a ... --args' or wrapper script
 * - Linux:   Modify .desktop Exec line + relaunch via bash
 *
 * Flow:
 *  1. Check process.argv for existing --remote-debugging-port flag
 *  2. If missing → try to find and modify IDE shortcuts to persist the flag
 *  3. Relaunch IDE: spawn delayed process → quit current instance
 *
 * Inspired by AUTO-ALL-AntiGravity/relauncher.js (MIT licensed)
 */

import * as vscode from 'vscode';
import { execSync, spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../core/logger';

// ─── Types ───────────────────────────────────────────────

interface ShortcutInfo {
  path: string;
  type: 'startmenu' | 'desktop' | 'taskbar' | 'wrapper' | 'app' | 'user' | 'system';
  hasFlag: boolean;
  args?: string;
  target?: string;
  execLine?: string;
}

interface ModifyResult {
  success: boolean;
  modified: boolean;
  message: string;
}

interface RelaunchResult {
  success: boolean;
  action: 'none' | 'relaunched' | 'error';
  message: string;
}

// ─── Class ───────────────────────────────────────────────

export class Relauncher {
  private readonly platform: NodeJS.Platform;
  private readonly cdpFlag: string;
  private readonly port: number;

  constructor(
    private readonly logger: Logger,
    port: number = 9222,
  ) {
    this.platform = os.platform();
    this.port = port;
    this.cdpFlag = `--remote-debugging-port=${port}`;
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Check if the current process was launched with the CDP flag.
   */
  hasFlag(): boolean {
    return process.argv.some(arg => arg.includes('--remote-debugging-port'));
  }

  /**
   * Get the IDE name from vscode.env.appName.
   */
  getIdeName(): string {
    const appName = (vscode.env.appName || '').toLowerCase();
    if (appName.includes('antigravity')) return 'Antigravity';
    if (appName.includes('cursor')) return 'Cursor';
    if (appName.includes('windsurf')) return 'Windsurf';
    if (appName.includes('trae')) return 'Trae';
    return 'Code';
  }

  /**
   * Full CDP relaunch flow:
   * 1. Find IDE shortcuts
   * 2. Modify to add --remote-debugging-port flag
   * 3. Relaunch IDE
   */
  async relaunchWithCDP(): Promise<RelaunchResult> {
    this.logger.info(`[Relauncher] Starting CDP setup for ${this.getIdeName()}...`);

    // Step 1: Find shortcuts
    const shortcuts = await this.findIDEShortcuts();
    if (shortcuts.length > 0) {
      // Step 2: Modify primary shortcut to persist flag
      const primary = shortcuts.find(s =>
        s.type === 'startmenu' || s.type === 'wrapper' || s.type === 'user',
      ) ?? shortcuts[0];

      const modResult = await this.ensureShortcutHasFlag(primary);
      if (modResult.modified) {
        this.logger.info(`[Relauncher] Shortcut modified: ${modResult.message}`);
      }
    } else {
      this.logger.info(`[Relauncher] No shortcuts found — will relaunch directly`);
    }

    // Step 3: Relaunch with flag
    this.logger.info(`[Relauncher] Relaunching with ${this.cdpFlag}`);
    await this.relaunch();

    return {
      success: true,
      action: 'relaunched',
      message: 'IDE is relaunching with CDP enabled...',
    };
  }

  /**
   * Show user prompt for one-time CDP setup.
   * Returns 'relaunched' | 'cancelled' | 'failed'.
   */
  async showSetupPrompt(): Promise<'relaunched' | 'cancelled' | 'failed'> {
    const ideName = this.getIdeName();
    const choice = await vscode.window.showInformationMessage(
      `⚡ Auto Accept requires a one-time setup to enable background mode in ${ideName}. ` +
      `This will restart the IDE with the necessary permissions.`,
      { modal: false },
      'Setup & Restart',
      'Not Now',
    );

    this.logger.info(`[Relauncher] User chose: ${choice ?? 'dismissed'}`);

    if (choice === 'Setup & Restart') {
      try {
        const result = await this.relaunchWithCDP();
        return result.success ? 'relaunched' : 'failed';
      } catch (err) {
        this.logger.error(`[Relauncher] Setup failed: ${err}`);
        vscode.window.showErrorMessage(`CDP setup failed: ${err}`);
        return 'failed';
      }
    }

    return 'cancelled';
  }


  // ── Shortcut Detection ─────────────────────────────────

  /**
   * Find IDE shortcuts/launchers on the current platform.
   */
  async findIDEShortcuts(): Promise<ShortcutInfo[]> {
    const ideName = this.getIdeName();
    this.logger.debug(`[Relauncher] Finding shortcuts for: ${ideName}`);

    if (this.platform === 'win32') {
      return this.findWindowsShortcuts(ideName);
    } else if (this.platform === 'darwin') {
      return this.findMacOSShortcuts(ideName);
    } else {
      return this.findLinuxShortcuts(ideName);
    }
  }

  // ── Windows: .lnk shortcuts ────────────────────────────

  private async findWindowsShortcuts(ideName: string): Promise<ShortcutInfo[]> {
    const shortcuts: ShortcutInfo[] = [];
    const env = process.env;
    const possiblePaths = [
      // System-wide Start Menu (ProgramData) — CRITICAL: Cursor installs here!
      path.join(
        env['ProgramData'] || env['ALLUSERSPROFILE'] || 'C:\\ProgramData',
        'Microsoft', 'Windows', 'Start Menu', 'Programs', ideName, `${ideName}.lnk`,
      ),
      // User Start Menu (APPDATA\Roaming)
      path.join(
        env['APPDATA'] || '',
        'Microsoft', 'Windows', 'Start Menu', 'Programs', ideName, `${ideName}.lnk`,
      ),
      // Desktop (standard path)
      path.join(env['USERPROFILE'] || '', 'Desktop', `${ideName}.lnk`),
      // Desktop (OneDrive path — Vietnamese locale)
      path.join(env['USERPROFILE'] || '', 'OneDrive', 'Máy tính', `${ideName}.lnk`),
      // Desktop (OneDrive path — English locale)
      path.join(env['USERPROFILE'] || '', 'OneDrive', 'Desktop', `${ideName}.lnk`),
      // Desktop (via OneDrive env var)
      ...(env['OneDriveConsumer']
        ? [path.join(env['OneDriveConsumer'], 'Desktop', `${ideName}.lnk`)]
        : []),
      // Taskbar
      path.join(
        env['APPDATA'] || '',
        'Microsoft', 'Internet Explorer', 'Quick Launch',
        'User Pinned', 'TaskBar', `${ideName}.lnk`,
      ),
    ];

    // Deduplicate paths (OneDrive paths may overlap)
    const uniquePaths = [...new Set(possiblePaths)];

    for (const shortcutPath of uniquePaths) {
      if (fs.existsSync(shortcutPath)) {
        const info = this.readWindowsShortcut(shortcutPath);
        shortcuts.push({
          path: shortcutPath,
          hasFlag: info.hasFlag,
          type: shortcutPath.includes('Start Menu') ? 'startmenu'
            : shortcutPath.includes('Desktop') || shortcutPath.includes('Máy tính') ? 'desktop'
              : 'taskbar',
          args: info.args,
          target: info.target,
        });
      }
    }

    this.logger.debug(`[Relauncher] Found ${shortcuts.length} Windows shortcuts`);
    return shortcuts;
  }

  /**
   * Read a Windows .lnk shortcut via PowerShell to get its Arguments and TargetPath.
   */
  /** Write a PowerShell script with UTF-8 BOM encoding (required for Vietnamese/Unicode paths). */
  private writePsScript(scriptPath: string, content: string): void {
    // UTF-8 BOM: EF BB BF — required for PowerShell to handle Unicode paths correctly
    const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const body = Buffer.from(content, 'utf8');
    fs.writeFileSync(scriptPath, Buffer.concat([bom, body]));
  }

  private readWindowsShortcut(shortcutPath: string): { args: string; target: string; hasFlag: boolean } {
    const scriptPath = path.join(os.tmpdir(), `auto_accept_read_${Date.now()}.ps1`);

    try {
      // Escape path for PowerShell single-quoted string
      const escapedPath = shortcutPath.replace(/'/g, "''");
      const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut('${escapedPath}')
    Write-Output "ARGS:$($shortcut.Arguments)"
    Write-Output "TARGET:$($shortcut.TargetPath)"
} catch {
    Write-Output "ERROR:$($_.Exception.Message)"
}
`;
      this.writePsScript(scriptPath, psScript);

      const result = execSync(
        `powershell -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}"`,
        { encoding: 'utf8', timeout: 10000 },
      );

      const lines = result.split('\n').map(l => l.replace(/\r$/, '').trim()).filter(l => l);
      const errorLine = lines.find(l => l.startsWith('ERROR:'));
      if (errorLine) {
        this.logger.debug(`[Relauncher] Error reading shortcut: ${errorLine.slice(6)}`);
        return { args: '', target: '', hasFlag: false };
      }

      const argsLine = lines.find(l => l.startsWith('ARGS:')) ?? 'ARGS:';
      const targetLine = lines.find(l => l.startsWith('TARGET:')) ?? 'TARGET:';
      const args = argsLine.slice(5);
      const target = targetLine.slice(7);
      const hasFlag = args.includes('--remote-debugging-port');

      this.logger.debug(`[Relauncher] Shortcut: args="${args}", hasFlag=${hasFlag}`);
      return { args, target, hasFlag };
    } catch (e) {
      this.logger.debug(`[Relauncher] Error reading ${shortcutPath}: ${e}`);
      return { args: '', target: '', hasFlag: false };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    }
  }

  // ── macOS: .app bundles + wrapper scripts ──────────────

  private async findMacOSShortcuts(ideName: string): Promise<ShortcutInfo[]> {
    const shortcuts: ShortcutInfo[] = [];

    // Check for existing wrapper script
    const wrapperPath = path.join(os.homedir(), '.local', 'bin', `${ideName.toLowerCase()}-cdp`);
    if (fs.existsSync(wrapperPath)) {
      const content = fs.readFileSync(wrapperPath, 'utf8');
      shortcuts.push({
        path: wrapperPath,
        hasFlag: content.includes('--remote-debugging-port'),
        type: 'wrapper',
      });
    }

    // Check for .app bundle
    const appPath = `/Applications/${ideName}.app`;
    if (fs.existsSync(appPath)) {
      shortcuts.push({ path: appPath, hasFlag: false, type: 'app' });
    }

    this.logger.debug(`[Relauncher] Found ${shortcuts.length} macOS shortcuts/apps`);
    return shortcuts;
  }

  // ── Linux: .desktop files ──────────────────────────────

  private async findLinuxShortcuts(ideName: string): Promise<ShortcutInfo[]> {
    const shortcuts: ShortcutInfo[] = [];
    const locations = [
      path.join(os.homedir(), '.local', 'share', 'applications', `${ideName.toLowerCase()}.desktop`),
      `/usr/share/applications/${ideName.toLowerCase()}.desktop`,
    ];

    for (const desktopPath of locations) {
      if (fs.existsSync(desktopPath)) {
        const content = fs.readFileSync(desktopPath, 'utf8');
        const execMatch = content.match(/^Exec=(.*)$/m);
        const execLine = execMatch ? execMatch[1] : '';

        shortcuts.push({
          path: desktopPath,
          hasFlag: execLine.includes('--remote-debugging-port'),
          type: desktopPath.includes('.local') ? 'user' : 'system',
          execLine,
        });
      }
    }

    this.logger.debug(`[Relauncher] Found ${shortcuts.length} Linux .desktop files`);
    return shortcuts;
  }

  // ── Shortcut Modification ──────────────────────────────

  /**
   * Ensure a shortcut has the --remote-debugging-port flag.
   * Delegates to platform-specific implementations.
   */
  async ensureShortcutHasFlag(shortcut: ShortcutInfo): Promise<ModifyResult> {
    if (shortcut.hasFlag) {
      return { success: true, modified: false, message: 'Already has CDP flag' };
    }

    if (this.platform === 'win32') {
      return this.modifyWindowsShortcut(shortcut.path);
    } else if (this.platform === 'darwin') {
      return this.createMacOSWrapper();
    } else {
      return this.modifyLinuxDesktop(shortcut.path);
    }
  }

  /**
   * Windows: Modify .lnk shortcut Arguments via PowerShell.
   */
  private modifyWindowsShortcut(shortcutPath: string): ModifyResult {
    const scriptPath = path.join(os.tmpdir(), `auto_accept_modify_${Date.now()}.ps1`);
    const escapedPath = shortcutPath.replace(/'/g, "''");

    try {
      const psScript = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = "Stop"
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut('${escapedPath}')

    $currentArgs = $shortcut.Arguments
    $newPort = '${this.port}'
    $portPattern = '--remote-debugging-port=\\d+'

    if ($currentArgs -match $portPattern) {
        $shortcut.Arguments = $currentArgs -replace $portPattern, "--remote-debugging-port=$newPort"
        if ($shortcut.Arguments -ne $currentArgs) {
            $shortcut.Save()
            Write-Output "RESULT:UPDATED"
        } else {
            Write-Output "RESULT:ALREADY_CORRECT"
        }
    } else {
        $shortcut.Arguments = "--remote-debugging-port=$newPort " + $currentArgs
        $shortcut.Save()
        Write-Output "RESULT:MODIFIED"
    }
} catch {
    Write-Output "ERROR:$($_.Exception.Message)"
}
`;
      this.writePsScript(scriptPath, psScript);

      const rawResult = execSync(
        `powershell -ExecutionPolicy Bypass -NoProfile -File "${scriptPath}"`,
        { encoding: 'utf8', timeout: 10000 },
      );

      const lines = rawResult.split('\n').map(l => l.replace(/\r$/, '').trim()).filter(l => l);
      const errorLine = lines.find(l => l.startsWith('ERROR:'));
      if (errorLine) {
        const errMsg = errorLine.slice(6);
        // Detect permission/access errors — candidate for elevation
        if (errMsg.includes('Unable to save') || errMsg.includes('Access') || errMsg.includes('denied')) {
          return { success: false, modified: false, message: `Unable to save shortcut "${shortcutPath}".` };
        }
        return { success: false, modified: false, message: errMsg };
      }

      const resultLine = lines.find(l => l.startsWith('RESULT:'));
      const result = resultLine ? resultLine.slice(7).replace(/\r$/, '') : 'UNKNOWN';

      if (result === 'MODIFIED' || result === 'UPDATED') {
        return { success: true, modified: true, message: `${result}: ${path.basename(shortcutPath)}` };
      } else if (result === 'ALREADY_CORRECT') {
        return { success: true, modified: false, message: 'Already configured with correct port' };
      }

      return { success: false, modified: false, message: `Unexpected result: ${result}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.debug(`[Relauncher] Error modifying shortcut: ${msg}`);
      return { success: false, modified: false, message: msg };
    } finally {
      try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    }
  }

  /**
   * macOS: Create a wrapper bash script that calls the app with CDP flag.
   */
  private createMacOSWrapper(): ModifyResult {
    const ideName = this.getIdeName();
    const wrapperDir = path.join(os.homedir(), '.local', 'bin');
    const wrapperPath = path.join(wrapperDir, `${ideName.toLowerCase()}-cdp`);

    try {
      fs.mkdirSync(wrapperDir, { recursive: true });

      const appBundle = `/Applications/${ideName}.app`;
      const scriptContent =
        `#!/bin/bash\n# Auto Accept CDP wrapper — Generated ${new Date().toISOString()}\n` +
        `open -a "${appBundle}" --args ${this.cdpFlag} "$@"\n`;

      fs.writeFileSync(wrapperPath, scriptContent, { mode: 0o755 });
      this.logger.info(`[Relauncher] Created macOS wrapper: ${wrapperPath}`);

      return { success: true, modified: true, message: `Created wrapper: ${wrapperPath}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, modified: false, message: msg };
    }
  }

  /**
   * Linux: Modify .desktop file Exec line to add CDP flag.
   */
  private modifyLinuxDesktop(desktopPath: string): ModifyResult {
    try {
      let content = fs.readFileSync(desktopPath, 'utf8');
      const original = content;

      if (content.includes('--remote-debugging-port')) {
        content = content.replace(/--remote-debugging-port=\d+/g, this.cdpFlag);
        if (content === original) {
          return { success: true, modified: false, message: 'Already configured with correct port' };
        }
      } else {
        content = content.replace(/^(Exec=)(.*)$/m, `$1$2 ${this.cdpFlag}`);
      }

      // Write to user-local location (avoid needing root for system files)
      const userDir = path.join(os.homedir(), '.local', 'share', 'applications');
      const targetPath = desktopPath.includes('.local')
        ? desktopPath
        : path.join(userDir, path.basename(desktopPath));

      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(targetPath, content, 'utf8');

      this.logger.info(`[Relauncher] Modified Linux .desktop: ${targetPath}`);
      return { success: true, modified: true, message: `Modified: ${path.basename(targetPath)}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, modified: false, message: msg };
    }
  }

  // ── Relaunch ──────────────────────────────────────────

  /**
   * Relaunch the IDE with the CDP flag.
   * On Windows: creates a batch script for delayed launch.
   * On macOS:   uses 'open -a' for reliable app launching.
   * On Linux:   uses bash with sleep for delayed launch.
   * Then quits the current instance.
   */
  async relaunch(): Promise<void> {
    const folderPaths = (vscode.workspace.workspaceFolders || [])
      .map(f => f.uri.fsPath);

    const exePath = process.execPath;
    this.logger.info(`[Relauncher] Relaunching: ${exePath} ${this.cdpFlag}`);

    if (this.platform === 'win32') {
      // Create a batch file for reliable delayed relaunch
      const batchPath = path.join(os.tmpdir(), `relaunch_ide_${Date.now()}.bat`);
      const folderArgs = folderPaths.map(f => `"${f}"`).join(' ');
      const batchContent = [
        '@echo off',
        'REM Auto Accept - IDE Relaunch Script',
        'timeout /t 3 /nobreak >nul',
        `start "" "${exePath}" ${this.cdpFlag} ${folderArgs}`,
        'del "%~f0" & exit',
      ].join('\r\n') + '\r\n';

      fs.writeFileSync(batchPath, batchContent, 'utf8');
      this.logger.info(`[Relauncher] Created batch: ${batchPath}`);

      // Use cmd.exe /c start /min for silent, reliable execution
      spawn('cmd.exe', ['/c', 'start', '/min', '', batchPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (this.platform === 'darwin') {
      const ideName = this.getIdeName();
      const appPath = ideName === 'Code'
        ? '/Applications/Visual Studio Code.app'
        : `/Applications/${ideName}.app`;

      spawn('open', ['-a', appPath, '--args', this.cdpFlag, ...folderPaths], {
        detached: true, stdio: 'ignore',
      }).unref();
    } else {
      // Linux: bash with sleep
      const args = ['-c', `sleep 2 && exec "$@"`, '--', exePath, this.cdpFlag, ...folderPaths];
      spawn('bash', args, { detached: true, stdio: 'ignore' }).unref();
    }

    // Quit current instance after short delay to let spawn start
    setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 1000);
  }
}

/**
 * CDPSetup — Automatically enable CDP by patching argv.json
 *
 * VS Code-based IDEs read `argv.json` at boot to inject Chromium flags.
 * This module detects, patches, and prompts the user to restart once.
 *
 * Flow:
 * 1. Detect IDE type → resolve argv.json path
 * 2. Check if `remote-debugging-port` is already present
 * 3. If not → add it (preserving all existing keys) + prompt user to quit+reopen
 * 4. After full restart → CDP is automatically available on every boot
 *
 * Safety:
 * - Atomic write (write .tmp → rename) to prevent data loss
 * - Backup (.bak) created before modifying
 * - Existing keys preserved — only `remote-debugging-port` is added/updated
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { IDEType } from '../../domain/enums';
import { Logger } from '../../core/logger';

/**
 * Fallback: Maps IDE type → dataFolderName used in product.json.
 * VS Code-based IDEs store argv.json at ~/{dataFolderName}/argv.json.
 * This is only used when auto-detection from product.json fails.
 */
const IDE_DATA_FOLDER_NAMES: Record<string, string> = {
  [IDEType.Antigravity]: '.antigravity',
  [IDEType.Cursor]: '.cursor',
  [IDEType.Windsurf]: '.windsurf',
  [IDEType.Trae]: '.trae',
  [IDEType.VSCode]: '.vscode',
};

/**
 * Maps IDE type → product name used in %APPDATA%/<ProductName>/User/argv.json (Windows).
 * On Windows, Electron apps store argv.json at %APPDATA%/<ProductName>/User/argv.json
 * which is DIFFERENT from ~/<dataFolderName>/argv.json used on macOS/Linux.
 */
const IDE_PRODUCT_NAMES: Record<string, string> = {
  [IDEType.Antigravity]: 'Antigravity',
  [IDEType.Cursor]: 'Cursor',
  [IDEType.Windsurf]: 'Windsurf',
  [IDEType.Trae]: 'Trae',
  [IDEType.VSCode]: 'Code',
};

export class CDPSetup {
  private readonly port: number;

  constructor(
    private readonly ideType: IDEType,
    defaultPort: number,
    private readonly logger: Logger,
  ) {
    // Use fixed port matching adapter default (e.g. 9004 for Antigravity)
    // All open-source repos use fixed ports — auto-pick (port=0) is harder to discover
    this.port = defaultPort;
  }

  // ── Public API ───────────────────────────────────────

  /**
   * Check if CDP is already configured in ANY known argv.json file.
   * Returns true if `remote-debugging-port` is set to any number (including 0).
   * Port 0 = auto-pick (valid CDP config, port in DevToolsActivePort file).
   */
  isCDPConfigured(): boolean {
    // Check ALL possible paths — IDE may read from different locations
    const allPaths = this.getAllArgvJsonPaths();
    for (const argvPath of allPaths) {
      try {
        if (!fs.existsSync(argvPath)) continue;
        const content = fs.readFileSync(argvPath, 'utf-8');
        const json = this.parseJsonWithComments(content);
        // Accept ANY numeric value (including 0 for auto-pick) as configured
        if (typeof json['remote-debugging-port'] === 'number') {
          this.logger.debug(`CDPSetup: Found CDP config (port=${json['remote-debugging-port']}) in ${argvPath}`);
          return true;
        }
      } catch (err) {
        this.logger.debug(`CDPSetup: failed to read ${argvPath}: ${err}`);
      }
    }
    return false;
  }

  /**
   * Enable CDP by patching ALL known argv.json files with the configured port.
   * Patches both Windows (%APPDATA%) and home-dir (~/.antigravity/) paths
   * because different IDE versions read from different locations.
   * Uses atomic write (tmp → rename) with backup.
   */
  async enableCDP(): Promise<{ patched: boolean; needsRestart: boolean; error?: string }> {
    const allPaths = this.getAllArgvJsonPaths();
    if (allPaths.length === 0) {
      return {
        patched: false,
        needsRestart: false,
        error: `Cannot resolve any argv.json path for IDE: ${this.ideType}`,
      };
    }

    let anyPatched = false;
    const errors: string[] = [];

    for (const argvPath of allPaths) {
      try {
        const result = this.patchSingleArgvFile(argvPath);
        if (result.patched) {
          anyPatched = true;
          this.logger.info(`CDPSetup: Patched ${argvPath} with port ${this.port}`);
        } else if (result.skipped) {
          this.logger.debug(`CDPSetup: ${argvPath} already has port ${this.port}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${argvPath}: ${msg}`);
        this.logger.warn(`CDPSetup: Failed to patch ${argvPath}: ${msg}`);
      }
    }

    if (anyPatched) {
      return { patched: true, needsRestart: true };
    }
    if (errors.length > 0) {
      return { patched: false, needsRestart: false, error: errors.join('; ') };
    }
    return { patched: false, needsRestart: false };
  }

  /**
   * Patch a single argv.json file with the configured CDP port.
   * Preserves all existing keys — only adds/updates `remote-debugging-port`.
   */
  private patchSingleArgvFile(argvPath: string): { patched: boolean; skipped?: boolean } {
    // Ensure directory exists
    const dir = path.dirname(argvPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Read existing content and parse
    let rawContent = '';
    let json: Record<string, unknown> = {};
    if (fs.existsSync(argvPath)) {
      rawContent = fs.readFileSync(argvPath, 'utf-8');
      json = this.parseJsonWithComments(rawContent);
    }

    // Check if already configured with our port
    if (json['remote-debugging-port'] === this.port) {
      return { patched: false, skipped: true };
    }

    // Log existing value for debugging
    if (typeof json['remote-debugging-port'] === 'number') {
      this.logger.info(`CDPSetup: Updating ${argvPath}: port ${json['remote-debugging-port']} → ${this.port}`);
    }

    // Set to the adapter's fixed port
    json['remote-debugging-port'] = this.port;

    // Atomic write: .tmp → backup → rename
    const tmpPath = argvPath + '.tmp';
    const bakPath = argvPath + '.bak';
    const output = this.serializePreservingComments(rawContent, json);

    fs.writeFileSync(tmpPath, output, 'utf-8');

    // Create backup of existing file
    if (fs.existsSync(argvPath)) {
      try {
        fs.copyFileSync(argvPath, bakPath);
      } catch {
        this.logger.debug('CDPSetup: Failed to create backup, continuing...');
      }
    }

    // Atomic rename
    fs.renameSync(tmpPath, argvPath);
    return { patched: true };
  }

  /**
   * Remove CDP flag from argv.json (cleanup).
   * Preserves all other keys.
   */
  async disableCDP(): Promise<void> {
    const argvPath = this.getArgvJsonPath();
    if (!argvPath || !fs.existsSync(argvPath)) return;

    try {
      const rawContent = fs.readFileSync(argvPath, 'utf-8');
      const json = this.parseJsonWithComments(rawContent);
      delete json['remote-debugging-port'];

      const output = this.serializePreservingComments(rawContent, json);
      const tmpPath = argvPath + '.tmp';
      fs.writeFileSync(tmpPath, output, 'utf-8');
      fs.renameSync(tmpPath, argvPath);

      this.logger.info('CDPSetup: Removed CDP flag from argv.json');
    } catch (err) {
      this.logger.debug(`CDPSetup: Failed to remove CDP flag: ${err}`);
    }
  }

  /**
   * Show VS Code notification prompting user to fully quit and reopen the IDE.
   * Note: `reloadWindow` does NOT restart Electron — argv.json requires full quit+reopen.
   */
  async promptRestart(): Promise<boolean> {
    const choice = await vscode.window.showInformationMessage(
      `⚡ Auto Accept has enabled CDP (auto-detect mode). ` +
      `Please close and reopen the IDE to activate full button-clicking mode.`,
      'Close IDE Now',
      'Later (next restart)',
    );

    if (choice === 'Close IDE Now') {
      // workbench.action.quit fully shuts down Electron process
      // User must manually reopen — there is no API to auto-reopen
      await vscode.commands.executeCommand('workbench.action.quit');
      return true;
    }

    if (choice === 'Later (next restart)') {
      this.logger.info('CDPSetup: User chose to restart later — CDP will activate on next IDE start');
    }

    return false;
  }

  // ── Private ──────────────────────────────────────────

  /**
   * Get ALL possible argv.json paths for the current IDE.
   * On Windows, BOTH paths may be read by different IDE versions:
   *   1. %APPDATA%/<ProductName>/User/argv.json (Electron standard)
   *   2. ~/<dataFolderName>/argv.json (VS Code legacy, some forks)
   *
   * We patch ALL found paths to ensure maximum compatibility.
   */
  private getAllArgvJsonPaths(): string[] {
    const paths: string[] = [];

    // Path 1: Home directory (~/.antigravity/argv.json)
    // MANY Antigravity versions read from here on ALL platforms
    const dataFolderName = this.detectDataFolderName();
    if (dataFolderName) {
      const homePath = path.join(os.homedir(), dataFolderName, 'argv.json');
      if (fs.existsSync(homePath) || fs.existsSync(path.dirname(homePath))) {
        paths.push(homePath);
      }
    }

    // Path 2: Windows APPDATA (%APPDATA%/Antigravity/User/argv.json)
    if (os.platform() === 'win32') {
      const windowsPath = this.getWindowsArgvPath();
      if (windowsPath && !paths.includes(windowsPath)) {
        paths.push(windowsPath);
      }
    }

    return paths;
  }

  /**
   * Get the primary argv.json path (for backward compatibility).
   * Prefers home-dir path since that's where most IDE forks read from.
   */
  getArgvJsonPath(): string | null {
    const allPaths = this.getAllArgvJsonPaths();
    return allPaths[0] ?? null;
  }

  /**
   * Windows-specific: Resolve argv.json via %APPDATA%/<ProductName>/User/argv.json.
   * Checks if the file actually exists before returning the path.
   */
  private getWindowsArgvPath(): string | null {
    const appData = process.env['APPDATA'];
    if (!appData) return null;

    // Try product.json productName first
    try {
      const appRoot = vscode.env.appRoot;
      if (appRoot) {
        const productPath = path.join(appRoot, 'product.json');
        if (fs.existsSync(productPath)) {
          const content = fs.readFileSync(productPath, 'utf-8');
          const product = JSON.parse(content) as { nameShort?: string; applicationName?: string };
          const productName = product.nameShort ?? product.applicationName;
          if (productName) {
            const candidate = path.join(appData, productName, 'User', 'argv.json');
            if (fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
              return candidate;
            }
          }
        }
      }
    } catch { /* ignore */ }

    // Fallback: hardcoded product names
    const productName = IDE_PRODUCT_NAMES[this.ideType];
    if (productName) {
      const candidate = path.join(appData, productName, 'User', 'argv.json');
      // Accept if file or parent directory exists
      if (fs.existsSync(candidate) || fs.existsSync(path.dirname(candidate))) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Auto-detect the IDE's dataFolderName from product.json.
   * Falls back to hardcoded mapping if product.json is unavailable.
   */
  private detectDataFolderName(): string | null {
    // Layer 1: Read from product.json via vscode.env.appRoot
    try {
      const appRoot = vscode.env.appRoot;
      if (appRoot) {
        const productPath = path.join(appRoot, 'product.json');
        if (fs.existsSync(productPath)) {
          const content = fs.readFileSync(productPath, 'utf-8');
          const product = JSON.parse(content) as { dataFolderName?: string };
          if (product.dataFolderName) {
            this.logger.debug(`CDPSetup: dataFolderName from product.json: ${product.dataFolderName}`);
            return product.dataFolderName;
          }
        }
      }
    } catch (err) {
      this.logger.debug(`CDPSetup: Failed to read product.json: ${err}`);
    }

    // Layer 2: Hardcoded fallback
    const folderName = IDE_DATA_FOLDER_NAMES[this.ideType];
    if (folderName) {
      this.logger.debug(`CDPSetup: Using fallback dataFolderName: ${folderName}`);
      return folderName;
    }

    return null;
  }

  /**
   * Parse JSON that may contain // comments (VS Code's argv.json format).
   * Strips single-line comments before parsing.
   */
  private parseJsonWithComments(raw: string): Record<string, unknown> {
    // Remove single-line comments (// ...) but not inside strings
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '');
    try {
      return JSON.parse(stripped) as Record<string, unknown>;
    } catch {
      // If still fails, try removing trailing commas
      const cleaned = stripped.replace(/,\s*([\]}])/g, '$1');
      return JSON.parse(cleaned) as Record<string, unknown>;
    }
  }

  /**
   * Serialize JSON while preserving comment lines from the original file.
   * If original content had comments, they are kept above the JSON.
   */
  private serializePreservingComments(
    originalContent: string,
    json: Record<string, unknown>,
  ): string {
    // Extract comment lines from original file
    const commentLines: string[] = [];
    if (originalContent) {
      for (const line of originalContent.split('\n')) {
        if (line.trimStart().startsWith('//')) {
          commentLines.push(line);
        }
      }
    }

    // If no original comments, add default header
    if (commentLines.length === 0) {
      commentLines.push(
        '// This file is auto-managed by the IDE runtime.',
        '// Auto Accept extension has added "remote-debugging-port" for CDP support.',
      );
    }

    return [...commentLines, JSON.stringify(json, null, '\t'), ''].join('\n');
  }
}

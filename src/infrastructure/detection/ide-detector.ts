/**
 * IDEDetector — Auto-detect current IDE and discover CDP port dynamically
 *
 * Detection: checks appName and process.argv to determine which IDE.
 * Port discovery: 5-layer async cascade:
 *   1. process.argv --remote-debugging-port=N (current session, instant)
 *   2. PID-based process scan (find IDE → get listening ports → probe CDP)
 *   3. DevToolsActivePort file (with liveness validation)
 *   4. Port range sweep (parallel HTTP probes on common CDP ranges)
 *   5. Adapter default port (fallback, no validation)
 *
 * Every discovered port is validated via HTTP GET /json to confirm it's
 * actually a CDP endpoint — stale files and port conflicts no longer break us.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as childProcess from 'child_process';
import { IDEType } from '../../domain/enums';

interface IDEDetection {
  readonly type: IDEType;
  readonly pattern: RegExp;
  readonly defaultPort: number;
  readonly launchFlag: string;
  /** Process name(s) for PID-based scan */
  readonly processNames: string[];
}

/** Detection rules — ordered by specificity */
const DETECTIONS: IDEDetection[] = [
  {
    type: IDEType.Antigravity,
    pattern: /antigravity/i,
    defaultPort: 9004,
    launchFlag: '--remote-debugging-port=9004',
    processNames: ['Antigravity.exe', 'antigravity'],
  },
  {
    type: IDEType.Cursor,
    pattern: /cursor/i,
    defaultPort: 9222,
    launchFlag: '--remote-debugging-port=9222',
    processNames: ['Cursor.exe', 'cursor'],
  },
  {
    type: IDEType.Windsurf,
    pattern: /windsurf/i,
    defaultPort: 9224,
    launchFlag: '--remote-debugging-port=9224',
    processNames: ['Windsurf.exe', 'windsurf'],
  },
  {
    type: IDEType.Trae,
    pattern: /trae/i,
    defaultPort: 9005,
    launchFlag: '--remote-debugging-port=9005',
    processNames: ['Trae.exe', 'trae'],
  },
  {
    type: IDEType.VSCode,
    pattern: /code|vscode/i,
    defaultPort: 9229,
    launchFlag: '--remote-debugging-port=9229',
    processNames: ['Code.exe', 'code'],
  },
];

/** Maps IDE type → Electron data directory name */
const IDE_DATA_DIRS: Record<string, string> = {
  [IDEType.Antigravity]: 'Antigravity',
  [IDEType.Cursor]: 'Cursor',
  [IDEType.Windsurf]: 'Windsurf',
  [IDEType.Trae]: 'Trae',
  [IDEType.VSCode]: 'Code',
};

export interface DetectionResult {
  readonly ideType: IDEType;
  readonly defaultPort: number;
  readonly launchFlag: string;
  readonly source: 'appName' | 'argv' | 'fallback';
}

export interface PortDiscoveryResult {
  readonly port: number;
  readonly source: 'process.argv' | 'process-scan' | 'DevToolsActivePort' | 'port-sweep' | 'adapter-default';
  readonly validated: boolean;
}

export class IDEDetector {
  /** Detect the current IDE */
  detect(): DetectionResult {
    // Try appName first (most reliable)
    const appName = this.getAppName();
    if (appName) {
      for (const d of DETECTIONS) {
        if (d.pattern.test(appName)) {
          return {
            ideType: d.type,
            defaultPort: d.defaultPort,
            launchFlag: d.launchFlag,
            source: 'appName',
          };
        }
      }
    }

    // Try process.argv
    const argv = process.argv.join(' ');
    for (const d of DETECTIONS) {
      if (d.pattern.test(argv)) {
        return {
          ideType: d.type,
          defaultPort: d.defaultPort,
          launchFlag: d.launchFlag,
          source: 'argv',
        };
      }
    }

    // Check if CDP port is in argv (for any IDE)
    const portMatch = argv.match(/--remote-debugging-port=(\d+)/);
    if (portMatch) {
      const port = parseInt(portMatch[1], 10);
      // Try to match by port
      for (const d of DETECTIONS) {
        if (d.defaultPort === port) {
          return {
            ideType: d.type,
            defaultPort: port,
            launchFlag: d.launchFlag,
            source: 'argv',
          };
        }
      }
    }

    // Fallback
    return {
      ideType: IDEType.Unknown,
      defaultPort: 9229,
      launchFlag: '--remote-debugging-port=9229',
      source: 'fallback',
    };
  }

  /**
   * Smart CDP port discovery — 5-layer async cascade.
   * Every port is validated via HTTP probe before returning.
   *
   * With port=0 in argv.json, Chromium auto-picks a free port and writes
   * it to DevToolsActivePort. That file is now the primary discovery source.
   */
  async discoverCDPPort(ideType: IDEType, fallbackPort: number): Promise<PortDiscoveryResult> {
    // Layer 1: DevToolsActivePort (canonical source when port=0)
    // With auto-pick, this file contains the actual port Chromium chose
    const dtapPort = this.readDevToolsActivePort(ideType);
    if (dtapPort && dtapPort > 0 && await this.probeCDP(dtapPort)) {
      return { port: dtapPort, source: 'DevToolsActivePort', validated: true };
    }

    // Layer 2: process.argv (useful if IDE was launched with a fixed port)
    const argvPort = this.getActiveCDPPort();
    if (argvPort && argvPort > 0 && await this.probeCDP(argvPort)) {
      return { port: argvPort, source: 'process.argv', validated: true };
    }

    // Layer 3: PID-based process scan
    const detection = DETECTIONS.find(d => d.type === ideType);
    if (detection) {
      const scannedPort = await this.scanProcessPorts(detection.processNames);
      if (scannedPort) {
        return { port: scannedPort, source: 'process-scan', validated: true };
      }
    }

    // Layer 4: Port range sweep (parallel probe)
    const sweepPorts = [
      ...range(8999, 9011), // Common CDP range
      ...range(9222, 9231), // Chrome/Cursor default range
    ];
    const sweptPort = await this.sweepPortRange(sweepPorts);
    if (sweptPort) {
      return { port: sweptPort, source: 'port-sweep', validated: true };
    }

    // Layer 5: Adapter default (no validation — for retry timer setup)
    return { port: fallbackPort, source: 'adapter-default', validated: false };
  }

  /** Get active CDP port from process args, or null */
  getActiveCDPPort(): number | null {
    const argv = process.argv.join(' ');
    const match = argv.match(/--remote-debugging-port=(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }

  /** Check if the IDE was launched with CDP enabled */
  isCDPEnabled(): boolean {
    return this.getActiveCDPPort() !== null;
  }

  // ── Port discovery helpers ────────────────────────────

  /**
   * Probe a port for CDP /json endpoint.
   * Returns true only if the response is valid JSON (CDP target list).
   * Timeout: 1.5s per probe to keep total discovery fast.
   */
  async probeCDP(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const req = http.get(`http://127.0.0.1:${port}/json`, { timeout: 1500 }, res => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // CDP returns an array of targets. V8 Node.js inspectors also
            // return an array, so we must distinguish:
            // - Chromium CDP targets have type: "page", "background_page", etc.
            // - V8 Node.js inspectors have type: "node"
            // Reject ports where ALL targets are type:"node" (V8 inspector)
            if (!Array.isArray(parsed) || parsed.length === 0) {
              resolve(false);
              return;
            }
            const hasChromeTarget = parsed.some(
              (t: { type?: string }) => t.type && t.type !== 'node',
            );
            resolve(hasChromeTarget);
          } catch {
            resolve(false);
          }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  /**
   * Scan running IDE processes for listening ports, probe each for CDP.
   * Uses platform-specific process introspection.
   *
   * Windows: wmic+netstat (most reliable, no admin needed)
   * macOS/Linux: lsof -i -P
   */
  private async scanProcessPorts(processNames: string[]): Promise<number | null> {
    try {
      const platform = os.platform();

      if (platform === 'win32') {
        return await this.scanProcessPortsWindows(processNames);
      } else {
        return await this.scanProcessPortsPosix(processNames);
      }
    } catch {
      return null;
    }
  }

  /** Windows: Find IDE PIDs via wmic → get listening ports via netstat → probe */
  private async scanProcessPortsWindows(processNames: string[]): Promise<number | null> {
    try {
      // Step 1: Get PIDs for the IDE process
      const pids: string[] = [];
      for (const name of processNames) {
        try {
          const out = childProcess.execSync(
            `wmic process where "name='${name}'" get ProcessId /format:csv`,
            { encoding: 'utf-8', timeout: 5000, windowsHide: true },
          );
          const matches = out.match(/,(\d+)/g);
          if (matches) {
            pids.push(...matches.map(m => m.slice(1)));
          }
        } catch {
          continue;
        }
      }

      if (pids.length === 0) return null;

      // Step 2: Get all listening ports from netstat
      const netstatOut = childProcess.execSync(
        'netstat -aon',
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      );

      // Step 3: Find listening ports belonging to our PIDs
      const pidSet = new Set(pids);
      const ports: number[] = [];
      for (const line of netstatOut.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (!pidSet.has(pid)) continue;

        const addrPort = parts[1]; // e.g. "0.0.0.0:9004" or "[::]:9004"
        const portMatch = addrPort.match(/:(\d+)$/);
        if (portMatch) {
          ports.push(parseInt(portMatch[1], 10));
        }
      }

      // Deduplicate and sort (prefer lower ports = more likely CDP)
      const uniquePorts = [...new Set(ports)].sort((a, b) => a - b);

      // Step 4: Probe each port for CDP
      for (const port of uniquePorts) {
        if (await this.probeCDP(port)) {
          return port;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /** macOS/Linux: Find IDE process ports via lsof → probe */
  private async scanProcessPortsPosix(processNames: string[]): Promise<number | null> {
    try {
      const ports: number[] = [];
      for (const name of processNames) {
        try {
          // lsof -i -P -n: list network connections with numeric ports
          const out = childProcess.execSync(
            `lsof -i -P -n | grep -i "${name}" | grep LISTEN`,
            { encoding: 'utf-8', timeout: 5000 },
          );
          for (const line of out.split('\n')) {
            const match = line.match(/:(\d+)\s+\(LISTEN\)/);
            if (match) {
              ports.push(parseInt(match[1], 10));
            }
          }
        } catch {
          continue;
        }
      }

      const uniquePorts = [...new Set(ports)].sort((a, b) => a - b);
      for (const port of uniquePorts) {
        if (await this.probeCDP(port)) {
          return port;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read DevToolsActivePort file from IDE's Electron data directory.
   * Returns the port number or null. Does NOT validate liveness.
   */
  private readDevToolsActivePort(ideType: IDEType): number | null {
    const dataDir = this.getIDEDataDir(ideType);
    if (!dataDir) return null;

    const activePortFile = path.join(dataDir, 'DevToolsActivePort');
    try {
      if (!fs.existsSync(activePortFile)) return null;
      const content = fs.readFileSync(activePortFile, 'utf-8').trim();
      const firstLine = content.split('\n')[0]?.trim();
      const port = parseInt(firstLine, 10);
      return (port > 0 && port < 65536) ? port : null;
    } catch {
      return null;
    }
  }

  /**
   * Parallel sweep a range of ports for CDP /json endpoint.
   * Returns the first port that responds with valid CDP targets.
   * All probes run in parallel for speed (~1.5s total max).
   */
  private async sweepPortRange(ports: number[]): Promise<number | null> {
    const results = await Promise.all(
      ports.map(async port => ({
        port,
        ok: await this.probeCDP(port),
      })),
    );
    return results.find(r => r.ok)?.port ?? null;
  }

  /**
   * Resolve IDE's Electron data directory (where DevToolsActivePort lives).
   *   Windows: %APPDATA%/{IDEDir}/
   *   macOS:   ~/Library/Application Support/{IDEDir}/
   *   Linux:   ~/.config/{IDEDir}/
   */
  private getIDEDataDir(ideType: IDEType): string | null {
    const dirName = IDE_DATA_DIRS[ideType];
    if (!dirName) return null;

    const platform = os.platform();
    switch (platform) {
      case 'win32': {
        const appData = process.env['APPDATA'];
        return appData ? path.join(appData, dirName) : null;
      }
      case 'darwin':
        return path.join(os.homedir(), 'Library', 'Application Support', dirName);
      case 'linux':
        return path.join(os.homedir(), '.config', dirName);
      default:
        return null;
    }
  }

  private getAppName(): string | null {
    // VS Code-based IDEs set this in process.env
    return (
      process.env['VSCODE_PID'] ? null : // Raw VS Code doesn't have a custom app name marker
      process.env['APPLICATION_NAME'] ??
      process.env['APP_NAME'] ??
      null
    );
  }
}

/** Generate a range of integers [start, end) */
function range(start: number, end: number): number[] {
  const result: number[] = [];
  for (let i = start; i < end; i++) result.push(i);
  return result;
}

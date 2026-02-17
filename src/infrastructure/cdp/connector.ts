/**
 * CDPConnector — Chrome DevTools Protocol WebSocket connection manager
 *
 * Multi-target: Connects to ALL matching CDP targets (pages + webviews).
 * SRP: Only handles CDP WebSocket communication.
 * Uses `ws` library for WebSocket connections.
 */

import * as http from 'http';
import WebSocket from 'ws';
import { EventEmitter } from 'vscode';
import { ICDPConnector } from '../../domain/interfaces/cdp-connector';
import {
  CDPTarget,
  ConnectionState,
  EvalResult,
  ExecutionContextInfo,
} from '../../domain/types/connection';
import { Logger } from '../../core/logger';
import { ReconnectStrategy } from './reconnect';

/** Timeout for CDP commands (ms) */
const DEFAULT_TIMEOUT = 5_000;

/** Internal state for a single WebSocket connection to a CDP target */
interface TargetConnection {
  ws: WebSocket;
  targetId: string;
  targetTitle: string;
  msgId: number;
  pending: Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

export class CDPConnector implements ICDPConnector {
  /** Active connections keyed by "port:targetId" */
  private readonly connections = new Map<string, TargetConnection>();
  private _state = ConnectionState.Disconnected;
  private readonly reconnect: ReconnectStrategy;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentPort = 0;
  private _filterTargets: ((targets: CDPTarget[]) => CDPTarget[]) | null = null;

  // Execution context tracking for iframes
  private readonly executionContexts = new Map<number, ExecutionContextInfo>();
  private runtimeEnabled = false;

  // VS Code event emitters
  private readonly _onStateChange = new EventEmitter<ConnectionState>();
  private readonly _onError = new EventEmitter<Error>();
  readonly onStateChange = this._onStateChange.event;
  readonly onError = this._onError.event;

  constructor(private readonly logger: Logger) {
    this.reconnect = new ReconnectStrategy();
  }

  get state(): ConnectionState {
    return this._state;
  }

  get connectionCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) count++;
    }
    return count;
  }

  async connect(port: number, filterTargets?: (targets: CDPTarget[]) => CDPTarget[]): Promise<void> {
    this.currentPort = port;
    this._filterTargets = filterTargets ?? null;
    this.setState(ConnectionState.Connecting);

    try {
      let targets = await this.getTargets(port);
      if (filterTargets) {
        targets = filterTargets(targets);
      }
      if (targets.length === 0) {
        throw new Error('No CDP targets found');
      }

      // Connect to ALL matching targets (not just the first)
      let connectedCount = 0;
      for (const target of targets) {
        const id = `${port}:${target.id}`;
        if (this.connections.has(id)) {
          connectedCount++;
          continue; // Already connected
        }

        try {
          this.logger.info(`Connecting to CDP target: ${target.title} [${target.type}] (${target.id})`);
          await this.connectToTarget(id, target);
          connectedCount++;
        } catch (err) {
          this.logger.warn(`Failed to connect to target ${target.title}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (connectedCount === 0) {
        throw new Error('Failed to connect to any CDP target');
      }

      this.logger.info(`Connected to ${connectedCount}/${targets.length} CDP targets`);
      this.reconnect.reset();
      this.setState(ConnectionState.Connected);
    } catch (err) {
      this.logger.warn(`CDP connection failed: ${err instanceof Error ? err.message : String(err)}`);
      this.setState(ConnectionState.Failed);
      this._onError.fire(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.clearReconnectTimer();

    for (const [id, conn] of this.connections) {
      this.clearPending(conn, 'Connection closed');
      conn.ws.removeAllListeners();
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
      this.logger.debug(`Disconnected from target ${id}`);
    }
    this.connections.clear();
    this.setState(ConnectionState.Disconnected);
  }

  async evaluate(expression: string, timeout = DEFAULT_TIMEOUT): Promise<EvalResult> {
    return this.evaluateInContext(expression, undefined, timeout);
  }

  /**
   * Evaluate expression across connected targets with EARLY-EXIT.
   * Stops after the first target that reports clicks > 0 to prevent
   * double-clicking when multiple targets can reach the same buttons
   * (e.g. both Launchpad and workbench crawl into the same chat iframe).
   */
  async evaluateAll(expression: string, timeout = DEFAULT_TIMEOUT): Promise<EvalResult[]> {
    const results: EvalResult[] = [];
    for (const [id, conn] of this.connections) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      try {
        const result = await this.evaluateOn(conn, expression, undefined, timeout);
        results.push(result);

        // Early-exit: stop if this target already clicked buttons
        if (result.success && result.value) {
          try {
            const parsed = typeof result.value === 'string' ? JSON.parse(result.value) : result.value;
            if (parsed && typeof parsed === 'object' && Number((parsed as Record<string, unknown>).clicks) > 0) {
              this.logger.debug(`[evaluateAll] Target "${conn.targetTitle || id}" clicked — skipping remaining targets`);
              break;
            }
          } catch { /* parse error — continue */ }
        }
      } catch {
        this.logger.debug(`Evaluate failed on target ${id}`);
      }
    }
    return results;
  }

  async evaluateInContext(expression: string, contextId?: number, timeout = DEFAULT_TIMEOUT): Promise<EvalResult> {
    // Find the first open connection
    for (const conn of this.connections.values()) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        return this.evaluateOn(conn, expression, contextId, timeout);
      }
    }
    return { success: false, value: undefined, error: 'Not connected' };
  }

  private async evaluateOn(
    conn: TargetConnection,
    expression: string,
    contextId?: number,
    timeout = DEFAULT_TIMEOUT,
  ): Promise<EvalResult> {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      return { success: false, value: undefined, error: 'Not connected' };
    }

    try {
      const params: Record<string, unknown> = {
        expression,
        returnByValue: true,
        awaitPromise: true, // Ensure async expressions resolve properly (matches open-source CDP handlers)
        userGesture: true, // Required for click() to be trusted
      };
      if (contextId !== undefined) {
        params.contextId = contextId;
      }

      const result = await this.sendOn(conn, 'Runtime.evaluate', params, timeout);
      const response = result as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };

      if (response.exceptionDetails) {
        return {
          success: false,
          value: undefined,
          error: response.exceptionDetails.text ?? 'Unknown eval error',
        };
      }

      return {
        success: true,
        value: response.result?.value,
      };
    } catch (err) {
      return {
        success: false,
        value: undefined,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async inject(script: string): Promise<void> {
    const result = await this.evaluate(script);
    if (!result.success) {
      throw new Error(`Script injection failed: ${result.error}`);
    }
  }

  async getTargets(port: number): Promise<CDPTarget[]> {
    return new Promise<CDPTarget[]>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try {
            const targets = JSON.parse(data) as CDPTarget[];
            // Include pages, webviews, AND iframes — all may contain Accept buttons
            resolve(targets.filter(t =>
              (t.type === 'page' || t.type === 'webview' || t.type === 'iframe') && t.webSocketDebuggerUrl,
            ));
          } catch (e) {
            reject(new Error(`Failed to parse CDP targets: ${e}`));
          }
        });
      });
      req.on('error', (err) => {
        reject(new Error(`CDP discovery failed on port ${port}: ${err.message}`));
      });
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error(`CDP discovery timeout on port ${port}`));
      });
    });
  }

  // ── Iframe execution context tracking ────────────

  async enableRuntimeEvents(): Promise<void> {
    if (this.runtimeEnabled) return;

    let enabled = false;
    for (const [, conn] of this.connections) {
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      try {
        await this.sendOn(conn, 'Runtime.enable', {}, DEFAULT_TIMEOUT);
        enabled = true;
      } catch (err) {
        this.logger.warn(`Failed to enable Runtime domain on ${conn.targetId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (enabled) {
      this.runtimeEnabled = true;
      this.logger.debug('Runtime domain enabled — tracking execution contexts');
    }
  }

  getIframeContexts(urlPatterns?: string[]): ExecutionContextInfo[] {
    const contexts = Array.from(this.executionContexts.values());
    if (!urlPatterns || urlPatterns.length === 0) {
      // Return all non-main-frame contexts (iframes)
      return contexts.filter(c => !c.isDefault || c.frameUrl !== '');
    }
    return contexts.filter(ctx =>
      urlPatterns.some(pattern =>
        ctx.frameUrl.includes(pattern) ||
        ctx.name.includes(pattern) ||
        ctx.origin.includes(pattern),
      ),
    );
  }

  dispose(): void {
    this.disconnect().catch(() => {});
    this._onStateChange.dispose();
    this._onError.dispose();
  }

  // ── Private methods ────────────────────────────

  private connectToTarget(id: string, target: CDPTarget): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);

      const connectTimeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        ws.close();
      }, 5000);

      ws.on('open', () => {
        clearTimeout(connectTimeout);
        const conn: TargetConnection = {
          ws,
          targetId: target.id,
          targetTitle: target.title,
          msgId: 0,
          pending: new Map(),
        };
        this.connections.set(id, conn);
        this.logger.info(`CDP WebSocket connected: ${target.title} [${target.type}]`);
        resolve();
      });

      ws.on('message', (data: WebSocket.Data) => {
        const conn = this.connections.get(id);
        if (conn) this.handleMessage(conn, data.toString());
      });

      ws.on('close', () => {
        clearTimeout(connectTimeout);
        const conn = this.connections.get(id);
        if (conn) {
          this.clearPending(conn, 'WebSocket closed');
          this.connections.delete(id);
          this.logger.warn(`CDP WebSocket closed: ${target.title}`);
        }
        this.checkConnectionState();
      });

      ws.on('error', (err: Error) => {
        clearTimeout(connectTimeout);
        this.logger.error(`CDP WebSocket error on ${target.title}`, err);
        this._onError.fire(err);
      });
    });
  }

  private sendOn(conn: TargetConnection, method: string, params: Record<string, unknown>, timeout: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (conn.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Not connected'));
      }

      const id = ++conn.msgId;
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeout);

      conn.pending.set(id, { resolve, reject, timer });
      conn.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private handleMessage(conn: TargetConnection, raw: string): void {
    try {
      const msg = JSON.parse(raw) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
        method?: string;
        params?: Record<string, unknown>;
      };

      // Handle CDP events (no id field)
      if (msg.method) {
        this.handleCDPEvent(msg.method, msg.params ?? {});
        return;
      }

      if (msg.id !== undefined) {
        const pending = conn.pending.get(msg.id);
        if (pending) {
          conn.pending.delete(msg.id);
          clearTimeout(pending.timer);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      }
    } catch {
      // Ignore unparseable messages
    }
  }

  private handleCDPEvent(method: string, params: Record<string, unknown>): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context as {
        id: number;
        origin: string;
        name: string;
        auxData?: { isDefault?: boolean; frameId?: string; type?: string };
      } | undefined;
      if (!context) return;

      const info: ExecutionContextInfo = {
        contextId: context.id,
        origin: context.origin || '',
        frameUrl: context.name || '',
        name: context.name || '',
        isDefault: context.auxData?.isDefault ?? false,
      };
      this.executionContexts.set(context.id, info);
      this.logger.debug(
        `Execution context created: id=${context.id} name="${context.name}" origin="${context.origin}" isDefault=${info.isDefault}`,
      );
    } else if (method === 'Runtime.executionContextDestroyed') {
      const contextId = params.executionContextId as number | undefined;
      if (contextId !== undefined) {
        this.executionContexts.delete(contextId);
        this.logger.debug(`Execution context destroyed: id=${contextId}`);
      }
    } else if (method === 'Runtime.executionContextsCleared') {
      this.executionContexts.clear();
      this.logger.debug('All execution contexts cleared');
    }
  }

  /** Check if all connections are gone and trigger reconnect */
  private checkConnectionState(): void {
    if (this.connections.size === 0 && this._state === ConnectionState.Connected) {
      this.executionContexts.clear();
      this.runtimeEnabled = false;
      this.setState(ConnectionState.Disconnected);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = this.reconnect.nextDelay();
    if (delay === null) {
      this.logger.error('Max reconnection attempts exceeded');
      this.setState(ConnectionState.Failed);
      return;
    }

    this.logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnect.currentAttempt})`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect(this.currentPort, this._filterTargets ?? undefined);
      } catch {
        // connect() sets state=Failed. If retries remain, schedule another attempt.
        if (!this.reconnect.exhausted) {
          this.setState(ConnectionState.Reconnecting);
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearPending(conn: TargetConnection, reason: string): void {
    for (const [, pending] of conn.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    conn.pending.clear();
  }

  private setState(newState: ConnectionState): void {
    if (this._state === newState) return;
    this._state = newState;
    this._onStateChange.fire(newState);
  }
}

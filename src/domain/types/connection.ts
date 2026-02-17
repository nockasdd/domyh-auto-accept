/**
 * CDP connection types
 */

/** CDP target page information */
export interface CDPTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly type: 'page' | 'webview' | 'iframe' | 'background_page' | 'worker' | 'other';
  readonly webSocketDebuggerUrl: string;
}

/** Active CDP connection state */
export interface CDPConnection {
  readonly targetId: string;
  readonly wsUrl: string;
  readonly connected: boolean;
  readonly lastActivity: number;
}

/** Connection state for CDP connector */
export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Reconnecting = 'reconnecting',
  Failed = 'failed',
}

/** Result of a Runtime.evaluate call */
export interface EvalResult {
  readonly success: boolean;
  readonly value: unknown;
  readonly error?: string;
}

/** Execution context info from Runtime.executionContextCreated */
export interface ExecutionContextInfo {
  readonly contextId: number;
  readonly origin: string;
  readonly frameUrl: string;
  readonly name: string;
  readonly isDefault: boolean;
}

/** CDP reconnection configuration */
export interface ReconnectConfig {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly jitterPercent: number;
  readonly maxRetries: number;
}

/**
 * ICDPConnector — Chrome DevTools Protocol abstraction
 *
 * SRP: Only handles WebSocket communication with CDP.
 * DIP: Engine depends on this interface, not the concrete implementation.
 */

import { Disposable, Event } from 'vscode';
import { CDPTarget, ConnectionState, EvalResult, ExecutionContextInfo } from '../types/connection';

export interface ICDPConnector extends Disposable {
  /** Current connection state */
  readonly state: ConnectionState;
  /** Number of active target connections */
  readonly connectionCount: number;

  /** Connect to CDP at the given port, optionally filtering targets via adapter */
  connect(port: number, filterTargets?: (targets: CDPTarget[]) => CDPTarget[]): Promise<void>;
  /** Disconnect all WebSocket connections */
  disconnect(): Promise<void>;
  /** Evaluate a JavaScript expression via Runtime.evaluate */
  evaluate(expression: string, timeout?: number): Promise<EvalResult>;
  /** Evaluate a JavaScript expression on ALL connected targets */
  evaluateAll(expression: string, timeout?: number): Promise<EvalResult[]>;
  /** Evaluate a JavaScript expression in a specific execution context (e.g., iframe) */
  evaluateInContext(expression: string, contextId: number, timeout?: number): Promise<EvalResult>;
  /** Inject a script into all connected targets */
  inject(script: string): Promise<void>;
  /** Discover available CDP targets */
  getTargets(port: number): Promise<CDPTarget[]>;

  /** Enable Runtime domain events (execution context tracking for iframes) */
  enableRuntimeEvents(): Promise<void>;
  /** Get iframe execution contexts matching URL patterns */
  getIframeContexts(urlPatterns?: string[]): ExecutionContextInfo[];

  /** Fired when connection state changes */
  onStateChange: Event<ConnectionState>;
  /** Fired when an error occurs */
  onError: Event<Error>;
}

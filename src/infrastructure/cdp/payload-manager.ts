/**
 * PayloadManager — JavaScript payload registry
 *
 * Manages JavaScript source files that get injected into webviews via CDP.
 * Each payload is a self-contained JS function that runs in the browser context.
 *
 * Payloads are loaded from `dist/payload/` at activation time.
 * Map is instance-level to prevent stale state across extension reloads.
 */

import { Logger } from '../../core/logger';

export class PayloadManager {
  private readonly payloads = new Map<string, string>();

  constructor(private readonly logger: Logger) {}

  /** Register a payload by name */
  register(name: string, source: string): void {
    this.payloads.set(name, source);
    this.logger.debug(`Payload registered: ${name} (${source.length} chars)`);
  }

  /** Check if a payload exists */
  has(name: string): boolean {
    return this.payloads.has(name);
  }

  /** Get raw source for a payload */
  getSource(name: string): string {
    const src = this.payloads.get(name);
    if (!src) throw new Error(`Payload not found: ${name}`);
    return src;
  }

  /** Get the probe payload (no arguments) */
  getProbe(): string {
    const base = this.getSource('probe');
    return `(function(){ ${base} })();`;
  }

  /** Get auto-accept payload with config injected */
  getAutoAccept(config: Record<string, unknown>): string {
    const base = this.getSource('auto-accept');
    return `(function(){
      var __config = ${JSON.stringify(config)};
      ${base}
    })();`;
  }

  /** Get send-prompt payload with text injected */
  getSendPrompt(text: string, selector: string): string {
    const base = this.getSource('send-prompt');
    return `(function(){
      var __text = ${JSON.stringify(text)};
      var __selector = ${JSON.stringify(selector)};
      ${base}
    })();`;
  }

}

/**
 * IDEAdapterRegistry — Adapter registration and lookup
 *
 * OCP: New IDEs are added by implementing IIDEAdapter + calling register().
 * Zero engine changes required.
 */

import { IIDEAdapter } from '../../domain/interfaces/ide-adapter';
import { IDEType } from '../../domain/enums';
import { Logger } from '../../core/logger';

export class IDEAdapterRegistry {
  private readonly adapters = new Map<IDEType, IIDEAdapter>();

  constructor(private readonly logger: Logger) {}

  /** Register an IDE adapter */
  register(adapter: IIDEAdapter): void {
    if (this.adapters.has(adapter.id)) {
      this.logger.warn(`Adapter already registered: ${adapter.id}. Overwriting.`);
    }
    this.adapters.set(adapter.id, adapter);
    this.logger.info(`IDE adapter registered: ${adapter.displayName} (port ${adapter.defaultCDPPort})`);
  }

  /** Get adapter by IDE type */
  get(type: IDEType): IIDEAdapter | undefined {
    return this.adapters.get(type);
  }

  /** Get adapter by IDE type, throw if not found */
  getOrThrow(type: IDEType): IIDEAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter registered for IDE: ${type}`);
    }
    return adapter;
  }

  /** Get all registered adapters */
  getAll(): IIDEAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Check if an adapter is registered */
  has(type: IDEType): boolean {
    return this.adapters.has(type);
  }

  /** Get registered IDE types */
  getRegisteredTypes(): IDEType[] {
    return Array.from(this.adapters.keys());
  }
}

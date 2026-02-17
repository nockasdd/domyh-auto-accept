/**
 * Lightweight IoC Container
 *
 * DIP: All services register/resolve by interface token.
 * Services are lazy singletons — created on first resolve.
 */

type Factory<T> = () => T;

interface Registration<T> {
  factory: Factory<T>;
  instance: T | null;
}

export class Container {
  private readonly registrations = new Map<string, Registration<unknown>>();

  /**
   * Register a service factory by token.
   * The factory is called lazily on first resolve.
   */
  register<T>(token: string, factory: Factory<T>): void {
    this.registrations.set(token, { factory, instance: null });
  }

  /**
   * Resolve a service by token.
   * Creates the instance on first call, returns cached instance thereafter.
   */
  resolve<T>(token: string): T {
    const reg = this.registrations.get(token);
    if (!reg) {
      throw new Error(`[Container] Service not registered: ${token}`);
    }
    if (reg.instance === null) {
      reg.instance = reg.factory();
    }
    return reg.instance as T;
  }

  /**
   * Check if a service is registered.
   */
  has(token: string): boolean {
    return this.registrations.has(token);
  }

  /**
   * Clear all registrations and cached instances.
   */
  clear(): void {
    this.registrations.clear();
  }
}

/** Service tokens — used as DI keys */
export const Tokens = {
  CDPConnector: 'ICDPConnector',
  EventBus: 'IEventBus',
  Scheduler: 'IScheduler',
  IDERegistry: 'IDEAdapterRegistry',
  Config: 'ConfigReader',
  Logger: 'Logger',
  Engine: 'AutoAcceptEngine',
  DeathLoopGuard: 'DeathLoopGuard',
  SmartFocus: 'SmartFocus',
} as const;

/** Global container instance */
export const container = new Container();

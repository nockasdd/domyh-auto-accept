/**
 * DisposableStore — Manages VS Code disposables
 *
 * SRP: Only handles cleanup of subscriptions and resources.
 */

import { Disposable } from 'vscode';

export class DisposableStore implements Disposable {
  private readonly disposables: Disposable[] = [];
  private isDisposed = false;

  /** Add a disposable to the store. Returns the disposable for chaining. */
  add<T extends Disposable>(disposable: T): T {
    if (this.isDisposed) {
      disposable.dispose();
      return disposable;
    }
    this.disposables.push(disposable);
    return disposable;
  }

  /** Dispose all stored disposables */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        // Silently ignore disposal errors
      }
    }
    this.disposables.length = 0;
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { IDEAdapterRegistry } from '../src/infrastructure/adapters/registry';
import { AntigravityAdapter } from '../src/infrastructure/adapters/antigravity';
import { CursorAdapter } from '../src/infrastructure/adapters/cursor';
import { WindsurfAdapter } from '../src/infrastructure/adapters/windsurf';
import { TraeAdapter } from '../src/infrastructure/adapters/trae';
import { VSCodeCopilotAdapter } from '../src/infrastructure/adapters/vscode-copilot';
import { Logger } from '../src/core/logger';
import { IDEType } from '../src/domain/enums';

describe('IDEAdapterRegistry', () => {
  let registry: IDEAdapterRegistry;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
    registry = new IDEAdapterRegistry(logger);
  });

  it('should start with no adapters', () => {
    expect(registry.getAll().length).toBe(0);
  });

  it('should register and retrieve adapter by IDEType', () => {
    const adapter = new AntigravityAdapter();
    registry.register(adapter);
    expect(registry.get(IDEType.Antigravity)).toBe(adapter);
  });

  it('should register all 5 adapters', () => {
    registry.register(new AntigravityAdapter());
    registry.register(new CursorAdapter());
    registry.register(new WindsurfAdapter());
    registry.register(new TraeAdapter());
    registry.register(new VSCodeCopilotAdapter());
    expect(registry.getAll().length).toBe(5);
  });

  it('should return undefined for unregistered IDE type', () => {
    expect(registry.get(IDEType.Cursor)).toBeUndefined();
  });

  it('should overwrite adapter with same IDEType on re-register', () => {
    const adapter1 = new CursorAdapter();
    const adapter2 = new CursorAdapter();
    registry.register(adapter1);
    registry.register(adapter2);
    expect(registry.get(IDEType.Cursor)).toBe(adapter2);
    expect(registry.getAll().length).toBe(1);
  });

  it('should iterate over all registered adapters', () => {
    registry.register(new AntigravityAdapter());
    registry.register(new CursorAdapter());
    const all = registry.getAll();
    expect(all.map((a) => a.id)).toEqual([IDEType.Antigravity, IDEType.Cursor]);
  });
});

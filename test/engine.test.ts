import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AutoAcceptEngine } from '../src/application/engine';
import { TypedEventBus } from '../src/application/event-bus';
import { Logger } from '../src/core/logger';
import { AntigravityAdapter } from '../src/infrastructure/adapters/antigravity';

import { DeathLoopGuard } from '../src/application/death-loop-guard';

// Mock ConfigReader
const mockConfig = {
  getAll: vi.fn().mockReturnValue({
    enabled: true,
    cdpPort: 9004,
    pollFrequency: 2000,
    bannedCommands: [],
    autoAllowOutsideWorkspace: false,
    smartFocus: false,
    debugMode: false,
    autoRetry: { enabled: true, maxRetries: 10, windowSeconds: 300, cooldownSeconds: 120 },
    schedule: { enabled: false, mode: 'interval', value: '30', prompt: '', prompts: [], queueMode: 'consume', silenceTimeout: 30 },
  }),
  get: vi.fn((_key: string, defaultValue: unknown) => defaultValue),
  set: vi.fn(),
  onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getAutoRetry: vi.fn().mockReturnValue({
    enabled: true, maxRetries: 10, windowSeconds: 300, cooldownSeconds: 120,
  }),
  getSchedule: vi.fn().mockReturnValue({
    enabled: false, mode: 'interval', value: '30', prompt: '', prompts: [], queueMode: 'consume', silenceTimeout: 30,
  }),
};

// Mock CDPConnector
const mockCDP = {
  evaluate: vi.fn().mockResolvedValue({ success: true, value: null }),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(false),
  getTargets: vi.fn().mockResolvedValue([]),
  injectScript: vi.fn().mockResolvedValue(undefined),
  onDisconnect: vi.fn(),
  onStateChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
};

// Mock PayloadManager
const mockPayloads = {
  register: vi.fn(),
  get: vi.fn().mockReturnValue(''),
  getAutoAccept: vi.fn().mockReturnValue(''),
  getSendPrompt: vi.fn().mockReturnValue(''),
};

describe('AutoAcceptEngine', () => {
  let engine: AutoAcceptEngine;
  let eventBus: TypedEventBus;
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventBus();
    logger = new Logger();
    const adapter = new AntigravityAdapter();
    const deathLoopGuard = new DeathLoopGuard(
      { enabled: true, maxRetries: 5, windowSeconds: 60, cooldownSeconds: 120 },
      eventBus,
      logger,
    );

    engine = new AutoAcceptEngine(
      adapter,
      mockCDP as any,
      eventBus,
      deathLoopGuard,
      null, // SmartFocus
      mockPayloads as any,
      mockConfig as any,
      logger,
    );
  });

  afterEach(() => {
    engine?.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should start in idle state', () => {
    const stats = engine.getStats();
    expect(stats.totalClicks).toBe(0);
  });

  it('should emit state change on start', async () => {
    const handler = vi.fn();
    eventBus.on('engine:stateChanged', handler);

    await engine.start();
    expect(handler).toHaveBeenCalled();
  });

  it('should start and stop without errors', async () => {
    await engine.start();
    expect(() => engine.stop()).not.toThrow();
  });

  it('should track session stats', () => {
    const stats = engine.getStats();
    expect(stats).toHaveProperty('totalClicks');
    expect(stats).toHaveProperty('blockedCommands');
    expect(stats).toHaveProperty('retriesAttempted');
    expect(stats).toHaveProperty('promptsSent');
    expect(stats).toHaveProperty('sessionStartTime');
    expect(stats).toHaveProperty('clicksByType');
  });

  it('should be safe to stop without starting', () => {
    expect(() => engine.stop()).not.toThrow();
  });

  it('should be safe to start multiple times', async () => {
    await engine.start();
    await expect(engine.start()).resolves.not.toThrow();
  });

  it('should return zero-based stats on fresh engine', () => {
    const stats = engine.getStats();
    expect(stats.totalClicks).toBe(0);
    expect(stats.blockedCommands).toBe(0);
    expect(stats.retriesAttempted).toBe(0);
    expect(stats.promptsSent).toBe(0);
    expect(stats.clicksByType).toEqual({});
  });
});

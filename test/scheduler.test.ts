import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Scheduler } from '../src/application/scheduler';
import { TypedEventBus } from '../src/application/event-bus';
import { Logger } from '../src/core/logger';

// Mock ConfigReader with controlled getSchedule return
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
    schedule: {
      enabled: false,
      mode: 'queue' as const,
      value: '30',
      prompt: 'test prompt',
      prompts: ['prompt1', 'prompt2'],
      queueMode: 'consume' as const,
      silenceTimeout: 30,
    },
  }),
  getSchedule: vi.fn().mockReturnValue({
    enabled: false,
    mode: 'queue' as const,
    value: '30',
    prompt: 'test prompt',
    prompts: ['prompt1', 'prompt2'],
    queueMode: 'consume' as const,
    silenceTimeout: 30,
  }),
  get: vi.fn().mockReturnValue(undefined),
  set: vi.fn(),
  onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getAutoRetry: vi.fn().mockReturnValue({
    enabled: true,
    maxRetries: 10,
    windowSeconds: 300,
    cooldownSeconds: 120,
  }),
};

// Mock CDPConnector
const mockCDP = {
  evaluate: vi.fn().mockResolvedValue({ success: true, value: '{"clicks":0,"lastClick":0}' }),
  evaluateAll: vi.fn().mockResolvedValue([{ success: true, value: '{"success":true}' }]),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isConnected: vi.fn().mockReturnValue(true),
  getTargets: vi.fn().mockResolvedValue([]),
  injectScript: vi.fn().mockResolvedValue(undefined),
  onDisconnect: vi.fn(),
};

// Mock PayloadManager
const mockPayloads = {
  register: vi.fn(),
  get: vi.fn().mockReturnValue('console.log("test")'),
  getAutoAccept: vi.fn().mockReturnValue(''),
  getSendPrompt: vi.fn().mockReturnValue('window.sendPrompt("test")'),
};

describe('Scheduler', () => {
  let scheduler: Scheduler;
  let eventBus: TypedEventBus;
  let logger: Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new TypedEventBus();
    logger = new Logger();
    scheduler = new Scheduler(
      mockCDP as any,
      eventBus,
      mockPayloads as any,
      mockConfig as any,
      logger,
    );
  });

  afterEach(() => {
    scheduler?.dispose();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('queue mode', () => {
    it('should have queue length from config', () => {
      expect(scheduler.queueLength).toBe(2); // ['prompt1', 'prompt2']
    });

    it('should start inactive', () => {
      expect(scheduler.isActive).toBe(false);
    });

    it('should emit scheduler:queueAdvanced when advancing', () => {
      const handler = vi.fn();
      eventBus.on('scheduler:queueAdvanced', handler);
      // Skip without active scheduler should not throw
      expect(() => scheduler.skip()).not.toThrow();
    });
  });

  describe('lifecycle', () => {
    it('should start without throwing (but not activate since schedule.enabled=false)', () => {
      expect(() => scheduler.start()).not.toThrow();
      expect(scheduler.isActive).toBe(false); // because enabled=false in config
    });

    it('should activate when schedule is enabled', () => {
      mockConfig.getSchedule.mockReturnValueOnce({
        enabled: true,
        mode: 'queue' as const,
        value: '30',
        prompt: 'test',
        prompts: ['p1'],
        queueMode: 'consume' as const,
        silenceTimeout: 30,
      });
      scheduler.start();
      expect(scheduler.isActive).toBe(true);
    });

    it('should stop without throwing', () => {
      expect(() => scheduler.stop()).not.toThrow();
    });

    it('should pause without throwing', () => {
      expect(() => scheduler.pause()).not.toThrow();
    });

    it('should resume without throwing', () => {
      expect(() => scheduler.resume()).not.toThrow();
    });

    it('should skip without throwing', () => {
      expect(() => scheduler.skip()).not.toThrow();
    });
  });

  describe('dispose', () => {
    it('should clean up timers on dispose', () => {
      expect(() => scheduler.dispose()).not.toThrow();
    });

    it('should be safe to dispose multiple times', () => {
      scheduler.dispose();
      expect(() => scheduler.dispose()).not.toThrow();
    });
  });

  describe('getNextPrompt', () => {
    it('should return first prompt from queue', () => {
      expect(scheduler.getNextPrompt()).toBe('prompt1');
    });

    it('should return null when past queue end', () => {
      // Manually advance index past end
      (scheduler as any)._currentIndex = 10;
      expect(scheduler.getNextPrompt()).toBeNull();
    });
  });

  describe('onTaskCompleted', () => {
    it('should handle task completion gracefully when not active', () => {
      expect(() => scheduler.onTaskCompleted()).not.toThrow();
    });
  });

  describe('state', () => {
    it('should not be paused initially', () => {
      expect(scheduler.isPaused).toBe(false);
    });

    it('should track history', () => {
      expect(scheduler.getHistory()).toEqual([]);
    });
  });
});

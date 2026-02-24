import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDEDetector } from '../src/infrastructure/detection/ide-detector';
import { IDEType } from '../src/domain/enums';

describe('IDEDetector.discoverCDPPort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('prefers DevToolsActivePort when available and validated', async () => {
    const detector = new IDEDetector() as any;

    // Stub private helpers to avoid real fs/network calls
    detector.readDevToolsActivePort = vi.fn().mockReturnValue(9333);
    detector.probeForIDE = vi.fn().mockResolvedValue(true);
    detector.getActiveCDPPort = vi.fn().mockReturnValue(null);
    detector.scanProcessPorts = vi.fn().mockResolvedValue(null);
    detector.sweepPortRange = vi.fn().mockResolvedValue(null);

    const result = await detector.discoverCDPPort(IDEType.Cursor, 9222);

    expect(detector.readDevToolsActivePort).toHaveBeenCalled();
    expect(detector.probeForIDE).toHaveBeenCalledWith(9333, IDEType.Cursor);
    expect(result.port).toBe(9333);
    expect(result.source).toBe('DevToolsActivePort');
    expect(result.validated).toBe(true);
  });

  it('falls back to adapter default when no source validates', async () => {
    const detector = new IDEDetector() as any;

    detector.readDevToolsActivePort = vi.fn().mockReturnValue(null);
    detector.probeForIDE = vi.fn().mockResolvedValue(false);
    detector.getActiveCDPPort = vi.fn().mockReturnValue(null);
    detector.scanProcessPorts = vi.fn().mockResolvedValue(null);
    detector.sweepPortRange = vi.fn().mockResolvedValue(null);

    const result = await detector.discoverCDPPort(IDEType.Cursor, 9222);

    expect(result.port).toBe(9222);
    expect(result.source).toBe('adapter-default');
    expect(result.validated).toBe(false);
  });
});


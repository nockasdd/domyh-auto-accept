import { describe, it, expect } from 'vitest';
import { AntigravityAdapter } from '../src/infrastructure/adapters/antigravity';
import { CursorAdapter } from '../src/infrastructure/adapters/cursor';
import { WindsurfAdapter } from '../src/infrastructure/adapters/windsurf';
import { TraeAdapter } from '../src/infrastructure/adapters/trae';
import { VSCodeCopilotAdapter } from '../src/infrastructure/adapters/vscode-copilot';
import { IDEType } from '../src/domain/enums';
import { ElementInfo, ButtonType } from '../src/domain/types/button';

// Helper to create a mock ElementInfo
function mockElement(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    ariaLabel: '',
    textContent: '',
    className: '',
    id: '',
    tagName: 'BUTTON',
    disabled: false,
    visible: true,
    commandText: undefined,
    ...overrides,
  };
}

describe('IDE Adapters', () => {
  describe.each([
    ['Antigravity', new AntigravityAdapter(), IDEType.Antigravity, 9004],
    ['Cursor', new CursorAdapter(), IDEType.Cursor, 9222],
    ['Windsurf', new WindsurfAdapter(), IDEType.Windsurf, 9224],
    ['Trae', new TraeAdapter(), IDEType.Trae, 9005],
    ['VSCode Copilot', new VSCodeCopilotAdapter(), IDEType.VSCode, 9229],
  ] as const)('%s adapter', (_name, adapter, expectedId, expectedPort) => {

    it(`should have id ${expectedId}`, () => {
      expect(adapter.id).toBe(expectedId);
    });

    it(`should have default CDP port ${expectedPort}`, () => {
      expect(adapter.defaultCDPPort).toBe(expectedPort);
    });

    it('should have display name', () => {
      expect(adapter.displayName).toBeTruthy();
    });

    it('should have launch flag with port', () => {
      expect(adapter.launchFlag).toContain('--remote-debugging-port=');
      expect(adapter.launchFlag).toContain(String(expectedPort));
    });

    it('should return accept commands', () => {
      const cmds = adapter.getAcceptCommands();
      expect(cmds.length).toBeGreaterThan(0);
      cmds.forEach((cmd) => expect(typeof cmd).toBe('string'));
    });

    it('should return reject commands', () => {
      const cmds = adapter.getRejectCommands();
      expect(cmds.length).toBeGreaterThan(0);
    });

    it('should support commands API', () => {
      expect(adapter.supportsCommandsAPI()).toBe(true);
    });

    it('should have button selectors with text patterns', () => {
      const config = adapter.getButtonSelectors();
      expect(config.containerSelectors.length).toBeGreaterThan(0);
      expect(Object.keys(config.textPatterns).length).toBeGreaterThan(0);
    });

    it('should have retry patterns', () => {
      const patterns = adapter.getRetryPatterns();
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('should match "Accept" button', () => {
      const el = mockElement({ textContent: 'Accept' });
      const match = adapter.matchButton(el);
      expect(match).not.toBeNull();
      expect(match!.type).toBe(ButtonType.Accept);
    });

    it('should match "Retry" button', () => {
      const el = mockElement({ textContent: 'Retry' });
      const match = adapter.matchButton(el);
      expect(match).not.toBeNull();
      expect(match!.type).toBe(ButtonType.Retry);
    });

    it('should not match disabled elements', () => {
      const el = mockElement({ textContent: 'Accept', disabled: true });
      expect(adapter.matchButton(el)).toBeNull();
    });

    it('should not match invisible elements', () => {
      const el = mockElement({ textContent: 'Accept', visible: false });
      expect(adapter.matchButton(el)).toBeNull();
    });

    it('should not match empty text elements', () => {
      const el = mockElement({ textContent: '' });
      expect(adapter.matchButton(el)).toBeNull();
    });
  });
});

describe('CursorAdapter — Cursor-specific (DOM-evidenced)', () => {
  const adapter = new CursorAdapter();

  it('should match "Accept ^⏎" as Accept', () => {
    const el = mockElement({ textContent: 'Accept ^⏎' });
    const match = adapter.matchButton(el);
    expect(match).not.toBeNull();
    expect(match!.type).toBe(ButtonType.Accept);
  });

  it('should match "Keep All" as AcceptAll', () => {
    const el = mockElement({ textContent: 'Keep All' });
    const match = adapter.matchButton(el);
    expect(match).not.toBeNull();
    expect(match!.type).toBe(ButtonType.AcceptAll);
  });

  it('should match "Accept All Files" as AcceptAll', () => {
    const el = mockElement({ textContent: 'Accept All Files' });
    const match = adapter.matchButton(el);
    expect(match).not.toBeNull();
    expect(match!.type).toBe(ButtonType.AcceptAll);
  });

  it('should match "Run Everything" as Run', () => {
    const el = mockElement({ textContent: 'Run Everything' });
    const match = adapter.matchButton(el);
    expect(match).not.toBeNull();
    expect(match!.type).toBe(ButtonType.Run);
  });

  it('should NOT match "Undo All" (no accept pattern)', () => {
    const el = mockElement({ textContent: 'Undo All' });
    const match = adapter.matchButton(el);
    expect(match).toBeNull();
  });

  it('should NOT match "Review" (not an accept action)', () => {
    const el = mockElement({ textContent: 'Review' });
    const match = adapter.matchButton(el);
    expect(match).toBeNull();
  });

  it('should include all 3 Anysphere button classes in container selectors', () => {
    const config = adapter.getButtonSelectors();
    expect(config.containerSelectors).toContain('.anysphere-secondary-button');
    expect(config.containerSelectors).toContain('.anysphere-text-button');
    expect(config.containerSelectors).toContain('.anysphere-focus-outline-button');
    expect(config.containerSelectors).toContain('[data-click-ready="true"]');
  });

  it('should NOT include iframe in filterTargets', () => {
    const targets = [
      { type: 'iframe', url: 'about:blank', title: '', webSocketDebuggerUrl: 'ws://x' },
      { type: 'page', url: 'https://workbench', title: 'Cursor', webSocketDebuggerUrl: 'ws://y' },
      { type: 'webview', url: '', title: '', webSocketDebuggerUrl: 'ws://z' },
    ];
    const filtered = adapter.filterTargets(targets as any);
    expect(filtered.some(t => t.type === 'iframe')).toBe(false);
    expect(filtered.some(t => t.type === 'page')).toBe(true);
    expect(filtered.some(t => t.type === 'webview')).toBe(true);
  });
});

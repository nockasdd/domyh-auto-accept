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

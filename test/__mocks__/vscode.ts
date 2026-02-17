/**
 * Mock for the 'vscode' module — used by Vitest
 *
 * Provides minimal stubs for VS Code API surfaces used by the extension:
 * - window (showInformationMessage, showWarningMessage, createWebviewPanel)
 * - commands (registerCommand, executeCommand)
 * - workspace (getConfiguration)
 * - StatusBarAlignment, StatusBarItem
 * - ExtensionContext
 * - Uri, EventEmitter, Disposable
 */

import { vi } from 'vitest';

// ── Stubs ──────────────────────────────────────────

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class EventEmitter {
  private handlers: Array<(...args: unknown[]) => void> = [];
  event = (handler: (...args: unknown[]) => void) => {
    this.handlers.push(handler);
    return { dispose: () => { this.handlers = this.handlers.filter((h) => h !== handler); } };
  };
  fire(data?: unknown) {
    this.handlers.forEach((h) => h(data));
  }
  dispose() {
    this.handlers = [];
  }
}

export class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose() {
    this.callOnDispose();
  }
  static from(...disposables: { dispose: () => void }[]) {
    return new Disposable(() => disposables.forEach((d) => d.dispose()));
  }
}

export const Uri = {
  file: (path: string) => ({ scheme: 'file', path, fsPath: path }),
  parse: (uri: string) => ({ scheme: 'file', path: uri, fsPath: uri }),
  joinPath: (base: { path: string }, ...segments: string[]) => ({
    scheme: 'file',
    path: [base.path, ...segments].join('/'),
    fsPath: [base.path, ...segments].join('/'),
  }),
};

export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
}

// ── window ─────────────────────────────────────────

const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: undefined as string | undefined,
  alignment: StatusBarAlignment.Left,
  priority: 0,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

const mockWebviewPanel = {
  webview: {
    html: '',
    postMessage: vi.fn(),
    onDidReceiveMessage: vi.fn(),
  },
  reveal: vi.fn(),
  dispose: vi.fn(),
  onDidDispose: vi.fn(),
};

export const window = {
  showInformationMessage: vi.fn().mockResolvedValue(undefined),
  showWarningMessage: vi.fn().mockResolvedValue(undefined),
  showErrorMessage: vi.fn().mockResolvedValue(undefined),
  createStatusBarItem: vi.fn(() => ({ ...mockStatusBarItem })),
  createWebviewPanel: vi.fn(() => ({ ...mockWebviewPanel })),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    append: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    clear: vi.fn(),
    dispose: vi.fn(),
    name: 'mock-channel',
  })),
  withProgress: vi.fn(),
};

// ── commands ───────────────────────────────────────

const registeredCommands = new Map<string, (...args: unknown[]) => unknown>();

export const commands = {
  registerCommand: vi.fn((id: string, handler: (...args: unknown[]) => unknown) => {
    registeredCommands.set(id, handler);
    return new Disposable(() => registeredCommands.delete(id));
  }),
  executeCommand: vi.fn(async (id: string, ...args: unknown[]) => {
    const handler = registeredCommands.get(id);
    return handler ? handler(...args) : undefined;
  }),
};

// ── workspace ──────────────────────────────────────

const mockConfigValues: Record<string, unknown> = {};

export const workspace = {
  getConfiguration: vi.fn((section?: string) => ({
    get: vi.fn((key: string, defaultValue?: unknown) => {
      const fullKey = section ? `${section}.${key}` : key;
      return mockConfigValues[fullKey] ?? defaultValue;
    }),
    has: vi.fn(() => true),
    update: vi.fn(),
    inspect: vi.fn(),
  })),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
};

// ── Helper: set mock config values for tests ───────

export function __setMockConfig(values: Record<string, unknown>) {
  Object.assign(mockConfigValues, values);
}

export function __resetMocks() {
  window.showInformationMessage.mockClear();
  window.showWarningMessage.mockClear();
  window.showErrorMessage.mockClear();
  commands.registerCommand.mockClear();
  commands.executeCommand.mockClear();
  registeredCommands.clear();
  Object.keys(mockConfigValues).forEach((k) => delete mockConfigValues[k]);
}

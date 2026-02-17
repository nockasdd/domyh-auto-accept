/**
 * Structured Logger
 *
 * SRP: Only handles logging with channel output and console fallback.
 */

import * as vscode from 'vscode';

export enum LogLevel {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
}

export class Logger {
  private readonly channel: vscode.OutputChannel;
  private debugMode = false;

  constructor(channelName = 'Domyh Auto Accept') {
    this.channel = vscode.window.createOutputChannel(channelName);
  }

  setDebugMode(enabled: boolean): void {
    this.debugMode = enabled;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.debugMode) {
      this.log(LogLevel.Debug, message, ...args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Info, message, ...args);
  }

  warn(message: string, ...args: unknown[]): void {
    this.log(LogLevel.Warn, message, ...args);
  }

  error(message: string, error?: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error ?? '');
    this.log(LogLevel.Error, `${message}${errorMsg ? ': ' + errorMsg : ''}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const timestamp = new Date().toISOString().slice(11, 23);
    const prefix = LogLevel[level].toUpperCase().padEnd(5);
    const formatted = args.length > 0
      ? `[${timestamp}] ${prefix} ${message} ${JSON.stringify(args)}`
      : `[${timestamp}] ${prefix} ${message}`;
    this.channel.appendLine(formatted);
  }
}

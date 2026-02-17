/**
 * Button detection types
 */

/** Priority of button actions — lower number = higher priority */
export enum ButtonPriority {
  AcceptAll = 1,
  AcceptSingle = 2,
  RunCommand = 3,
  Retry = 4,
  Continue = 5,
  Permission = 6,
  Dismiss = 7,
}

/** The type/category of a matched button */
export enum ButtonType {
  AcceptAll = 'accept-all',
  Accept = 'accept',
  Run = 'run',
  Retry = 'retry',
  Continue = 'continue',
  Permission = 'permission',
  Dismiss = 'dismiss',
}

/** Information about a DOM element found in the webview */
export interface ElementInfo {
  readonly tagName: string;
  readonly textContent: string;
  readonly className: string;
  readonly id: string;
  readonly disabled: boolean;
  readonly visible: boolean;
  readonly ariaLabel?: string;
  /** Attached command text for "Run" buttons */
  readonly commandText?: string;
}

/** A matched button that should be clicked */
export interface ButtonMatch {
  readonly type: ButtonType;
  readonly priority: ButtonPriority;
  readonly text: string;
  readonly element: ElementInfo;
  /** For Run buttons: the command that will be executed */
  readonly commandText?: string;
  /** Whether this was blocked by safety guard */
  readonly blocked: boolean;
  /** Reason for blocking, if applicable */
  readonly blockReason?: string;
}

/** Configuration for button selectors per IDE */
export interface ButtonSelectorConfig {
  /** CSS selectors to find candidate buttons */
  readonly containerSelectors: string[];
  /** Text patterns per button type */
  readonly textPatterns: Record<ButtonType, RegExp[]>;
  /** Optional CSS class patterns for additional matching */
  readonly classPatterns?: Record<ButtonType, RegExp[]>;
}

/** Pattern for matching retry/error dialogs */
export interface RetryPattern {
  /** Text content to match on error message */
  readonly errorTextPattern: RegExp;
  /** Button text to click for retry */
  readonly retryButtonText: RegExp;
  /** How long to wait before clicking retry (ms) */
  readonly delayMs: number;
  /** Whether this error should NOT be retried (death loop risk) */
  readonly skipRetry: boolean;
}

/** Pattern for matching permission dialogs */
export interface PermissionPattern {
  /** Text content to match on the dialog */
  readonly dialogTextPattern: RegExp;
  /** Button text to click to allow */
  readonly allowButtonText: RegExp;
  /** Whether auto-allow requires specific config flag */
  readonly requiresConfig: boolean;
  /** Config key that must be true for this permission to be auto-allowed */
  readonly configKey?: string;
}

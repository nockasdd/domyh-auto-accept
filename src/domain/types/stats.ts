/**
 * Statistics tracking types
 */

/** Session-level stats */
export interface SessionStats {
  readonly totalClicks: number;
  readonly blockedCommands: number;
  readonly retriesAttempted: number;
  readonly promptsSent: number;
  readonly sessionStartTime: number;
  readonly lastClickTime: number;
  /** Breakdown by button type */
  readonly clicksByType: Record<string, number>;
  /** Time saved estimate (seconds) — assumes 5s per manual click */
  readonly estimatedTimeSaved: number;
}

/** ROI tracking (lifetime) */
export interface ROIStats {
  readonly lifetimeClicks: number;
  readonly lifetimeBlocked: number;
  readonly lifetimeRetries: number;
  readonly lifetimePrompts: number;
  readonly firstUsed: number;
  readonly totalSessions: number;
}

/** Create initial session stats */
export function createSessionStats(): SessionStats {
  return {
    totalClicks: 0,
    blockedCommands: 0,
    retriesAttempted: 0,
    promptsSent: 0,
    sessionStartTime: Date.now(),
    lastClickTime: 0,
    clicksByType: {},
    estimatedTimeSaved: 0,
  };
}

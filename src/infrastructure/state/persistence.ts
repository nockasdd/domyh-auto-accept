/**
 * State persistence — globalState wrapper
 */

import * as vscode from 'vscode';
import { ROIStats, SessionStats } from '../../domain/types/stats';

const STATS_KEY = 'domyh-auto-accept.roiStats';

export class StatePersistence {
  constructor(private readonly globalState: vscode.Memento) {}

  /** Load lifetime ROI stats */
  getROIStats(): ROIStats {
    return this.globalState.get<ROIStats>(STATS_KEY, {
      lifetimeClicks: 0,
      lifetimeBlocked: 0,
      lifetimeRetries: 0,
      lifetimePrompts: 0,
      firstUsed: 0,
      totalSessions: 0,
    });
  }

  /** Save updated ROI stats */
  async saveROIStats(stats: ROIStats): Promise<void> {
    await this.globalState.update(STATS_KEY, stats);
  }

  /** Merge session stats into lifetime stats */
  async mergeSession(session: SessionStats): Promise<ROIStats> {
    const current = this.getROIStats();
    const updated: ROIStats = {
      lifetimeClicks: current.lifetimeClicks + session.totalClicks,
      lifetimeBlocked: current.lifetimeBlocked + session.blockedCommands,
      lifetimeRetries: current.lifetimeRetries + session.retriesAttempted,
      lifetimePrompts: current.lifetimePrompts + session.promptsSent,
      firstUsed: current.firstUsed || Date.now(),
      totalSessions: current.totalSessions + 1,
    };
    await this.saveROIStats(updated);
    return updated;
  }
}

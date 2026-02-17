/**
 * Queue execution modes
 */
export enum QueueMode {
  /** Remove each prompt after execution */
  Consume = 'consume',
  /** Loop back to first prompt when queue exhausted */
  Loop = 'loop',
}

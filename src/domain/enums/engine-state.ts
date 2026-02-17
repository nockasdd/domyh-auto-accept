/**
 * Engine lifecycle states
 */
export enum EngineState {
  /** Extension loaded, engine not started */
  Idle = 'idle',
  /** Attempting to find CDP and connect */
  Starting = 'starting',
  /** CDP not available, offering relaunch */
  NoCDP = 'no-cdp',
  /** IDE being relaunched with CDP flag */
  Relaunching = 'relaunching',
  /** WebSocket connected to CDP */
  Connected = 'connected',
  /** Payload injected, ready to poll */
  Injecting = 'injecting',
  /** Actively polling for buttons */
  Polling = 'polling',
  /** Error occurred, may auto-reconnect */
  Error = 'error',
  /** Attempting to reconnect */
  Reconnecting = 'reconnecting',
}

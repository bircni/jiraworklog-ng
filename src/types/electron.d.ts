/**
 * Shape of the bridge that the Electron preload script exposes on `window`.
 * Absent when the app runs in a plain browser (web/dev without Electron).
 */
export interface ElectronBridge {
  /** True marker so the renderer can detect it runs inside Electron. */
  readonly isElectron: true;
  /**
   * Subscribes to "timer stopped from tray" events. Returns an unsubscribe fn.
   */
  onTimerStopped(callback: () => void): () => void;
  /** Current "launch at Windows login" state. */
  getAutoLaunch(): Promise<boolean>;
  /** Enables/disables "launch at Windows login". Returns the applied state. */
  setAutoLaunch(enabled: boolean): Promise<boolean>;
}

declare global {
  interface Window {
    electron?: ElectronBridge;
  }
}

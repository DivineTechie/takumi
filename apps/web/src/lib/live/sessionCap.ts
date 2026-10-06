export interface SessionCapCallbacks {
  onWarning: () => void;
  onTimeout: () => void;
  onTick?: (remainingSeconds: number) => void;
}

export const SESSION_CAP_MS = 10 * 60 * 1000; // 10 minutes (600s)
export const SESSION_WARNING_MS = 9 * 60 * 1000 + 30 * 1000; // 9m 30s (570s)

/**
 * Manages the hard 10-minute session duration cap.
 * Counts strictly from the first session start and is NOT reset by reconnects.
 */
export class SessionCapTimer {
  private startTime: number = 0;
  private warningFired: boolean = false;
  private timeoutFired: boolean = false;
  private intervalId: number | null = null;
  private callbacks: SessionCapCallbacks;

  constructor(callbacks: SessionCapCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Starts or resumes the timer. If already started, preserves original startTime.
   */
  public start(existingStartTime?: number): void {
    if (this.intervalId !== null) return;

    this.startTime = existingStartTime || this.startTime || Date.now();

    this.checkTime();
    this.intervalId = window.setInterval(() => {
      this.checkTime();
    }, 1000);
  }

  private checkTime(): void {
    const elapsed = Date.now() - this.startTime;
    const remainingMs = Math.max(0, SESSION_CAP_MS - elapsed);
    const remainingSec = Math.ceil(remainingMs / 1000);

    if (this.callbacks.onTick) {
      this.callbacks.onTick(remainingSec);
    }

    if (elapsed >= SESSION_WARNING_MS && !this.warningFired) {
      this.warningFired = true;
      this.callbacks.onWarning();
    }

    if (elapsed >= SESSION_CAP_MS && !this.timeoutFired) {
      this.timeoutFired = true;
      this.callbacks.onTimeout();
      this.stop();
    }
  }

  public getStartTime(): number {
    return this.startTime;
  }

  public getElapsedMs(): number {
    if (!this.startTime) return 0;
    return Date.now() - this.startTime;
  }

  public getRemainingSeconds(): number {
    const elapsed = this.getElapsedMs();
    return Math.max(0, Math.ceil((SESSION_CAP_MS - elapsed) / 1000));
  }

  public isWarningActive(): boolean {
    return this.warningFired && !this.timeoutFired;
  }

  public stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

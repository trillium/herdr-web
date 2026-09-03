import { isUsableTerminalSize, type TerminalSize } from "./terminalRenderer";

/**
 * Frames a degenerate measurement is re-attempted for before giving up.
 *
 * An iOS dynamic-viewport transition settles in roughly 300ms, so ~500ms at
 * 60fps covers it with room to spare. The bound matters because a measurement
 * can also be unavailable for a reason no number of frames will fix — the
 * renderer was disposed mid-transition, say — and an unbounded retry would then
 * spin a `requestAnimationFrame` loop for the life of the page. The
 * ResizeObserver and the settle timers in `TerminalView` remain the long-term
 * backstop either way.
 */
export const MAX_TERMINAL_MEASURE_RETRY_FRAMES = 30;

export type TerminalFrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (handle: number) => void;
};

export const windowFrameScheduler: TerminalFrameScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * Delivers terminal measurements, dropping the ones that are not real.
 *
 * `fit()` reports whatever Ghostty derived from the container, which is 0 while
 * the container has no layout. The bridge sizes the shared pty to the smallest
 * connected client, so forwarding a zero would blank every viewer of that
 * terminal rather than just this one — see `isUsableTerminalSize`. A degenerate
 * result is therefore not sent at all; it is re-measured on the next frame,
 * because a dynamic-viewport transition is not guaranteed to emit a further
 * resize event once it settles.
 *
 * At most one retry is in flight, so a burst of measurements during a single
 * transition collapses to one pending attempt.
 */
export class TerminalMeasurePump {
  #scheduler: TerminalFrameScheduler;
  #frame: number | null = null;

  constructor(scheduler: TerminalFrameScheduler = windowFrameScheduler) {
    this.#scheduler = scheduler;
  }

  /**
   * Measures once and hands a usable size to `deliver`, otherwise schedules a
   * re-measure. Returns whether this attempt delivered.
   */
  run(measure: () => TerminalSize | null, deliver: (size: TerminalSize) => void): boolean {
    return this.#attempt(measure, deliver, MAX_TERMINAL_MEASURE_RETRY_FRAMES);
  }

  /** Drops any pending retry; safe to call more than once. */
  cancel() {
    if (this.#frame === null) {
      return;
    }
    this.#scheduler.cancel(this.#frame);
    this.#frame = null;
  }

  #attempt(
    measure: () => TerminalSize | null,
    deliver: (size: TerminalSize) => void,
    framesLeft: number,
  ): boolean {
    const size = measure();
    if (isUsableTerminalSize(size)) {
      this.cancel();
      deliver(size);
      return true;
    }
    if (framesLeft <= 0 || this.#frame !== null) {
      return false;
    }
    this.#frame = this.#scheduler.request(() => {
      this.#frame = null;
      this.#attempt(measure, deliver, framesLeft - 1);
    });
    return false;
  }
}

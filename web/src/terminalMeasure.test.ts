import { describe, expect, it, vi } from "vitest";

import {
  MAX_TERMINAL_MEASURE_RETRY_FRAMES,
  TerminalMeasurePump,
  type TerminalFrameScheduler,
} from "./terminalMeasure";
import type { TerminalSize } from "./terminalRenderer";

/** A frame scheduler that only advances when the test says so. */
function manualScheduler() {
  const pending = new Map<number, () => void>();
  let nextHandle = 1;
  const scheduler: TerminalFrameScheduler = {
    request: (callback) => {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel: (handle) => {
      pending.delete(handle);
    },
  };
  return {
    scheduler,
    get pendingCount() {
      return pending.size;
    },
    /** Runs every callback queued for the current frame. */
    advance() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, callback] of due) {
        callback();
      }
      return due.length;
    },
  };
}

describe("TerminalMeasurePump", () => {
  it("delivers a usable measurement immediately", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();

    expect(pump.run(() => ({ cols: 80, rows: 24 }), deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledWith({ cols: 80, rows: 24 });
    expect(frames.pendingCount).toBe(0);
  });

  it("does not send a degenerate measurement and re-measures next frame", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();
    // iOS Safari mid dynamic-viewport transition: 0 first, real size once the
    // container has been laid out.
    const sizes: TerminalSize[] = [
      { cols: 0, rows: 0 },
      { cols: 90, rows: 30 },
    ];
    const measure = vi.fn(() => sizes.shift() ?? null);

    expect(pump.run(measure, deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(frames.pendingCount).toBe(1);

    frames.advance();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith({ cols: 90, rows: 30 });
  });

  it("treats a zero on either axis as no measurement", () => {
    const frames = manualScheduler();
    const deliver = vi.fn();
    for (const degenerate of [
      { cols: 0, rows: 24 },
      { cols: 80, rows: 0 },
    ]) {
      const pump = new TerminalMeasurePump(frames.scheduler);
      expect(pump.run(() => degenerate, deliver)).toBe(false);
    }
    expect(deliver).not.toHaveBeenCalled();
  });

  it("keeps at most one retry in flight across a burst of measurements", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();
    const measure = () => ({ cols: 0, rows: 0 });

    pump.run(measure, deliver);
    pump.run(measure, deliver);
    pump.run(measure, deliver);
    expect(frames.pendingCount).toBe(1);
  });

  it("gives up rather than spinning frames forever when a size never arrives", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();
    // A disposed renderer measures null no matter how long it is retried.
    const measure = vi.fn(() => null);

    pump.run(measure, deliver);
    let advances = 0;
    while (frames.advance() > 0) {
      advances += 1;
      expect(advances).toBeLessThanOrEqual(MAX_TERMINAL_MEASURE_RETRY_FRAMES + 1);
    }

    expect(advances).toBe(MAX_TERMINAL_MEASURE_RETRY_FRAMES);
    expect(deliver).not.toHaveBeenCalled();
    expect(frames.pendingCount).toBe(0);
  });

  it("drops a pending retry once a later attempt succeeds", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();

    pump.run(() => ({ cols: 0, rows: 0 }), deliver);
    expect(frames.pendingCount).toBe(1);

    pump.run(() => ({ cols: 100, rows: 40 }), deliver);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(frames.pendingCount).toBe(0);
  });

  it("cancels a pending retry on teardown", () => {
    const frames = manualScheduler();
    const pump = new TerminalMeasurePump(frames.scheduler);
    const deliver = vi.fn();

    pump.run(() => ({ cols: 0, rows: 0 }), deliver);
    pump.cancel();
    pump.cancel();

    expect(frames.pendingCount).toBe(0);
    expect(frames.advance()).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });
});

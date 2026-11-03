import { describe, expect, it } from "vitest";
import { proposeTerminalFit } from "./terminalRenderer";

const phone = {
  clientWidth: 440,
  clientHeight: 600,
  paddingTop: 6,
  paddingBottom: 4,
  paddingLeft: 4,
  paddingRight: 3,
  cellWidth: 9,
  cellHeight: 18,
  scrollbarReservePx: 0,
};

describe("proposeTerminalFit", () => {
  it("fills the width left after padding with no scrollbar reserve", () => {
    expect(proposeTerminalFit(phone)).toEqual({ cols: 48, rows: 32 });
  });

  it("gains columns on a phone compared with the scrollbar reserve", () => {
    const reserved = proposeTerminalFit({ ...phone, scrollbarReservePx: 15 });
    const fitted = proposeTerminalFit(phone);
    expect(fitted!.cols).toBeGreaterThan(reserved!.cols);
    expect(reserved).toEqual({ cols: 46, rows: 32 });
  });

  it("re-fits when the container height changes (soft keyboard)", () => {
    expect(proposeTerminalFit({ ...phone, clientHeight: 300 })!.rows).toBe(16);
  });

  it("reports no measurement for an unlaid-out container or missing metrics", () => {
    expect(proposeTerminalFit({ ...phone, clientWidth: 0 })).toBeNull();
    expect(proposeTerminalFit({ ...phone, clientHeight: 0 })).toBeNull();
    expect(proposeTerminalFit({ ...phone, cellWidth: 0 })).toBeNull();
  });

  it("never proposes fewer than 2 columns or 1 row", () => {
    expect(proposeTerminalFit({ ...phone, clientWidth: 20, clientHeight: 12 })).toEqual({
      cols: 2,
      rows: 1,
    });
  });
});

import { describe, expect, it } from "vitest";
import { readTerminalUsage, terminalUsageLevel } from "./terminalUsage";

describe("readTerminalUsage", () => {
  it("reads hourly and weekly percentages from state labels", () => {
    expect(
      readTerminalUsage({ usage_hourly_pct: "42", usage_weekly_pct: "17.5" }),
    ).toEqual({ hourlyPct: 42, weeklyPct: 17.5 });
  });

  it("returns undefined fields when labels are missing", () => {
    expect(readTerminalUsage(undefined)).toEqual({ hourlyPct: undefined, weeklyPct: undefined });
    expect(readTerminalUsage({})).toEqual({ hourlyPct: undefined, weeklyPct: undefined });
  });

  it("ignores unparsable values", () => {
    expect(readTerminalUsage({ usage_hourly_pct: "not-a-number" }).hourlyPct).toBeUndefined();
  });

  it("clamps out-of-range values to 0..100", () => {
    expect(readTerminalUsage({ usage_hourly_pct: "150" }).hourlyPct).toBe(100);
    expect(readTerminalUsage({ usage_weekly_pct: "-5" }).weeklyPct).toBe(0);
  });
});

describe("terminalUsageLevel", () => {
  it("is normal below 70%", () => {
    expect(terminalUsageLevel(0)).toBe("normal");
    expect(terminalUsageLevel(69)).toBe("normal");
  });

  it("is warn from 70% up to 90%", () => {
    expect(terminalUsageLevel(70)).toBe("warn");
    expect(terminalUsageLevel(89)).toBe("warn");
  });

  it("is critical at 90% and above", () => {
    expect(terminalUsageLevel(90)).toBe("critical");
    expect(terminalUsageLevel(100)).toBe("critical");
  });
});

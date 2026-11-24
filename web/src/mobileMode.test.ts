import { describe, expect, it } from "vitest";
import { parseMobileModeStatus } from "./mobileMode";

describe("parseMobileModeStatus", () => {
  it("reads the flag from a bridge that has one", () => {
    expect(parseMobileModeStatus({ active: true })).toEqual({ active: true, supported: true });
    expect(parseMobileModeStatus({ active: false })).toEqual({ active: false, supported: true });
  });

  it("reports a herdr machine remote as unsupported", () => {
    expect(parseMobileModeStatus({ active: false, supported: false })).toEqual({
      active: false,
      supported: false,
    });
  });

  it("keeps the toggle for bodies that say nothing", () => {
    expect(parseMobileModeStatus(null)).toEqual({ active: null, supported: true });
    expect(parseMobileModeStatus("nope")).toEqual({ active: null, supported: true });
    expect(parseMobileModeStatus({ error: "x" })).toEqual({ active: null, supported: true });
    expect(parseMobileModeStatus({ active: "yes", supported: "no" })).toEqual({
      active: null,
      supported: true,
    });
  });
});

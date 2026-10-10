import { describe, expect, it } from "vitest";
import {
  MAX_TERMINAL_ATTACH_CONFLICT_RETRIES,
  TERMINAL_CONNECTION_OVERLAY_DELAY_MS,
  isNonRetryableTerminalClose,
  isTerminalAttachConflictClose,
  isTerminalKickClearStateClose,
  parseTerminalCloseReason,
  terminalConnectionCopy,
  terminalConnectionOverlayDelayMs,
} from "./terminalConnectionStatus";

describe("terminalConnectionStatus", () => {
  it("parses terminal close reason messages", () => {
    expect(
      parseTerminalCloseReason(
        JSON.stringify({ type: "closed", reason: "terminal attach taken over" }),
      ),
    ).toBe("terminal attach taken over");
    expect(
      parseTerminalCloseReason(JSON.stringify({ type: "notice", reason: "ignored" })),
    ).toBeNull();
    expect(parseTerminalCloseReason("not json")).toBeNull();
  });

  it("classifies non-retryable terminal attach close reasons", () => {
    expect(isNonRetryableTerminalClose("terminal already has an attached client")).toBe(true);
    expect(isNonRetryableTerminalClose("terminal attach taken over")).toBe(true);
    expect(isNonRetryableTerminalClose("terminal attach failed: terminal abc missing")).toBe(true);
    expect(isNonRetryableTerminalClose("temporary network close")).toBe(false);
    expect(isNonRetryableTerminalClose(null)).toBe(false);
    // The bridge emits this when an attach loses to sustained detach churn;
    // it must stay retryable so the client's backoff resolves it.
    expect(
      isNonRetryableTerminalClose("terminal attach conflicted with a pending detach; retry shortly"),
    ).toBe(false);
  });

  it("classifies attach conflicts for the bounded retry budget", () => {
    expect(
      isTerminalAttachConflictClose(
        "terminal attach failed: terminal abc already has an attached client; retry with --takeover",
      ),
    ).toBe(true);
    expect(isTerminalAttachConflictClose("terminal attach taken over")).toBe(false);
    expect(isTerminalAttachConflictClose(null)).toBe(false);
    expect(MAX_TERMINAL_ATTACH_CONFLICT_RETRIES).toBeGreaterThan(0);
  });

  it("maps terminal connection states to status copy", () => {
    expect(terminalConnectionCopy("connecting", null)).toBe("Connecting");
    expect(terminalConnectionCopy("connecting", null, true)).toBe("Reconnecting");
    expect(terminalConnectionCopy("closed", "terminal already has an attached client")).toBe(
      "Attached elsewhere",
    );
    expect(terminalConnectionCopy("closed", "terminal attach taken over")).toBe(
      "Detached elsewhere",
    );
    expect(terminalConnectionCopy("error", null)).toBe("Connection failed");
  });

  it("delays only transient connecting overlays", () => {
    expect(terminalConnectionOverlayDelayMs("connecting", true)).toBe(
      TERMINAL_CONNECTION_OVERLAY_DELAY_MS,
    );
    expect(terminalConnectionOverlayDelayMs("connecting", false)).toBe(0);
    expect(terminalConnectionOverlayDelayMs("closed", true)).toBe(0);
    expect(terminalConnectionOverlayDelayMs("error", true)).toBe(0);
    expect(terminalConnectionOverlayDelayMs("attached", true)).toBe(0);
    expect(terminalConnectionOverlayDelayMs("idle", true)).toBe(0);
  });

  it("lets a kicked device reconnect, resetting only when asked", () => {
    expect(isNonRetryableTerminalClose("kicked")).toBe(false);
    expect(isNonRetryableTerminalClose("kicked: clear saved state")).toBe(false);
    expect(isTerminalKickClearStateClose("kicked")).toBe(false);
    expect(isTerminalKickClearStateClose("kicked: clear saved state")).toBe(true);
  });
});

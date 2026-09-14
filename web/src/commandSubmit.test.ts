/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

import {
  COMMAND_SUBMIT_EVENT_TYPE,
  COMMAND_SUBMIT_FRESHNESS_MS,
  decideCommandSubmit,
  emitCommandSubmitRequest,
  noteCommandSubmitSeen,
  parseCommandSubmitSignal,
  subscribeCommandSubmitRequests,
} from "./commandSubmit";
import type { CommandSubmitGuardInput, CommandSubmitSignal } from "./commandSubmit";

function signal(overrides: Partial<CommandSubmitSignal> = {}): CommandSubmitSignal {
  return {
    pane_id: "pane-a",
    terminal_id: null,
    request_id: "req-1",
    source: "talon-ender",
    ts: 1_756_000_000_000,
    ...overrides,
  };
}

function guardInput(overrides: Partial<CommandSubmitGuardInput> = {}): CommandSubmitGuardInput {
  return {
    signal: signal(),
    paneId: "pane-a",
    terminalId: null,
    disabled: false,
    composing: false,
    draft: "echo hi",
    nowMs: 1_756_000_000_000,
    ...overrides,
  };
}

describe("parseCommandSubmitSignal", () => {
  it("parses a full bridge payload", () => {
    expect(
      parseCommandSubmitSignal(
        JSON.stringify({
          type: COMMAND_SUBMIT_EVENT_TYPE,
          pane_id: "pane-a",
          terminal_id: "term-9",
          request_id: "req-1",
          source: "talon-ender",
          ts: 1_756_000_000_000,
        }),
      ),
    ).toEqual({
      pane_id: "pane-a",
      terminal_id: "term-9",
      request_id: "req-1",
      source: "talon-ender",
      ts: 1_756_000_000_000,
    });
  });

  it("defaults missing terminal_id and source", () => {
    expect(
      parseCommandSubmitSignal(
        JSON.stringify({
          type: COMMAND_SUBMIT_EVENT_TYPE,
          pane_id: "pane-a",
          request_id: "req-1",
          ts: 42,
        }),
      ),
    ).toEqual({
      pane_id: "pane-a",
      terminal_id: null,
      request_id: "req-1",
      source: "unknown",
      ts: 42,
    });
  });

  it("rejects other ui-event types and malformed payloads", () => {
    expect(parseCommandSubmitSignal(JSON.stringify({ type: "herdr_web.notes_changed" }))).toBeNull();
    expect(parseCommandSubmitSignal("not json")).toBeNull();
    expect(parseCommandSubmitSignal(null)).toBeNull();
    expect(parseCommandSubmitSignal(JSON.stringify({ type: COMMAND_SUBMIT_EVENT_TYPE }))).toBeNull();
    expect(
      parseCommandSubmitSignal(
        JSON.stringify({
          type: COMMAND_SUBMIT_EVENT_TYPE,
          pane_id: "pane-a",
          request_id: "req-1",
          ts: "not-a-number",
        }),
      ),
    ).toBeNull();
  });
});

describe("decideCommandSubmit", () => {
  it("submits a fresh in-scope signal with a non-empty draft", () => {
    expect(decideCommandSubmit(guardInput(), new Set())).toBe("submit");
  });

  it("ignores signals for other panes", () => {
    expect(
      decideCommandSubmit(guardInput({ signal: signal({ pane_id: "pane-b" }) }), new Set()),
    ).toBe("wrong-pane");
  });

  it("ignores terminal mismatches only when both sides are known", () => {
    expect(
      decideCommandSubmit(
        guardInput({ signal: signal({ terminal_id: "term-2" }), terminalId: "term-1" }),
        new Set(),
      ),
    ).toBe("wrong-pane");
    expect(
      decideCommandSubmit(
        guardInput({ signal: signal({ terminal_id: "term-1" }), terminalId: null }),
        new Set(),
      ),
    ).toBe("submit");
    expect(
      decideCommandSubmit(
        guardInput({ signal: signal({ terminal_id: null }), terminalId: "term-1" }),
        new Set(),
      ),
    ).toBe("submit");
  });

  it("dedupes redelivered request ids", () => {
    expect(decideCommandSubmit(guardInput(), new Set(["req-1"]))).toBe("duplicate");
  });

  it("rejects stale signals past the freshness bound", () => {
    expect(
      decideCommandSubmit(
        guardInput({ nowMs: 1_756_000_000_000 + COMMAND_SUBMIT_FRESHNESS_MS + 1 }),
        new Set(),
      ),
    ).toBe("stale");
  });

  it("refuses to submit while detached, composing, or with an empty draft", () => {
    expect(decideCommandSubmit(guardInput({ disabled: true }), new Set())).toBe("not-ready");
    expect(decideCommandSubmit(guardInput({ composing: true }), new Set())).toBe("composing");
    expect(decideCommandSubmit(guardInput({ draft: "   " }), new Set())).toBe("empty");
    expect(decideCommandSubmit(guardInput({ draft: "" }), new Set())).toBe("empty");
  });
});

describe("noteCommandSubmitSeen", () => {
  it("caps the dedupe set", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 250; i += 1) {
      noteCommandSubmitSeen(seen, `req-${i}`);
    }
    expect(seen.size).toBeLessThanOrEqual(200);
    expect(seen.has("req-249")).toBe(true);
  });
});

describe("command submit bus", () => {
  it("fans out to subscribers until unsubscribed", () => {
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = subscribeCommandSubmitRequests(first);
    const releaseSecond = subscribeCommandSubmitRequests(second);
    const payload = signal();
    emitCommandSubmitRequest(payload);
    expect(first).toHaveBeenCalledExactlyOnceWith(payload);
    expect(second).toHaveBeenCalledExactlyOnceWith(payload);
    releaseFirst();
    releaseSecond();
    emitCommandSubmitRequest(payload);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

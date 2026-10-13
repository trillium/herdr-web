import { describe, expect, it, vi } from "vitest";

import {
  FOCUS_NEXT_AGENT_EVENT_TYPE,
  FOCUS_NEXT_AGENT_FRESHNESS_MS,
  consumeFocusNextAgentSignal,
  emitFocusNextAgentRequest,
  parseFocusNextAgentSignal,
  subscribeFocusNextAgentRequests,
} from "./focusNextAgent";

const signal = { request_id: "req-1", source: "parlay", ts: 1_000 };

describe("parseFocusNextAgentSignal", () => {
  it("parses a well-formed event", () => {
    expect(
      parseFocusNextAgentSignal(
        JSON.stringify({ type: FOCUS_NEXT_AGENT_EVENT_TYPE, request_id: "r", source: "parlay", ts: 5 }),
      ),
    ).toEqual({ request_id: "r", source: "parlay", ts: 5 });
  });

  it("defaults a missing source to unknown", () => {
    expect(
      parseFocusNextAgentSignal(
        JSON.stringify({ type: FOCUS_NEXT_AGENT_EVENT_TYPE, request_id: "r", ts: 5 }),
      )?.source,
    ).toBe("unknown");
  });

  it("rejects other events and malformed payloads", () => {
    expect(parseFocusNextAgentSignal(JSON.stringify({ type: "herdr_web.notes_changed" }))).toBeNull();
    expect(
      parseFocusNextAgentSignal(JSON.stringify({ type: FOCUS_NEXT_AGENT_EVENT_TYPE, ts: 5 })),
    ).toBeNull();
    expect(
      parseFocusNextAgentSignal(
        JSON.stringify({ type: FOCUS_NEXT_AGENT_EVENT_TYPE, request_id: "r" }),
      ),
    ).toBeNull();
    expect(parseFocusNextAgentSignal("not json")).toBeNull();
    expect(parseFocusNextAgentSignal(null)).toBeNull();
  });
});

describe("consumeFocusNextAgentSignal", () => {
  it("focuses once, then drops the repeated request id", () => {
    const seen = new Set<string>();
    expect(consumeFocusNextAgentSignal(signal, seen, 1_100)).toBe("focus");
    expect(consumeFocusNextAgentSignal(signal, seen, 1_200)).toBe("duplicate");
  });

  it("drops stale signals without consuming their id", () => {
    const seen = new Set<string>();
    const now = signal.ts + FOCUS_NEXT_AGENT_FRESHNESS_MS + 1;
    expect(consumeFocusNextAgentSignal(signal, seen, now)).toBe("stale");
    expect(seen.size).toBe(0);
  });
});

describe("focus-next listeners", () => {
  it("delivers emitted signals until unsubscribed", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFocusNextAgentRequests(listener);
    emitFocusNextAgentRequest(signal);
    unsubscribe();
    emitFocusNextAgentRequest(signal);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(signal);
  });
});

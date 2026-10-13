export const FOCUS_NEXT_AGENT_EVENT_TYPE = "herdr_web.focus_next_agent_requested";

export const FOCUS_NEXT_AGENT_FRESHNESS_MS = 5000;

const MAX_SEEN_REQUEST_IDS = 200;

export type FocusNextAgentSignal = {
  request_id: string;
  source: string;
  ts: number;
};

export function parseFocusNextAgentSignal(data: unknown): FocusNextAgentSignal | null {
  if (typeof data !== "string") {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== FOCUS_NEXT_AGENT_EVENT_TYPE) {
    return null;
  }
  if (typeof record.request_id !== "string" || record.request_id.length === 0) {
    return null;
  }
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) {
    return null;
  }
  return {
    request_id: record.request_id,
    source:
      typeof record.source === "string" && record.source.length > 0
        ? record.source
        : "unknown",
    ts: record.ts,
  };
}

export type FocusNextAgentDecision = "focus" | "duplicate" | "stale";

/** Decides whether a signal should move focus, recording accepted ids in `seenRequestIds`. */
export function consumeFocusNextAgentSignal(
  signal: FocusNextAgentSignal,
  seenRequestIds: Set<string>,
  nowMs: number,
): FocusNextAgentDecision {
  if (seenRequestIds.has(signal.request_id)) {
    return "duplicate";
  }
  if (nowMs - signal.ts > FOCUS_NEXT_AGENT_FRESHNESS_MS) {
    return "stale";
  }
  seenRequestIds.add(signal.request_id);
  while (seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
    const oldest = seenRequestIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    seenRequestIds.delete(oldest);
  }
  return "focus";
}

export type FocusNextAgentListener = (signal: FocusNextAgentSignal) => void;

const listeners = new Set<FocusNextAgentListener>();

export function emitFocusNextAgentRequest(signal: FocusNextAgentSignal): void {
  listeners.forEach((listener) => {
    listener(signal);
  });
}

export function subscribeFocusNextAgentRequests(
  listener: FocusNextAgentListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

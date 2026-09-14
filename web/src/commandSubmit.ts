export const COMMAND_SUBMIT_EVENT_TYPE = "herdr_web.command_submit_requested";

export const COMMAND_SUBMIT_FRESHNESS_MS = 5000;

const MAX_SEEN_REQUEST_IDS = 200;

export type CommandSubmitSignal = {
  pane_id: string;
  terminal_id: string | null;
  request_id: string;
  source: string;
  ts: number;
};

export function parseCommandSubmitSignal(data: unknown): CommandSubmitSignal | null {
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
  if (record.type !== COMMAND_SUBMIT_EVENT_TYPE) {
    return null;
  }
  if (typeof record.pane_id !== "string" || record.pane_id.length === 0) {
    return null;
  }
  if (typeof record.request_id !== "string" || record.request_id.length === 0) {
    return null;
  }
  if (typeof record.ts !== "number" || !Number.isFinite(record.ts)) {
    return null;
  }
  return {
    pane_id: record.pane_id,
    terminal_id:
      typeof record.terminal_id === "string" && record.terminal_id.length > 0
        ? record.terminal_id
        : null,
    request_id: record.request_id,
    source:
      typeof record.source === "string" && record.source.length > 0
        ? record.source
        : "unknown",
    ts: record.ts,
  };
}

export type CommandSubmitGuardInput = {
  signal: CommandSubmitSignal;
  paneId: string;
  terminalId: string | null;
  disabled: boolean;
  composing: boolean;
  draft: string;
  nowMs: number;
};

export type CommandSubmitDecision =
  | "submit"
  | "wrong-pane"
  | "duplicate"
  | "stale"
  | "not-ready"
  | "composing"
  | "empty";

export function decideCommandSubmit(
  input: CommandSubmitGuardInput,
  seenRequestIds: Set<string>,
): CommandSubmitDecision {
  const { signal, paneId, terminalId, disabled, composing, draft, nowMs } = input;
  if (signal.pane_id !== paneId) {
    return "wrong-pane";
  }
  if (signal.terminal_id !== null && terminalId !== null && signal.terminal_id !== terminalId) {
    return "wrong-pane";
  }
  if (seenRequestIds.has(signal.request_id)) {
    return "duplicate";
  }
  if (nowMs - signal.ts > COMMAND_SUBMIT_FRESHNESS_MS) {
    return "stale";
  }
  if (disabled) {
    return "not-ready";
  }
  if (composing) {
    return "composing";
  }
  if (draft.trim().length === 0) {
    return "empty";
  }
  return "submit";
}

export function noteCommandSubmitSeen(seenRequestIds: Set<string>, requestId: string): void {
  seenRequestIds.add(requestId);
  while (seenRequestIds.size > MAX_SEEN_REQUEST_IDS) {
    const oldest = seenRequestIds.values().next().value;
    if (oldest === undefined) {
      break;
    }
    seenRequestIds.delete(oldest);
  }
}

export type CommandSubmitListener = (signal: CommandSubmitSignal) => void;

const listeners = new Set<CommandSubmitListener>();

export function emitCommandSubmitRequest(signal: CommandSubmitSignal): void {
  listeners.forEach((listener) => {
    listener(signal);
  });
}

export function subscribeCommandSubmitRequests(
  listener: CommandSubmitListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

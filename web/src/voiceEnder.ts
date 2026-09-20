// Voice line-ender wiring (task-ayazf): pure helpers + fetch shims around the
// `parlay-input` wrapper mounted by ParlayInput.
//
// Protocol contract (see task-ayazf comment; engine side is task-ev0ny):
//   UP:   every voice-box change POSTs {streamId (stable per box), version,
//         text, cursor, reason:'input', voiceEnabled:true, device,
//         platform:'herdr'} to the Parlay server POST /api/chat/eval.
//         `parlay-input` sends every field except `platform`, so the fetch
//         wrapper here injects it — the engine scopes the submit handler to
//         parlay+herdr and drops platform-less Herdr traffic at the relay.
//   DOWN: the shared device SSE carries `input_action`; advisory
//         armTimer/cancelTimer render the 1s countdown ONLY (never submit).
//   SUBMIT: an async submitNow {requireTail, text:''} re-verifies the tail
//         against the LIVE buffer inside `parlay-input`, strips the ender, and
//         the remainder is submitted via the live bridge path
//         (POST /api/command-submit -> herdr_web.command_submit_requested).
//
// Per-box isolation is server-side by streamId — one streamId per input box.

/** Platform tag every Herdr voice-box eval POST must carry. */
export const VOICE_ENDER_PLATFORM = "herdr";

/** `source` value for voice-ender submissions on POST /api/command-submit. */
export const VOICE_ENDER_SOURCE = "parlay-ender";

/** Reason value the up-channel sends on every voice-box change. */
export const VOICE_ENDER_INPUT_REASON = "input";

/** Advisory verbs the engine pushes around the 1s server verify hold. */
export const ARM_TIMER_VERB = "armTimer";
export const CANCEL_TIMER_VERB = "cancelTimer";

/** Host-driven tab-switch verbs, routed to the pane navigation callbacks. */
export const NEXT_TAB_VERB = "nextTab";
export const PREV_TAB_VERB = "prevTab";

/** Minimal structural shape of a pushed action (mirrors parlay-input types). */
export type VoiceEnderAction = {
  verb: string;
  args?: {
    text?: string;
    requireTail?: string;
    timerId?: string;
    fireInMs?: number;
    [key: string]: unknown;
  };
};

export type VoiceEnderCountdown = {
  timerId: string;
  fireInMs: number;
};

/**
 * Read an advisory armTimer action: returns the countdown to render, or null
 * for any other verb. Never submits — the authoritative timer is server-side.
 */
export function parseEnderCountdown(action: VoiceEnderAction): VoiceEnderCountdown | null {
  if (action.verb !== ARM_TIMER_VERB) {
    return null;
  }
  const fireInMs = Number(action.args?.fireInMs ?? 1000);
  return {
    timerId: String(action.args?.timerId ?? ""),
    fireInMs: Number.isFinite(fireInMs) && fireInMs >= 0 ? fireInMs : 1000,
  };
}

/** True when the action cancels a previously armed advisory countdown. */
export function isEnderCancel(action: VoiceEnderAction): boolean {
  return action.verb === CANCEL_TIMER_VERB;
}

type FetchInitLike = { method?: string; headers?: Record<string, string>; body?: string };

type FetchLike = (input: string, init?: FetchInitLike) => Promise<unknown>;

/**
 * Wrap fetch so POST /api/chat/eval bodies gain `platform:'herdr'`.
 * `parlay-input` owns the up-channel shape (streamId/version/text/cursor/
 * reason/voiceEnabled/tabs/device) and has no platform option; the engine
 * needs the tag to route Herdr boxes to the submit handler. Every other
 * request passes through byte-identical.
 */
export function withHerdrPlatform<T extends FetchLike>(fetchImpl: T): T {
  const wrapped = ((input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (
      url.endsWith("/api/chat/eval") &&
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      typeof init?.body === "string"
    ) {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        return fetchImpl(input, init);
      }
      if (typeof body === "object" && body !== null && Array.isArray(body) === false) {
        return fetchImpl(input, {
          ...init,
          body: JSON.stringify({ ...body, platform: VOICE_ENDER_PLATFORM }),
        });
      }
    }
    return fetchImpl(input, init);
  }) as T;
  return wrapped;
}

export type VoiceCommandSubmitRequest = {
  paneId: string;
  terminalId: string | null;
  requestId: string;
  source: string;
};

/**
 * Submit the live box draft via the bridge path: POST /api/command-submit
 * (same origin — no Parlay origin-guard or CSP carve-out involved). The bridge
 * broadcasts herdr_web.command_submit_requested and the pane's
 * TerminalCommandControls submits the LIVE buffer through the shared
 * decideCommandSubmit guard (wrong-pane/duplicate/stale/composing/empty).
 */
export async function postVoiceCommandSubmit(
  fetchImpl: typeof fetch,
  request: VoiceCommandSubmitRequest,
): Promise<{ request_id: string; pane_id: string; ts: number }> {
  const body: Record<string, string> = {
    pane_id: request.paneId,
    request_id: request.requestId,
    source: request.source,
  };
  if (request.terminalId) {
    body.terminal_id = request.terminalId;
  }
  const response = await fetchImpl("/api/command-submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`command-submit failed: ${response.status}`);
  }
  return (await response.json()) as { request_id: string; pane_id: string; ts: number };
}

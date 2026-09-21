// Voice stream health: the `parlay-input` wrapper owns its SSE channel and
// exposes no connection state — reconnects are silent, and a dead stream
// masquerades as "submit is broken" (task-qj0k1). This module tracks the
// stream from the outside so the local submit fallback can tell "server path
// down" from "everything fine", and so the flight recorder (task-gu0ka)
// can beam a per-connection autopsy on every drop: readyState at the error,
// time-to-drop since the last open, error class, and messages received
// between drops.
//
//   - down on SSE error or a failed/non-OK eval POST,
//   - back up on SSE open, any SSE message (a message proves liveness), or a
//     successful eval POST.
//
// Record methods return true when the down flag flips, so callers log the
// sse-open/sse-drop transitions only — never per-keystroke noise. Detail
// strings are printable ASCII key=value pairs sized for the 120-char client
// log cap.

export type VoiceStreamHooks = {
  onOpen?: () => void;
  /**
   * SSE error; carries the EventSource `readyState` at the moment of the
   * error (0 connecting/retrying, 1 open, 2 closed/gave-up) so the client
   * log can record the drop reason, not just the drop. `undefined` when the
   * constructor exposes no `readyState` (test doubles).
   */
  onError?: (readyState?: number) => void;
  onMessage?: () => void;
};

export class VoiceStreamHealth {
  private down = false;
  private openAt = 0;
  private lastDropAt = 0;
  private messagesSinceOpen = 0;

  constructor(private now: () => number = () => Date.now()) {}

  isDown(): boolean {
    return this.down;
  }

  /** SSE (re)connected. Returns true when the flag flips down -> up. */
  recordSseOpen(): boolean {
    this.openAt = this.now();
    this.messagesSinceOpen = 0;
    return this.setDown(false);
  }

  /** SSE errored (the browser will retry, but right now nothing arrives). */
  recordSseError(): boolean {
    this.lastDropAt = this.now();
    return this.setDown(true);
  }

  /** An SSE envelope arrived — the stream is alive by definition. */
  recordSseMessage(): boolean {
    this.messagesSinceOpen += 1;
    return this.setDown(false);
  }

  /** Eval POST round-tripped 2xx. */
  recordEvalOk(): boolean {
    return this.setDown(false);
  }

  /** Eval POST threw or returned non-OK. */
  recordEvalFail(): boolean {
    this.lastDropAt = this.now();
    return this.setDown(true);
  }

  private setDown(next: boolean): boolean {
    const flipped = this.down !== next;
    this.down = next;
    return flipped;
  }

  /**
   * Per-connection autopsy for the sse-drop detail: readyState at the
   * error, ms since the last open (time-to-drop), error class, and
   * messages received between drops. `readyState` is the EventSource
   * value at error time (0 connecting, 1 open, 2 closed, -1 unknown).
   */
  autopsyOnDrop(readyState: number, errorClass = "error-event"): string {
    const ageMs = Math.max(0, this.now() - this.openAt);
    const safeReady = Number.isFinite(readyState) ? readyState : -1;
    const safeClass = /^[a-z0-9-]+$/i.test(errorClass) ? errorClass : "error-event";
    return `rs=${safeReady} age=${ageMs}ms msgs=${this.messagesSinceOpen} err=${safeClass}`;
  }

  /** Ms since the last drop, for the sse-open detail after a reconnect. */
  downtimeMs(): number {
    if (this.lastDropAt <= 0) {
      return 0;
    }
    return Math.max(0, this.now() - this.lastDropAt);
  }
}

export type EventSourceCtor = new (url: string | URL) => EventSource;

/**
 * Wrap an EventSource constructor so open/error/message flip a shared health
 * tracker. The wrapper passes the constructor straight to `new`, so this
 * factory returns a `new`-able function with the same single-url shape the
 * `parlay-input` wrapper constructs internally.
 *
 * Pass `undefined` (no EventSource in this runtime) through: the caller must
 * then pass `undefined` on to the wrapper so its built-in default applies.
 */
export function makeTrackedEventSource(
  Base: EventSourceCtor | undefined | null,
  health: VoiceStreamHealth,
  hooks: VoiceStreamHooks = {},
): EventSourceCtor | undefined {
  if (Base == null) {
    return undefined;
  }
  const Ctor: EventSourceCtor = Base;
  function Tracked(url: string | URL): EventSource {
    const source = new Ctor(url);
    source.addEventListener("open", () => {
      health.recordSseOpen();
      hooks.onOpen?.();
    });
    source.addEventListener("error", () => {
      const readyState =
        typeof (source as EventSource & { readyState?: unknown }).readyState === "number"
          ? (source as EventSource & { readyState: number }).readyState
          : undefined;
      health.recordSseError();
      hooks.onError?.(readyState);
    });
    // Any envelope proves the stream is alive, even between open/error flaps.
    source.addEventListener("message", () => {
      health.recordSseMessage();
      hooks.onMessage?.();
    });
    source.addEventListener("input_action", () => {
      health.recordSseMessage();
      hooks.onMessage?.();
    });
    return source;
  }
  return Tracked as unknown as EventSourceCtor;
}

type EvalInit = { method?: string; body?: string };

/** Answered verbs peeked from one eval round trip (at most 3, verb-safe). */
export type EvalTripInfo = {
  status: string;
  latencyMs: number;
  verbs: string[];
};

const MAX_EVAL_VERBS = 3;
const MAX_VERB_CHARS = 32;

/**
 * Pull answered verbs out of an eval response body without trusting its
 * shape: looks for an `actions` array with string `verb` fields, else a
 * top-level `verb`. Anything else yields no verbs — never throws, never
 * leaks body text (verbs are allow-listed to word characters and dashes).
 */
export function extractEvalVerbs(body: unknown): string[] {
  const verbs: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string" || verbs.length >= MAX_EVAL_VERBS) {
      return;
    }
    const clean = value.trim().slice(0, MAX_VERB_CHARS);
    if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(clean) && !verbs.includes(clean)) {
      verbs.push(clean);
    }
  };
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const actions = record.actions;
    if (Array.isArray(actions)) {
      for (const action of actions) {
        push((action as Record<string, unknown> | null)?.verb);
      }
    }
    push(record.verb);
  }
  return verbs;
}

/** `status=200 latency=42ms verbs=submitNow|none` — sized for the log cap. */
export function formatEvalTrip(info: EvalTripInfo): string {
  const verbs = info.verbs.length > 0 ? info.verbs.join("|") : "none";
  return `status=${info.status} latency=${Math.max(0, Math.round(info.latencyMs))}ms verbs=${verbs}`;
}

/**
 * Wrap fetch so eval POST outcomes flip the health tracker and surface to
 * the client log. Every other request passes through byte-identical, and the
 * observed response is returned untouched. Network throws count as failures.
 *
 * Flight-recorder round trips (task-gu0ka): each eval POST reports status,
 * latency, and the answered verbs peeked from a cloned response body — the
 * original response is never consumed, and a body that will not parse
 * simply reports `verbs=none`.
 */
export function observeEvalFetch<T extends (input: string, init?: EvalInit) => Promise<Response>>(
  fetchImpl: T,
  hooks: {
    onEvalOk?: (status: number, trip?: EvalTripInfo) => void;
    onEvalFail?: (status: string, trip?: EvalTripInfo) => void;
  } = {},
): T {
  const wrapped = (async (input: string, init?: EvalInit) => {
    const url = String(input);
    const isEvalPost =
      url.endsWith("/api/chat/eval") && (init?.method ?? "GET").toUpperCase() === "POST";
    if (!isEvalPost) {
      return fetchImpl(input, init);
    }
    const started = performance.now();
    const peekVerbs = async (response: Response): Promise<string[]> => {
      try {
        return extractEvalVerbs(await response.clone().json());
      } catch {
        return [];
      }
    };
    try {
      const response = await fetchImpl(input, init);
      const latencyMs = performance.now() - started;
      if (response.ok) {
        const verbs = await peekVerbs(response);
        hooks.onEvalOk?.(response.status, {
          status: String(response.status),
          latencyMs,
          verbs,
        });
      } else {
        hooks.onEvalFail?.(String(response.status), {
          status: String(response.status),
          latencyMs,
          verbs: [],
        });
      }
      return response;
    } catch (error) {
      hooks.onEvalFail?.("network", {
        status: "network",
        latencyMs: performance.now() - started,
        verbs: [],
      });
      throw error;
    }
  }) as T;
  return wrapped;
}

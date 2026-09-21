// Voice stream health: the `parlay-input` wrapper owns its SSE channel and
// exposes no connection state — reconnects are silent, and a dead stream
// masquerades as "submit is broken" (task-qj0k1). This module tracks the
// stream from the outside so the local submit fallback can tell "server path
// down" from "everything fine":
//
//   - down on SSE error or a failed/non-OK eval POST,
//   - back up on SSE open, any SSE message (a message proves liveness), or a
//     successful eval POST.
//
// Record methods return true when the down flag flips, so callers log the
// sse-open/sse-drop transitions only — never per-keystroke noise.

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

  isDown(): boolean {
    return this.down;
  }

  /** SSE (re)connected. Returns true when the flag flips down -> up. */
  recordSseOpen(): boolean {
    return this.setDown(false);
  }

  /** SSE errored (the browser will retry, but right now nothing arrives). */
  recordSseError(): boolean {
    return this.setDown(true);
  }

  /** An SSE envelope arrived — the stream is alive by definition. */
  recordSseMessage(): boolean {
    return this.setDown(false);
  }

  /** Eval POST round-tripped 2xx. */
  recordEvalOk(): boolean {
    return this.setDown(false);
  }

  /** Eval POST threw or returned non-OK. */
  recordEvalFail(): boolean {
    return this.setDown(true);
  }

  private setDown(next: boolean): boolean {
    const flipped = this.down !== next;
    this.down = next;
    return flipped;
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
      health.recordSseError();
      const readyState =
        typeof (source as EventSource & { readyState?: unknown }).readyState === "number"
          ? (source as EventSource & { readyState: number }).readyState
          : undefined;
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

/**
 * Wrap fetch so eval POST outcomes flip the health tracker and surface to
 * the client log. Every other request passes through byte-identical, and the
 * observed response is returned untouched. Network throws count as failures.
 */
export function observeEvalFetch<T extends (input: string, init?: EvalInit) => Promise<Response>>(
  fetchImpl: T,
  hooks: {
    onEvalOk?: (status: number) => void;
    onEvalFail?: (status: string) => void;
  } = {},
): T {
  const wrapped = (async (input: string, init?: EvalInit) => {
    const url = String(input);
    const isEvalPost =
      url.endsWith("/api/chat/eval") && (init?.method ?? "GET").toUpperCase() === "POST";
    if (!isEvalPost) {
      return fetchImpl(input, init);
    }
    try {
      const response = await fetchImpl(input, init);
      if (response.ok) {
        hooks.onEvalOk?.(response.status);
      } else {
        hooks.onEvalFail?.(String(response.status));
      }
      return response;
    } catch (error) {
      hooks.onEvalFail?.("network");
      throw error;
    }
  }) as T;
  return wrapped;
}

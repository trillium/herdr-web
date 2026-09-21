import { useEffect, useRef, useState } from "react";
import type { CompositionEvent, KeyboardEvent } from "react";
import { logClientEvent } from "./clientLog";
import { autosizeMobileCommandTextarea } from "./mobileCommandTextarea";
import { randomId } from "./randomId";
import {
  matchFallbackTail,
  VOICE_FALLBACK_GRACE_MS,
} from "./voiceSubmitFallback";
import {
  makeTrackedEventSource,
  observeEvalFetch,
  VoiceStreamHealth,
} from "./voiceStreamHealth";
import {
  isEnderCancel,
  NEXT_TAB_VERB,
  parseEnderCountdown,
  PREV_TAB_VERB,
  withHerdrPlatform,
  type VoiceEnderAction,
} from "./voiceEnder";

// `parlay-input` is a real `file:./vendor/parlay-input` dependency (vendored
// prebuilt copy), so this import resolves in dev, test, and production on
// every checkout. The guarded dynamic import stays in a try/catch so a broken
// install degrades to a plain input in dev instead of a blank page — but that
// fallback must never ship to prod: the post-build
// `scripts/check-parlay-bundle.mjs` guard fails the build if the wrapper's
// marker ever goes missing from the bundle again. Do NOT externalize
// `parlay-input` in vite.config.ts.
let parlayInputFn: typeof import("parlay-input").parlayInput | null = null;

try {
  ({ parlayInput: parlayInputFn } = await import("parlay-input"));
} catch (error) {
  // parlay-input unavailable; component will render as a plain input.
  // This should only happen in dev with a broken install — never in prod.
  console.warn("parlay-input unavailable, voice input disabled:", error);
}

export interface ParlayInputProps {
  value: string;
  onValueChange: (next: string) => void;
  onVoiceSubmit: (text: string) => void;
  /** Advance to the next agent pane ("next agent"/"next tab" parlay command). */
  onNextAgent?: () => void;
  /** Return to the previous agent pane ("previous agent" parlay command). */
  onPrevAgent?: () => void;
  disabled: boolean;
  expandingInput: boolean;
  enterNewline: boolean;
  controlsScalePercent: number;
  /**
   * User-facing voice-submit switch (Settings). Gates BOTH the parlay-input
   * mount and the eval `voiceEnabled` flag. Defaults ON: with it off the box
   * is a plain input and no eval voice traffic leaves the page.
   */
  voiceSubmitEnabled?: boolean;
  /**
   * Stable per-box id used as the Parlay `streamId` (per-box isolation is
   * server-side by streamId — one streamId per input box). Falls back to a
   * per-mount random id when omitted.
   */
  boxId?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart?: (event: CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  onCompositionEnd?: (event: CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) => void;
  inputRef: (node: HTMLInputElement | HTMLTextAreaElement | null) => void;
}

type Countdown = {
  timerId: string;
  deadlineMs: number;
};

/** Minimal envelope shape the wrapper hands to `onApply(result, env)`. */
type VoiceEnderApplyEnv = {
  actions?: { verb?: string; args?: { requireTail?: string } }[];
};

/** EventSource readyState at error time -> client-log drop reason. */
function sseDropReason(readyState?: number): string {
  switch (readyState) {
    case 0:
      return "es-connecting";
    case 1:
      return "es-open";
    case 2:
      return "es-closed";
    default:
      return "es-error";
  }
}

export function ParlayInput({
  value,
  onValueChange,
  onVoiceSubmit,
  onNextAgent,
  onPrevAgent,
  disabled,
  expandingInput,
  enterNewline,
  controlsScalePercent,
  voiceSubmitEnabled = true,
  boxId,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  inputRef,
}: ParlayInputProps) {
  // The Parlay server lives on the same host, port 4242. A private-LAN page
  // origin (http://192.168.x:8787, .local, loopback) passes the server's
  // origin guard; a Tailnet (100.x) origin does NOT and needs
  // PARLAY_ALLOWED_ORIGINS server-side (see web/README.md).
  const PARLAY_SERVER_URL = `${window.location.protocol}//${window.location.hostname}:4242`;

  // Set when the browser refuses to open the parlay event stream at all. The
  // parlay server is a separate origin (port 4242) and this page's CSP is
  // `connect-src 'self' data:` plus `--allow-connect-origin` entries, so every
  // parlay round trip is blocked without the flag — the component has to fall
  // back to a plain input.
  const [parlayStreamBlocked, setParlayStreamBlocked] = useState(false);
  // Advisory voice-ender countdown (armTimer): rendered only, never submits.
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [nowMs, setNowMs] = useState(0);
  // Stream health (task-qj0k1): the wrapper owns its SSE and reports no
  // connection state, so track it from the outside — the local fallback may
  // fire ONLY while this is flagged down.
  const healthRef = useRef<VoiceStreamHealth | null>(null);
  if (!healthRef.current) {
    healthRef.current = new VoiceStreamHealth();
  }
  // Pending fallback watchdog per armed timer; cleared on resolve/unmount.
  // Tracked separately from the displayed countdown: the countdown ticker
  // auto-clears shortly past the deadline, but the fallback decision needs
  // the armed timer until the server path resolves it or the watchdog fires.
  const armedFallbackRef = useRef<{ timerId: string; requireTail?: string } | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFallbackTimer = () => {
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    armedFallbackRef.current = null;
  };
  useEffect(() => clearFallbackTimer, []);

  const [node, setNode] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Element mirror for the submit path, which also fires from timeouts.
  const nodeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  const onVoiceSubmitRef = useRef(onVoiceSubmit);
  const onNextAgentRef = useRef(onNextAgent);
  const onPrevAgentRef = useRef(onPrevAgent);
  const disabledRef = useRef(disabled);
  valueRef.current = value;
  onValueChangeRef.current = onValueChange;
  onVoiceSubmitRef.current = onVoiceSubmit;
  onNextAgentRef.current = onNextAgent;
  onPrevAgentRef.current = onPrevAgent;
  disabledRef.current = disabled;

  // Session-scoped device id so one browser tab can't receive another's SSE
  // actions; the stream id is stable per box (per-box isolation server-side).
  const idsRef = useRef<{ device: string; stream: string } | undefined>(undefined);
  if (!idsRef.current) {
    idsRef.current = {
      device: `herdr-web-mobile-${randomId()}`,
      stream: boxId ?? `herdr-web-mobile-command-${randomId()}`,
    };
  }
  const { device: deviceId, stream: streamId } = idsRef.current;

  const setCommandInputNode = (next: HTMLInputElement | HTMLTextAreaElement | null) => {
    nodeRef.current = next;
    setNode(next);
    inputRef(next);
  };

  // Autosize textarea when expanding input is enabled (works with or without parlay).
  useEffect(() => {
    if (expandingInput) {
      autosizeMobileCommandTextarea(node);
    }
  }, [expandingInput, controlsScalePercent, value, node]);

  // Advisory countdown ticker; auto-clears shortly after the deadline as a
  // safety net if the matching cancelTimer is ever lost.
  useEffect(() => {
    if (!countdown) {
      return;
    }
    setNowMs(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      if (now - countdown.deadlineMs > 500) {
        setCountdown(null);
        return;
      }
      setNowMs(now);
    }, 100);
    return () => clearInterval(timer);
  }, [countdown]);

  // Stage stripped submit text through the live bridge path. Shared by the
  // server submitNow and the local fallback so both face the same guard.
  // Drops here mirror the decideCommandSubmit vocabulary (not-ready/empty)
  // so every lost submit carries its reason in the client log.
  const stageAndSubmitRef = useRef<(text: string) => void>(() => {});
  stageAndSubmitRef.current = (text: string) => {
    const target = nodeRef.current;
    setCountdown(null);
    if (target) {
      target.value = text;
    }
    valueRef.current = text;
    onValueChangeRef.current(text);
    if (disabledRef.current) {
      logClientEvent("submit-dropped", "not-ready");
      return;
    }
    if (!text.trim()) {
      logClientEvent("submit-dropped", "empty");
      return;
    }
    onVoiceSubmitRef.current(text);
  };
  // Set when the wrapper's submitNow fires onSubmit inside an envelope;
  // consumed by onApply to record the server tail re-verify outcome. Both
  // fire synchronously inside one applyEnvelope, so the pairing is exact.
  const serverSubmitFiredRef = useRef(false);

  // The parlay-input eval loop. `parlayInput` owns the whole protocol: every
  // edit debounce-POSTs {streamId, version, text, cursor, reason:'input',
  // voiceEnabled, platform:'herdr', device} to /api/chat/eval, and every
  // SSE input_action envelope is staleness/seq-checked before it touches the
  // box. submitNow's requireTail is re-verified against the LIVE buffer before
  // onSubmit fires; armTimer/cancelTimer are advisory countdown only.
  //
  // The mount is gated on the voice-submit toggle: with it off the box is a
  // plain input and no eval voice traffic leaves the page.
  useEffect(() => {
    const mount = parlayInputFn;
    if (!mount || !node || !voiceSubmitEnabled) {
      return;
    }
    // Chrome surfaces a CSP block as an async `error` event, but WebKit throws
    // SecurityError straight out of the EventSource constructor. Unguarded,
    // that throw escapes this effect, React tears down the whole tree, and
    // Safari/iOS render a blank page — the browser cannot show a terminal
    // because a voice input could not reach an optional sidecar. Treat it as
    // parlay being unavailable, which is a state this component already renders.
    // (parlay-input opens its owned SSE inside this call, so the constructor
    // throw surfaces here, not in a later event.)
    const health = healthRef.current;
    if (!health) {
      return;
    }
    // Eval POST outcomes flip stream health and feed the client log; the
    // platform tag the engine needs is injected underneath.
    const observedFetch = observeEvalFetch(withHerdrPlatform(fetch.bind(window)), {
      onEvalOk: () => {
        health.recordEvalOk();
        logClientEvent("eval-ok");
      },
      onEvalFail: (status) => {
        if (health.recordEvalFail()) {
          logClientEvent("sse-drop", `eval-${status}`);
        }
        logClientEvent("eval-fail", status);
      },
    });
    // The wrapper opens its owned SSE through this constructor, so open and
    // error transitions are visible here even though the wrapper reports no
    // connection state of its own.
    const TrackedEventSource = makeTrackedEventSource(globalThis.EventSource, health, {
      onOpen: () => logClientEvent("sse-open"),
      onError: (readyState) => logClientEvent("sse-drop", sseDropReason(readyState)),
    });
    try {
      return mount(node, {
        server: PARLAY_SERVER_URL,
        device: deviceId,
        streamId,
        voiceEnabled: voiceSubmitEnabled,
        fetch: observedFetch,
        ...(TrackedEventSource ? { EventSource: TrackedEventSource } : {}),
        onSubmit: (text: string) => {
          // `text` is the buffer with the ender tail already stripped and
          // re-verified against the live element. Stage it synchronously —
          // DOM first so the bridge-path submit below always reads the live
          // buffer even if the React re-render has not flushed yet — then
          // submit the remainder via the live bridge path.
          serverSubmitFiredRef.current = true;
          clearFallbackTimer();
          stageAndSubmitRef.current(text);
        },
        onAction: (action: VoiceEnderAction) => {
          // Advisory countdown only — the authoritative 1s verify-hold timer
          // is server-side. This NEVER submits locally; the async submitNow
          // (or its cancelTimer) arrives separately over the same SSE. The
          // watchdog below is the SOLE local-submit path, and only while
          // the stream is flagged down (task-qj0k1 backstop).
          const armed = parseEnderCountdown(action);
          if (armed) {
            setCountdown({ timerId: armed.timerId, deadlineMs: Date.now() + armed.fireInMs });
            const requireTail =
              typeof action.args?.requireTail === "string"
                ? action.args.requireTail
                : undefined;
            logClientEvent("ender-result", requireTail ? "armed-require-tail" : "armed");
            clearFallbackTimer();
            armedFallbackRef.current = { timerId: armed.timerId, requireTail };
            const armedEntry = armedFallbackRef.current;
            fallbackTimerRef.current = setTimeout(() => {
              fallbackTimerRef.current = null;
              // Stand down unless THIS arming is still unresolved...
              if (armedFallbackRef.current !== armedEntry) {
                return;
              }
              armedFallbackRef.current = null;
              // ...and the stream is still flagged down (recovered => the
              // server path owns the submit again).
              if (!healthRef.current?.isDown()) {
                logClientEvent("ender-result", "fallback-stood-down");
                return;
              }
              // Re-verify the tail against the LIVE buffer: a server submit
              // that won first stages stripped text (tail gone) or clears
              // the box, so this fails and the fallback stands down — never
              // double-submit with the server path.
              const live = nodeRef.current?.value ?? valueRef.current;
              const stripped = matchFallbackTail(live, armedEntry.requireTail);
              if (!stripped) {
                logClientEvent("ender-result", "fallback-no-tail");
                setCountdown(null);
                return;
              }
              logClientEvent("fallback-engaged", armedEntry.requireTail ? "tail" : "phrase");
              if (disabledRef.current) {
                logClientEvent("submit-dropped", "disabled");
                return;
              }
              stageAndSubmitRef.current(stripped);
            }, armed.fireInMs + VOICE_FALLBACK_GRACE_MS);
            return;
          }
          if (isEnderCancel(action)) {
            clearFallbackTimer();
            setCountdown(null);
            logClientEvent("ender-result", "cancelled");
            return;
          }
          if (action.verb === NEXT_TAB_VERB) {
            onNextAgentRef.current?.();
            return;
          }
          if (action.verb === PREV_TAB_VERB) {
            onPrevAgentRef.current?.();
            return;
          }
          // Host-unknown verbs (pickers, navigation, speech, hints): ignore,
          // never wedge the input.
        },
        onApply: (result: string, env?: VoiceEnderApplyEnv) => {
          // Server-applied buffer verbs (setText/clear/replaceRange) write the
          // DOM node directly; mirror the live value back into React state so
          // the controlled input never desyncs from its element.
          const live = node.value;
          if (live !== valueRef.current) {
            valueRef.current = live;
            onValueChangeRef.current(live);
          }
          // Ender-match detail for the client log: the wrapper reports no
          // connection state and no match verdicts of its own, so reconstruct
          // them here from the apply outcome. submitNow envelopes resolve
          // against the flag onSubmit set synchronously above (tail-ok vs
          // only-ender vs moved-past-the-tail); every other non-applied
          // outcome logs verbatim. Plain applied envelopes stay silent.
          const fired = serverSubmitFiredRef.current;
          serverSubmitFiredRef.current = false;
          const verbs = env?.actions?.map((entry) => entry?.verb) ?? [];
          if (verbs.includes("submitNow")) {
            const submitNow = env?.actions?.find((entry) => entry?.verb === "submitNow");
            const hasTail =
              typeof submitNow?.args?.requireTail === "string" &&
              submitNow.args.requireTail.length > 0;
            if (result !== "applied") {
              logClientEvent("ender-result", "submitnow-tail-stale");
            } else if (fired && hasTail) {
              logClientEvent("ender-result", "submitnow-tail-ok");
            } else if (fired) {
              logClientEvent("ender-result", "submitnow-applied");
            } else {
              logClientEvent("ender-result", "submitnow-only-ender");
            }
            return;
          }
          if (result === "applied") {
            return;
          }
          if (result === "resync" || result === "rejected-protocol") {
            logClientEvent("ender-result", result);
            return;
          }
          const verb = verbs.find((entry) => typeof entry === "string" && entry.length > 0);
          logClientEvent("ender-result", `${verb ?? "action"}-${result}`);
        },
        onError: (error: unknown) => {
          console.debug("parlay voice input error:", error);
        },
      });
    } catch (error) {
      console.debug("parlay event stream unavailable:", error);
      setParlayStreamBlocked(true);
      return;
    }
    // The mount closure reads everything mutable through refs, so the binding
    // is intentionally created once per element — except across voice-submit
    // toggles, which mount/unmount the eval loop.
  }, [node, voiceSubmitEnabled]);

  // With the toggle off (or the stream blocked) the box is a plain input:
  // no mount, no eval voice traffic.
  const client = voiceSubmitEnabled && !parlayStreamBlocked ? parlayInputFn : null;

  const remainingMs = countdown ? Math.max(0, countdown.deadlineMs - nowMs) : 0;
  const countdownHint =
    countdown && client ? (
      <span className="term-voice-countdown" role="status" aria-live="polite">
        Sending in {Math.max(1, Math.ceil(remainingMs / 1000))}s…
      </span>
    ) : null;

  const handleChange = (next: string) => {
    // Report to React only — `parlay-input` listens for the same DOM input
    // event itself and POSTs the live buffer to /api/chat/eval after settle.
    valueRef.current = next;
    onValueChange(next);
  };

  // If parlay is not available, render a plain input.
  if (!client) {
    if (expandingInput) {
      return (
        <textarea
          ref={setCommandInputNode}
          className="term-native-input mono"
          rows={1}
          data-expanding="true"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={enterNewline ? "enter" : "send"}
          disabled={disabled}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
        />
      );
    }
    return (
      <input
        ref={setCommandInputNode}
        className="term-native-input mono"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
        disabled={disabled}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
    );
  }

  if (expandingInput) {
    return (
      <>
        <textarea
          ref={setCommandInputNode}
          className="term-native-input mono"
          rows={1}
          data-expanding="true"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint={enterNewline ? "enter" : "send"}
          disabled={disabled}
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
        />
        {countdownHint}
      </>
    );
  }
  return (
    <>
      <input
        ref={setCommandInputNode}
        className="term-native-input mono"
        type="text"
        autoCapitalize="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
        disabled={disabled}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
      {countdownHint}
    </>
  );
}

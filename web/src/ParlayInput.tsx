import { useEffect, useRef, useState } from "react";
import type { CompositionEvent, KeyboardEvent } from "react";
import { autosizeMobileCommandTextarea } from "./mobileCommandTextarea";
import { randomId } from "./randomId";
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

  const [node, setNode] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null);
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

  // The parlay-input eval loop. `parlayInput` owns the whole protocol: every
  // edit debounce-POSTs {streamId, version, text, cursor, reason:'input',
  // voiceEnabled:true, platform:'herdr', device} to /api/chat/eval, and every
  // SSE input_action envelope is staleness/seq-checked before it touches the
  // box. submitNow's requireTail is re-verified against the LIVE buffer before
  // onSubmit fires; armTimer/cancelTimer are advisory countdown only.
  useEffect(() => {
    const mount = parlayInputFn;
    if (!mount || !node) {
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
    try {
      return mount(node, {
        server: PARLAY_SERVER_URL,
        device: deviceId,
        streamId,
        voiceEnabled: true,
        fetch: withHerdrPlatform(fetch.bind(window)),
        onSubmit: (text: string) => {
          // `text` is the buffer with the ender tail already stripped and
          // re-verified against the live element. Stage it synchronously —
          // DOM first so the bridge-path submit below always reads the live
          // buffer even if the React re-render has not flushed yet — then
          // submit the remainder via the live bridge path.
          setCountdown(null);
          node.value = text;
          valueRef.current = text;
          onValueChangeRef.current(text);
          if (disabledRef.current) {
            return;
          }
          if (text.trim()) {
            onVoiceSubmitRef.current(text);
          }
        },
        onAction: (action: VoiceEnderAction) => {
          // Advisory countdown only — the authoritative 1s verify-hold timer
          // is server-side. This NEVER submits locally; the async submitNow
          // (or its cancelTimer) arrives separately over the same SSE.
          const armed = parseEnderCountdown(action);
          if (armed) {
            setCountdown({ timerId: armed.timerId, deadlineMs: Date.now() + armed.fireInMs });
            return;
          }
          if (isEnderCancel(action)) {
            setCountdown(null);
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
        onApply: () => {
          // Server-applied buffer verbs (setText/clear/replaceRange) write the
          // DOM node directly; mirror the live value back into React state so
          // the controlled input never desyncs from its element.
          const live = node.value;
          if (live !== valueRef.current) {
            valueRef.current = live;
            onValueChangeRef.current(live);
          }
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
    // is intentionally created once per element.
  }, [node]);

  const client = parlayStreamBlocked ? null : parlayInputFn;

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

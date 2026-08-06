import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import type { ActionEnvelope, CommandContext } from "@parlay/client";
import { autosizeMobileCommandTextarea } from "./mobileCommandTextarea";
import { randomId } from "./randomId";

// @parlay/client is optional at runtime — it requires web/local-deps/parlay-client
// (local symlink). If unavailable, this component degrades to a plain input with
// no voice-submit phrase detection. See web/README.md for setup.
//
// `const` rather than `let`: TypeScript only narrows a possibly-null binding
// inside the closures below (effects, ctx callbacks) when it cannot be
// reassigned, which is what lets `parlay` be typed instead of `any`.
type ParlayClient = typeof import("@parlay/client");
let loadedParlay: ParlayClient | null = null;
try {
  loadedParlay = await import("@parlay/client");
} catch {
  // parlay-client unavailable; component renders as a plain input.
}
const parlay = loadedParlay;

// "localhost" would resolve to the client device itself when this page is loaded
// remotely (e.g. over Tailscale/LAN from a phone), not the machine serving it —
// derive the host from the page's own origin instead. Registered once at module
// load rather than on every render; it is a side effect, not render output.
const PARLAY_SERVER_URL = `${window.location.protocol}//${window.location.hostname}:4242`;
parlay?.setEvalServerBaseUrl(PARLAY_SERVER_URL);

export interface ParlayMobileInputProps {
  value: string;
  onValueChange: (next: string) => void;
  onVoiceSubmit: (text: string) => void;
  disabled: boolean;
  expandingInput: boolean;
  enterNewline: boolean;
  controlsScalePercent: number;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef: (node: HTMLInputElement | HTMLTextAreaElement | null) => void;
}

export function ParlayMobileInput({
  value,
  onValueChange,
  onVoiceSubmit,
  disabled,
  expandingInput,
  enterNewline,
  controlsScalePercent,
  onKeyDown,
  inputRef,
}: ParlayMobileInputProps) {
  const nodeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  const onValueChangeRef = useRef(onValueChange);
  const onVoiceSubmitRef = useRef(onVoiceSubmit);
  const disabledRef = useRef(disabled);
  valueRef.current = value;
  onValueChangeRef.current = onValueChange;
  onVoiceSubmitRef.current = onVoiceSubmit;
  disabledRef.current = disabled;

  const setCommandInputNode = (node: HTMLInputElement | HTMLTextAreaElement | null) => {
    nodeRef.current = node;
    inputRef(node);
  };

  // Autosize the textarea when expanding input is enabled (works with or without parlay).
  useEffect(() => {
    if (expandingInput) {
      autosizeMobileCommandTextarea(nodeRef.current);
    }
  }, [expandingInput, controlsScalePercent, value]);

  // Session-scoped device IDs so one browser tab can't receive or replay another
  // tab's SSE-broadcast actions (the server's /api/chat/events stream is
  // otherwise unauthenticated and keyed only by these IDs). randomId() rather
  // than a bare crypto.randomUUID(): this component only mounts in mobile mode,
  // and the origins herdr-web is reached from on a phone (plain-HTTP LAN /
  // .local / Tailscale) are exactly the insecure contexts where randomUUID is
  // undefined.
  const idsRef = useRef<{ device: string; stream: string } | undefined>(undefined);
  if (!idsRef.current) {
    idsRef.current = {
      device: `herdr-web-mobile-${randomId()}`,
      stream: `herdr-web-mobile-command-${randomId()}`,
    };
  }
  const { device: deviceId, stream: streamId } = idsRef.current;

  // Stable CommandContext identity: parlay's dispatcher context is a module
  // singleton, so this must be built once and kept fresh via the refs above
  // rather than recreated (and re-registered) on every render.
  const ctxRef = useRef<CommandContext | null>(null);
  if (parlay && !ctxRef.current) {
    ctxRef.current = {
      input: {
        value: () => valueRef.current,
        // Deliberately does NOT bump the input version / schedule an eval —
        // mirrors @parlay/client's own ctx.ts: programmatic edits (server
        // actions) must not re-trigger the pass that produced them.
        setText(t: string) {
          valueRef.current = t;
          onValueChangeRef.current(t);
        },
        clear() {
          valueRef.current = "";
          onValueChangeRef.current("");
        },
        submit(text: string) {
          if (disabledRef.current) return;
          const trimmed = text.trim();
          valueRef.current = "";
          onValueChangeRef.current("");
          if (trimmed) onVoiceSubmitRef.current(trimmed);
        },
        selection: () => ({
          anchor: nodeRef.current?.selectionStart ?? 0,
          active: nodeRef.current?.selectionEnd ?? 0,
        }),
        setSelection(anchor: number, active: number) {
          nodeRef.current?.setSelectionRange(Math.min(anchor, active), Math.max(anchor, active));
        },
      },
      // herdr-web is a single terminal pane, not a multi-agent tab strip —
      // tab/channel commands have nothing to resolve here.
      tabs: {
        list: () => [],
        active: () => null,
        switch: () => false,
        archive: () => false,
        next: () => {},
        prev: () => {},
      },
      drawer: { open: () => {} },
      speech: { stop: () => {} },
      settings: { get: () => parlay.PARLAY_SETTINGS_DEFAULTS },
      workspace: { navigate: () => false, present: () => false },
    };
  }

  useEffect(() => {
    const ctx = ctxRef.current;
    if (!parlay || !ctx) return;
    parlay.setDispatcherContext(ctx);
  }, []);

  useEffect(() => {
    if (!parlay) return;
    const evalCtx = () => ({
      voiceEnabled: true,
      settleMs: parlay.PARLAY_SETTINGS_DEFAULTS.voiceSettleMs,
      tabs: [],
      device: deviceId,
      streamId: streamId,
    });
    const resync = (reason: string) => {
      parlay.bumpInputVersion();
      parlay.scheduleEval(() => valueRef.current, evalCtx, true, reason);
    };
    const es = new EventSource(
      `${PARLAY_SERVER_URL}/api/chat/events?device=${encodeURIComponent(deviceId)}`,
    );
    const onInputAction = (event: MessageEvent<string>) => {
      let env: ActionEnvelope;
      try {
        env = JSON.parse(event.data) as ActionEnvelope;
      } catch {
        return;
      }
      // Only act on envelopes addressed to this component's own stream — the
      // server's SSE broadcast is otherwise unauthenticated, and applyEnvelope
      // can drive a submit straight into the terminal pty.
      if (env.streamId !== streamId) return;
      try {
        parlay.applyEnvelope(env, resync);
      } catch {
        // an action must never break input
      }
    };
    es.addEventListener("input_action", onInputAction);
    return () => {
      es.removeEventListener("input_action", onInputAction);
      es.close();
    };
  }, [deviceId, streamId]);

  // Without parlay this is just a controlled-input update; the eval scheduling
  // below is what voice-submit phrase detection needs, and it simply does not
  // run when the client package is absent.
  const handleChange = (next: string) => {
    valueRef.current = next;
    onValueChange(next);
    if (!parlay) return;
    parlay.bumpInputVersion();
    parlay.scheduleEval(
      () => valueRef.current,
      () => ({
        voiceEnabled: true,
        settleMs: parlay.PARLAY_SETTINGS_DEFAULTS.voiceSettleMs,
        tabs: [],
        device: deviceId,
        streamId: streamId,
      }),
      false,
      "input",
    );
  };

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
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={onKeyDown}
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
      onChange={(event) => handleChange(event.target.value)}
    />
  );
}

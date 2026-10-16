import { CommandDraftContext, createCommandDraftStore } from "./commandDrafts";
/**
 * @vitest-environment jsdom
 */
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitCommandSubmitRequest } from "./commandSubmit";
import { TerminalCommandControls } from "./TerminalView";

// Mock the optional local-only `parlay-input` wrapper to capture the voice-ender
// seam (onSubmit) without needing the real eval pipeline.
type CapturedVoiceOptions = {
  streamId: string;
  voiceEnabled: boolean;
  onSubmit: (text: string) => void;
};
let capturedVoiceOptions: CapturedVoiceOptions | null = null;
vi.mock("parlay-input", () => ({
  parlayInput: (_element: Element, options: CapturedVoiceOptions) => {
    capturedVoiceOptions = options;
    return () => {};
  },
}));

const { logClientEventMock } = vi.hoisted(() => ({ logClientEventMock: vi.fn() }));
vi.mock("./clientLog", () => ({
  logClientEvent: (...args: unknown[]) => logClientEventMock(...args),
}));

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  capturedVoiceOptions = null;
  logClientEventMock.mockClear();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("command submit requested events", () => {
  it("submits once with the box text and ignores redelivery", async () => {
    const { container, onSubmitCommand } = await renderControls();
    const field = commandField(container);
    await setCommandValue(field, "dictated command");

    await emitSignal({ pane_id: "pane-a", request_id: "req-1", ts: Date.now() });
    expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("dictated command");

    await emitSignal({ pane_id: "pane-a", request_id: "req-1", ts: Date.now() });
    expect(onSubmitCommand).toHaveBeenCalledTimes(1);
  });

  it("ignores other panes, stale signals, and empty drafts", async () => {
    const { container, onSubmitCommand } = await renderControls();
    await setCommandValue(commandField(container), "dictated command");

    await emitSignal({ pane_id: "pane-b", request_id: "req-other", ts: Date.now() });
    await emitSignal({ pane_id: "pane-a", request_id: "req-stale", ts: Date.now() - 60_000 });
    expect(onSubmitCommand).not.toHaveBeenCalled();

    await emitSignal({ pane_id: "pane-a", request_id: "req-fresh", ts: Date.now() });
    expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("dictated command");

    await emitSignal({ pane_id: "pane-a", request_id: "req-empty", ts: Date.now() });
    expect(onSubmitCommand).toHaveBeenCalledTimes(1);
  });

  it("logs the guard verdict with signal age on stale drops", async () => {
    const { onSubmitCommand } = await renderControls();
    await emitSignal({ pane_id: "pane-a", request_id: "req-stale-age", ts: Date.now() - 60_000 });
    expect(onSubmitCommand).not.toHaveBeenCalled();
    // The verdict carries the signal age so clock skew reads apart from a
    // slow broadcast in the bridge log.
    expect(logClientEventMock).toHaveBeenCalledWith(
      "submit-dropped",
      expect.stringMatching(/^stale ageMs=\d+$/u),
    );
  });

  it("honors terminal scope when both sides are known", async () => {
    const { container, onSubmitCommand } = await renderControls({ terminalId: "term-1" });
    await setCommandValue(commandField(container), "dictated command");

    await emitSignal({
      pane_id: "pane-a",
      terminal_id: "term-2",
      request_id: "req-wrong-term",
      ts: Date.now(),
    });
    expect(onSubmitCommand).not.toHaveBeenCalled();

    await emitSignal({
      pane_id: "pane-a",
      terminal_id: "term-1",
      request_id: "req-right-term",
      ts: Date.now(),
    });
    expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
  });

  it("stages the live text without a trailing enter when mode is stage", async () => {
    const { container, onSubmitCommand, onStageCommand } = await renderControls();
    await setCommandValue(commandField(container), "dictated command");

    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage",
      ts: Date.now(),
      mode: "stage",
    });

    // The mode routes to onStageCommand (the parent enqueues the text without
    // "\r"); a stage must never reach the submitting callback.
    expect(onStageCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
    expect(onSubmitCommand).not.toHaveBeenCalled();
    expect(logClientEventMock).toHaveBeenCalledWith("submit-fired", "talon-ender");

    // Same guards as submit: a redelivered request id is ignored.
    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage",
      ts: Date.now(),
      mode: "stage",
    });
    expect(onStageCommand).toHaveBeenCalledTimes(1);

    // And an empty box still drops.
    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage-empty",
      ts: Date.now(),
      mode: "stage",
    });
    expect(onStageCommand).toHaveBeenCalledTimes(1);
  });

  it("refocuses the emptied box after a mobile stage, like submit", async () => {
    const { container, onStageCommand } = await renderControls({
      mobileFocusAfterSubmit: true,
    });
    await setCommandValue(commandField(container), "dictated command");

    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage-focus",
      ts: Date.now(),
      mode: "stage",
    });

    expect(onStageCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
    const field = commandField(container);
    expect(field.value).toBe("");
    // Dictation continues: the fresh box holds focus so the voice word can be
    // spoken again without a tap.
    expect(document.activeElement).toBe(field);
  });

  it("refocuses the emptied box after a voice stage even with the pref off", async () => {
    const { container, onStageCommand } = await renderControls({
      mobileFocusAfterSubmit: false,
    });
    const before = commandField(container);
    await setCommandValue(before, "dictated command");
    before.focus();
    expect(document.activeElement).toBe(before);

    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage-focus-off",
      ts: Date.now(),
      mode: "stage",
    });

    expect(onStageCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
    const field = commandField(container);
    // Remounted (stale-prefix guard) and still focused despite the pref.
    expect(field).not.toBe(before);
    expect(field.value).toBe("");
    expect(document.activeElement).toBe(field);
  });

  it("leaves manual Send unfocused when the pref is off, focused when on", async () => {
    for (const pref of [false, true]) {
      const { container, onSubmitCommand } = await renderControls({
        mobileFocusAfterSubmit: pref,
      });
      const field = commandField(container);
      await setCommandValue(field, "typed command");
      // Voice-free submit path: a mode:"submit" signal runs submit().
      await emitSignal({
        pane_id: "pane-a",
        request_id: `req-submit-pref-${pref}`,
        ts: Date.now(),
      });
      expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("typed command");
      const fresh = commandField(container);
      expect(fresh.value).toBe("");
      expect(document.activeElement === fresh).toBe(pref);
      await act(async () => {
        for (const root of roots.splice(0)) {
          root.unmount();
        }
      });
      document.body.innerHTML = "";
    }
  });

  it("does not prefix the next input after a voice stage (stale-prefix regression)", async () => {
    const { container, onStageCommand } = await renderControls();
    const before = commandField(container);
    await setCommandValue(before, "first dictation");

    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage-prefix",
      ts: Date.now(),
      mode: "stage",
    });
    expect(onStageCommand).toHaveBeenCalledExactlyOnceWith("first dictation");

    const fresh = commandField(container);
    expect(fresh).not.toBe(before);
    expect(fresh.value).toBe("");
    // The stale node must not leak its old text into the next entry.
    await setCommandValue(fresh, "second");
    expect(commandField(container).value).toBe("second");
    expect(before.isConnected).toBe(false);
  });

  it("beams focus-after-stage with the focus verdict after a voice stage", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => setTimeout(cb, 0));
    const { container } = await renderControls();
    await setCommandValue(commandField(container), "dictated command");
    await emitSignal({
      pane_id: "pane-a",
      request_id: "req-stage-beacon",
      ts: Date.now(),
      mode: "stage",
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(logClientEventMock).toHaveBeenCalledWith(
      "focus-after-stage",
      expect.stringMatching(/^active=1 vvh=\d+$/u),
    );
  });

  it("defers while composing and submits when composition ends", async () => {
    const { container, onSubmitCommand } = await renderControls();
    const field = commandField(container);
    await setCommandValue(field, "composing command");
    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });

    await emitSignal({ pane_id: "pane-a", request_id: "req-composing", ts: Date.now() });
    expect(onSubmitCommand).not.toHaveBeenCalled();

    await act(async () => {
      field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("composing command");
  });
});

describe("voice-ender bridge submit", () => {
  it("stages stripped text and POSTs /api/command-submit mode=stage, staging on broadcast", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      void url;
      void init;
      return Response.json({ request_id: "req-voice", pane_id: "pane-a", ts: Date.now() });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { container, onSubmitCommand, onStageCommand } = await renderControls();
    const voice = capturedVoiceOptions;
    if (!voice) {
      throw new Error("voice box was never wired to parlay-input");
    }
    // One streamId per input box, stable for the pane.
    expect(voice.streamId).toBe("herdr-voice-box-pane-a");
    expect(voice.voiceEnabled).toBe(true);

    await act(async () => {
      voice.onSubmit("dictated command");
    });

    // Staged synchronously into the live element so the bridge-path submit
    // reads it even before the React re-render flushes.
    expect(commandField(container).value).toBe("dictated command");
    // Submitted via the live bridge path, never directly into the terminal —
    // alongside the flight-recorder beacons (ender-match fires first from
    // onSubmit, submit-ack once the bridge answers).
    const submitCall = fetchImpl.mock.calls.find(([url]) => url === "/api/command-submit");
    expect(submitCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    const postedInit = submitCall?.[1] as { body: string } | undefined;
    if (!postedInit) {
      throw new Error("command-submit was never POSTed");
    }
    const posted = JSON.parse(postedInit.body) as Record<string, string>;
    expect(posted).toEqual({
      pane_id: "pane-a",
      request_id: expect.any(String),
      source: "parlay-ender",
      // The ender word stages by default: the bridge echoes mode back and the
      // composer writes the text without pressing Enter, so the user decides.
      mode: "stage",
    });
    expect(onSubmitCommand).not.toHaveBeenCalled();

    await emitSignal({
      pane_id: "pane-a",
      request_id: posted.request_id,
      ts: Date.now(),
      mode: posted.mode as "stage",
    });
    expect(onStageCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
    expect(onSubmitCommand).not.toHaveBeenCalled();

    // Flight-recorder trace: the bridge answer (submit-ack) beams via the
    // client log (mocked here); the onSubmit payload remainder is traced as
    // ender-match by ParlayInput, covered in ParlayInput.test.tsx.
    await act(async () => {});
    const ackCall = logClientEventMock.mock.calls.find(([kind]) => kind === "submit-ack");
    expect(ackCall?.[1]).toEqual(expect.stringContaining("status=200"));
  });
});

async function renderControls(
  options: { terminalId?: string | null; mobileFocusAfterSubmit?: boolean } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const commandInputRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
  const onSubmitCommand = vi.fn();
  const onStageCommand = vi.fn();
  const drafts = createCommandDraftStore();
  await act(async () => {
    root.render(
      <CommandDraftContext.Provider value={drafts}>
        <TerminalCommandControls
          key={JSON.stringify(["bridge-a", "pane-a"])}
          bridgeId="bridge-a"
          paneId="pane-a"
          terminalId={options.terminalId ?? null}
          commandInputRef={commandInputRef}
          disabled={false}
          uploadDisabled={false}
          expandingInput
          enterNewline={false}
          mobileControls
          mobileFocusAfterSubmit={options.mobileFocusAfterSubmit ?? false}
          controlsScalePercent={100}
          compactControls={false}
          onCompactControlsChange={vi.fn()}
          mobileModeActive={false}
          onToggleMobileMode={vi.fn()}
          onNextAgentPane={vi.fn()}
          onPrevAgentPane={vi.fn()}
          pinned={false}
          onPaneCycle={vi.fn()}
          onPaneCycleModeToggle={vi.fn()}
          paneCycleMode="pin"
          onControlsHeightChange={vi.fn()}
          onInput={vi.fn()}
          onTerminalFocus={vi.fn()}
          onUpload={vi.fn()}
          onStageCommand={onStageCommand}
          onSubmitCommand={onSubmitCommand}
        />
      </CommandDraftContext.Provider>,
    );
  });
  return { container, onSubmitCommand, onStageCommand };
}

function commandField(container: HTMLElement) {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    ".term-native-input",
  );
  if (!field) {
    throw new Error("missing command field");
  }
  return field;
}

async function setCommandValue(
  field: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  await act(async () => {
    const prototype =
      field instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function emitSignal(init: {
  pane_id: string;
  terminal_id?: string;
  request_id: string;
  ts: number;
  mode?: "submit" | "stage";
}) {
  await act(async () => {
    emitCommandSubmitRequest({
      pane_id: init.pane_id,
      terminal_id: init.terminal_id ?? null,
      request_id: init.request_id,
      source: "talon-ender",
      mode: init.mode ?? "submit",
      ts: init.ts,
    });
  });
}

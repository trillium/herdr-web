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

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  capturedVoiceOptions = null;
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
  it("stages stripped text and POSTs /api/command-submit, submitting on broadcast", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      void url;
      void init;
      return Response.json({ request_id: "req-voice", pane_id: "pane-a", ts: Date.now() });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const { container, onSubmitCommand } = await renderControls();
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
    // Submitted via the live bridge path, never directly into the terminal.
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "/api/command-submit",
      expect.objectContaining({ method: "POST" }),
    );
    const postedInit = fetchImpl.mock.calls[0]?.[1] as { body: string } | undefined;
    if (!postedInit) {
      throw new Error("command-submit was never POSTed");
    }
    const posted = JSON.parse(postedInit.body) as Record<string, string>;
    expect(posted).toEqual({
      pane_id: "pane-a",
      request_id: expect.any(String),
      source: "parlay-ender",
    });
    expect(onSubmitCommand).not.toHaveBeenCalled();

    await emitSignal({ pane_id: "pane-a", request_id: posted.request_id, ts: Date.now() });
    expect(onSubmitCommand).toHaveBeenCalledExactlyOnceWith("dictated command");
  });
});

async function renderControls(options: { terminalId?: string | null } = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const commandInputRef = createRef<HTMLInputElement | HTMLTextAreaElement>();
  const onSubmitCommand = vi.fn();
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
          onStageCommand={vi.fn()}
          onSubmitCommand={onSubmitCommand}
        />
      </CommandDraftContext.Provider>,
    );
  });
  return { container, onSubmitCommand };
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
}) {
  await act(async () => {
    emitCommandSubmitRequest({
      pane_id: init.pane_id,
      terminal_id: init.terminal_id ?? null,
      request_id: init.request_id,
      source: "talon-ender",
      ts: init.ts,
    });
  });
}

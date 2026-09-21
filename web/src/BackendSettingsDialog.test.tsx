/**
 * @vitest-environment jsdom
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendSettingsDialog } from "./BackendSettingsDialog";

const bridge = vi.hoisted(() => ({
  store: {
    backends: [],
    enabledBridgeIds: [],
  },
  lastSelectedBridgeId: null,
  sameOriginAvailable: true,
  addBackend: vi.fn(),
  deleteBackend: vi.fn(),
  probeBackend: vi.fn(),
  setBridgeEnabled: vi.fn(),
  updateBackend: vi.fn(),
  getRuntime: vi.fn().mockReturnValue(null),
  remoteBridges: [],
}));

vi.mock("./bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bridge")>();
  return {
    ...actual,
    useBridge: () => bridge,
  };
});

const roots: Root[] = [];

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("BackendSettingsDialog terminal accessibility", () => {
  it("offers mobile refocus independently of expanding input", async () => {
    const onFocusChange = vi.fn();
    const { container } = await render(
      <BackendSettingsDialog {...settingsProps()} showMobileTerminalSettings={true}
        mobileCommandExpandingInput={false} onMobileCommandFocusAfterSubmit={onFocusChange} />,
    );
    const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes("Mobile"));
    expect(tab).toBeDefined();
    await act(async () => tab!.click());
    const group = requiredElement<HTMLElement>(container,
      '[role="group"][aria-label="Focus command input after Send"]');
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off.getAttribute("aria-pressed")).toBe("true");
    await act(async () => on.click());
    expect(onFocusChange).toHaveBeenCalledWith(true);
  });

  it("exposes a persisted-style opt-in control in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<SettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Terminal screen-reader text"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("true");
    expect(on?.getAttribute("aria-pressed")).toBe("false");

    await act(async () => on?.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(off?.getAttribute("aria-pressed")).toBe("false");
    expect(on?.getAttribute("aria-pressed")).toBe("true");
  });

  it("allows automatic conflict renaming to be disabled in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<UploadSettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Automatically rename conflicting uploads"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("false");
    expect(on?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => off?.click());
    expect(onChange).toHaveBeenCalledWith(false);
    expect(off?.getAttribute("aria-pressed")).toBe("true");
    expect(on?.getAttribute("aria-pressed")).toBe("false");
  });

  it("offers desktop command composer settings in the Terminal area", async () => {
    const onComposerChange = vi.fn();
    const onEnterNewlineChange = vi.fn();
    const { container } = await render(
      <ComposerSettingsHarness
        onComposerChange={onComposerChange}
        onEnterNewlineChange={onEnterNewlineChange}
      />,
    );
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const composerGroup = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Command composer"]',
    );
    const [composerOff, composerOn] = Array.from(
      composerGroup.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(composerOff?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => composerOn?.click());
    expect(onComposerChange).toHaveBeenCalledWith(true);
    expect(composerOn?.getAttribute("aria-pressed")).toBe("true");

    const newlineGroup = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Desktop composer Enter inserts newline"]',
    );
    const [newlineOff, newlineOn] = Array.from(
      newlineGroup.querySelectorAll<HTMLButtonElement>("button"),
    );
    expect(newlineOn?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => newlineOff?.click());
    expect(onEnterNewlineChange).toHaveBeenCalledWith(false);
    expect(newlineOff?.getAttribute("aria-pressed")).toBe("true");
  });

  it("allows cursor blinking to be enabled in the Terminal area", async () => {
    const onChange = vi.fn();
    const { container } = await render(<CursorBlinkSettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Terminal cursor blink"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(off?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => on?.click());
    expect(onChange).toHaveBeenCalledWith(true);
    expect(on?.getAttribute("aria-pressed")).toBe("true");
  });

  it("offers the voice-submit switch in the Terminal area, defaulting on", async () => {
    const onChange = vi.fn();
    const { container } = await render(<VoiceSubmitSettingsHarness onChange={onChange} />);
    const terminalTab = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes("Terminal"));
    if (!terminalTab) {
      throw new Error("missing Terminal settings tab");
    }

    await act(async () => terminalTab.click());
    const group = requiredElement<HTMLElement>(
      container,
      '[role="group"][aria-label="Voice submit"]',
    );
    const [off, on] = Array.from(group.querySelectorAll<HTMLButtonElement>("button"));
    expect(on?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => off?.click());
    expect(onChange).toHaveBeenCalledWith(false);
    expect(off?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("BackendSettingsDialog build stamp", () => {
  it("shows the web and bridge build stamps in the Bridge area", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        bridge_version: "0.1.0",
        git_sha: "66c5eb6d",
        build_time: "2026-09-03T08:20:55Z",
        protocol_version: 22,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { container } = await render(<SettingsHarness onChange={vi.fn()} />);
      // The Bridge area is the tab the dialog opens on, so the stamp needs no extra taps.
      const values = Array.from(
        container.querySelectorAll<HTMLElement>(".settings-build-value"),
      ).map((node) => node.textContent);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/version");
      expect(values).toHaveLength(2);
      expect(values[0]?.trim()).not.toBe("");
      expect(values[1]).toBe("v0.1.0 · 66c5eb6d · 2026-09-03T08:20:55Z · protocol 22");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("says the bridge stamp is unavailable when /api/version fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      const { container } = await render(<SettingsHarness onChange={vi.fn()} />);
      const values = Array.from(
        container.querySelectorAll<HTMLElement>(".settings-build-value"),
      ).map((node) => node.textContent);
      expect(values[1]).toBe("unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function CursorBlinkSettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [terminalCursorBlink, setTerminalCursorBlink] = useState(false);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      showMobileTerminalSettings={false}
      terminalCursorBlink={terminalCursorBlink}
      onTerminalCursorBlink={(enabled) => {
        onChange(enabled);
        setTerminalCursorBlink(enabled);
      }}
    />
  );
}

function SettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [terminalScreenReaderText, setTerminalScreenReaderText] = useState(false);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      terminalScreenReaderText={terminalScreenReaderText}
      onTerminalScreenReaderText={(enabled) => {
        onChange(enabled);
        setTerminalScreenReaderText(enabled);
      }}
    />
  );
}

function UploadSettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [autoRenameUploadConflicts, setAutoRenameUploadConflicts] = useState(true);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      autoRenameUploadConflicts={autoRenameUploadConflicts}
      onAutoRenameUploadConflicts={(enabled) => {
        onChange(enabled);
        setAutoRenameUploadConflicts(enabled);
      }}
    />
  );
}

function VoiceSubmitSettingsHarness({ onChange }: { onChange: (enabled: boolean) => void }) {
  const [voiceSubmitEnabled, setVoiceSubmitEnabled] = useState(true);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      showMobileTerminalSettings={false}
      voiceSubmitEnabled={voiceSubmitEnabled}
      onVoiceSubmitEnabled={(enabled) => {
        onChange(enabled);
        setVoiceSubmitEnabled(enabled);
      }}
    />
  );
}

function ComposerSettingsHarness({
  onComposerChange,
  onEnterNewlineChange,
}: {
  onComposerChange: (enabled: boolean) => void;
  onEnterNewlineChange: (enabled: boolean) => void;
}) {
  const [desktopCommandComposer, setDesktopCommandComposer] = useState(false);
  const [desktopCommandEnterNewline, setDesktopCommandEnterNewline] = useState(true);
  return (
    <BackendSettingsDialog
      {...settingsProps()}
      showMobileTerminalSettings={false}
      desktopCommandComposer={desktopCommandComposer}
      onDesktopCommandComposer={(enabled) => {
        onComposerChange(enabled);
        setDesktopCommandComposer(enabled);
      }}
      desktopCommandEnterNewline={desktopCommandEnterNewline}
      onDesktopCommandEnterNewline={(enabled) => {
        onEnterNewlineChange(enabled);
        setDesktopCommandEnterNewline(enabled);
      }}
    />
  );
}

function settingsProps() {
  return {
    showMobileTerminalSettings: true,
    mobileCompactControls: false,
    onMobileCompactControlsChange: vi.fn(),
    notesEnabled: true,
    onNotesEnabled: vi.fn(),
    navigationSyncMode: "shared" as const,
    onNavigationSyncMode: vi.fn(),
    agentFeaturesInTabs: true,
    onAgentFeaturesInTabs: vi.fn(),
    combineMatchingWorkspaceNames: false,
    onCombineMatchingWorkspaceNames: vi.fn(),
    multiHostSpaceSelection: true,
    onMultiHostSpaceSelection: vi.fn(),
    terminalFontSizePx: 13,
    onTerminalFontSizePx: vi.fn(),
    terminalCursorBlink: false,
    onTerminalCursorBlink: vi.fn(),
    desktopCommandComposer: false,
    onDesktopCommandComposer: vi.fn(),
    desktopCommandEnterNewline: true,
    onDesktopCommandEnterNewline: vi.fn(),
    terminalScreenReaderText: false,
    onTerminalScreenReaderText: vi.fn(),
    autoRenameUploadConflicts: true,
    onAutoRenameUploadConflicts: vi.fn(),
    terminalInputTransport: "json" as const,
    onTerminalInputTransport: vi.fn(),
    terminalInputBatchDelayMs: 0,
    onTerminalInputBatchDelayMs: vi.fn(),
    terminalOutputCoalesceMs: 16,
    onTerminalOutputCoalesceMs: vi.fn(),
    contentInsetTopPx: 0,
    onContentInsetTopPx: vi.fn(),
    contentInsetBottomPx: 0,
    onContentInsetBottomPx: vi.fn(),
    mobileControlsScalePercent: 100,
    onMobileControlsScalePercent: vi.fn(),
    mobileTerminalTapTarget: "command-input" as const,
    onMobileTerminalTapTarget: vi.fn(),
    mobileLongPressBehavior: "off" as const,
    onMobileLongPressBehavior: vi.fn(),
    mobileTouchSelectionEndpointTimeoutMs: 1500 as const,
    onMobileTouchSelectionEndpointTimeoutMs: vi.fn(),
    mobileCommandExpandingInput: true,
    onMobileCommandExpandingInput: vi.fn(),
    mobileCommandEnterNewline: false,
    mobileCommandFocusAfterSubmit: false,
    onMobileCommandFocusAfterSubmit: vi.fn(),
    onMobileCommandEnterNewline: vi.fn(),
    voiceSubmitEnabled: true,
    onVoiceSubmitEnabled: vi.fn(),
    showMobileKeyboardHideRefit: true,
    mobileKeyboardHideRefit: true,
    onMobileKeyboardHideRefit: vi.fn(),
    onClose: vi.fn(),
  };
}

async function render(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
  return { container, root };
}

function requiredElement<T extends Element = HTMLElement>(
  container: ParentNode,
  selector: string,
) {
  const element = container.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing element: ${selector}`);
  }
  return element;
}

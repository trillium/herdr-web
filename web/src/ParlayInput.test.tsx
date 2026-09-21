/**
 * @vitest-environment jsdom
 *
 * ParlayInput is wired through `parlay-input` (task-ayazf): the wrapper owns
 * the eval loop (REST up-channel + shared SSE down-channel), the component
 * only stages submit text and renders the advisory ender countdown.
 *
 * The optional local-only module is mocked here so the seam is covered with or
 * without the gitignored symlink; the real protocol behavior (payload shape,
 * tail re-verify, stale resync) is pinned against the actual wrapper in
 * voiceEnder.test.ts.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the optional local-only wrapper so we can capture the options the
// component installs (server/ids/voice flag/fetch shim/onSubmit/onAction)
// without needing the real eval pipeline.
type ParlayInputOptions = {
  server: string;
  device: string;
  streamId: string;
  voiceEnabled: boolean;
  fetch: (url: string, init?: unknown) => Promise<unknown>;
  onSubmit: (text: string) => void;
  onAction: (action: { verb: string; args?: Record<string, unknown> }) => void;
  onApply: () => void;
  onError: (error: unknown) => void;
};
let capturedOptions: ParlayInputOptions | null = null;
let mountImpl: ((element: Element, options: ParlayInputOptions) => () => void) | null = null;
vi.mock("parlay-input", () => ({
  parlayInput: (element: Element, options: ParlayInputOptions) => {
    capturedOptions = options;
    if (mountImpl) {
      return mountImpl(element, options);
    }
    return () => {};
  },
}));

const { ParlayInput } = await import("./ParlayInput");

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  capturedOptions = null;
  mountImpl = null;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderInput(props?: {
  onNextAgent?: () => void;
  onPrevAgent?: () => void;
  onVoiceSubmit?: (text: string) => void;
  onValueChange?: (next: string) => void;
  boxId?: string;
  value?: string;
  voiceSubmitEnabled?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ParlayInput
        value={props?.value ?? ""}
        onValueChange={props?.onValueChange ?? (() => {})}
        onVoiceSubmit={props?.onVoiceSubmit ?? (() => {})}
        onNextAgent={props?.onNextAgent}
        onPrevAgent={props?.onPrevAgent}
        disabled={false}
        expandingInput={false}
        enterNewline={false}
        controlsScalePercent={100}
        voiceSubmitEnabled={props?.voiceSubmitEnabled}
        boxId={props?.boxId}
        inputRef={() => {}}
      />,
    );
  });
  return container;
}

function options() {
  if (!capturedOptions) {
    throw new Error("parlayInput was never mounted");
  }
  return capturedOptions;
}

describe("ParlayInput parlay-input wiring", () => {
  it("mounts the voice box with a stable per-box stream id and the herdr voice flag", async () => {
    const container = await renderInput({ boxId: "herdr-voice-box-pane-a" });

    expect(container.querySelector("input.term-native-input")).not.toBeNull();
    const opts = options();
    expect(opts.streamId).toBe("herdr-voice-box-pane-a");
    expect(opts.voiceEnabled).toBe(true);
    expect(opts.device).toMatch(/^herdr-web-mobile-.+/u);
    expect(opts.server).toMatch(/:4242$/u);
  });

  it("routes nextTab/prevTab actions to the pane navigation callbacks", async () => {
    const onNextAgent = vi.fn();
    const onPrevAgent = vi.fn();
    await renderInput({ onNextAgent, onPrevAgent });

    act(() => {
      options().onAction({ verb: "nextTab" });
    });
    expect(onNextAgent).toHaveBeenCalledTimes(1);
    expect(onPrevAgent).not.toHaveBeenCalled();

    act(() => {
      options().onAction({ verb: "prevTab" });
    });
    expect(onPrevAgent).toHaveBeenCalledTimes(1);
    expect(onNextAgent).toHaveBeenCalledTimes(1);
  });

  it("stages stripped submit text and fires onVoiceSubmit once", async () => {
    const onVoiceSubmit = vi.fn();
    const onValueChange = vi.fn();
    const container = await renderInput({ onVoiceSubmit, onValueChange, value: "" });
    const input = container.querySelector("input");
    if (!input) {
      throw new Error("missing input");
    }

    act(() => {
      options().onSubmit("take the trash out");
    });

    // Staged synchronously into the live element so the bridge-path submit
    // reads it even before the React re-render flushes.
    expect(input.value).toBe("take the trash out");
    expect(onValueChange).toHaveBeenCalledWith("take the trash out");
    expect(onVoiceSubmit).toHaveBeenCalledExactlyOnceWith("take the trash out");
  });
});

describe("ParlayInput advisory countdown", () => {
  it("renders armTimer as a countdown and never submits locally", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchImpl);
    const container = await renderInput();

    act(() => {
      options().onAction({ verb: "armTimer", args: { timerId: "t-1", fireInMs: 1000 } });
    });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toMatch(/sending in \d+s…/iu);
    // Advisory only: no submission may leave this box for an armTimer.
    expect(fetchImpl).not.toHaveBeenCalledWith("/api/command-submit", expect.anything());
  });

  it("clears the countdown on cancelTimer", async () => {
    const container = await renderInput();

    act(() => {
      options().onAction({ verb: "armTimer", args: { timerId: "t-1", fireInMs: 1000 } });
    });
    expect(container.querySelector('[role="status"]')).not.toBeNull();

    act(() => {
      options().onAction({ verb: "cancelTimer", args: { timerId: "t-1" } });
    });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("ignores host-unknown verbs without wedging the input", async () => {
    const onNextAgent = vi.fn();
    const container = await renderInput({ onNextAgent });

    act(() => {
      options().onAction({ verb: "openChannelPicker", args: { channels: ["a"] } });
    });

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(onNextAgent).not.toHaveBeenCalled();
    expect(container.querySelector("input.term-native-input")).not.toBeNull();
  });
});

/**
 * Regression test for the blank page on Safari/iOS.
 *
 * The parlay server lives on a separate origin (port 4242) and this page's CSP
 * is `connect-src 'self' data:` plus `--allow-connect-origin` entries, so the
 * event stream can be blocked. Chrome reports that as an async `error` event,
 * but WebKit throws SecurityError out of the `EventSource` constructor (which
 * `parlay-input` opens inside its mount call). That throw used to escape the
 * effect, React tore down the whole tree, and the app rendered nothing at
 * all — a blocked optional voice sidecar took the terminal down with it.
 */
describe("ParlayInput when the event stream is blocked", () => {
  it("still renders when the wrapper mount throws", async () => {
    mountImpl = () => {
      // What WebKit raises for a CSP-blocked EventSource URL.
      throw new DOMException("The operation is insecure.", "SecurityError");
    };

    const container = await renderInput();

    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("degrades to a usable plain input rather than losing the tree", async () => {
    mountImpl = () => {
      throw new DOMException("The operation is insecure.", "SecurityError");
    };
    const onValueChange = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <ParlayInput
          value="hello"
          onValueChange={onValueChange}
          onVoiceSubmit={vi.fn()}
          disabled={false}
          expandingInput={false}
          enterNewline={false}
          controlsScalePercent={100}
          inputRef={vi.fn()}
        />,
      );
    });

    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    expect(input?.value).toBe("hello");
  });
});

describe("ParlayInput voice-submit toggle", () => {
  it("mounts with voiceEnabled:true by default (current behavior preserved)", async () => {
    await renderInput();
    expect(options().voiceEnabled).toBe(true);
  });

  it("skips the parlay-input mount entirely when the toggle is off", async () => {
    const container = await renderInput({ voiceSubmitEnabled: false });
    // No eval loop: the wrapper is never mounted, so no voice traffic exists.
    expect(capturedOptions).toBeNull();
    // The box stays a usable plain input.
    expect(container.querySelector("input.term-native-input")).not.toBeNull();
  });
});

/**
 * Local submit fallback (task-qj0k1 backstop): fires ONLY while the stream is
 * flagged down, stands down on recovery or when the server path wins first.
 */
describe("ParlayInput local submit fallback", () => {
  class FakeEventSource extends EventTarget {
    url: string | URL;
    constructor(url: string | URL) {
      super();
      this.url = url;
    }
    close() {}
  }
  let sources: FakeEventSource[];

  beforeEach(() => {
    sources = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.useFakeTimers();
    mountImpl = (_element, opts) => {
      const Ctor = (opts as { EventSource?: new (url: string | URL) => EventSource })
        .EventSource;
      if (Ctor) {
        // `new` on the tracked factory yields the listener-carrying instance.
        sources.push(new Ctor("http://host:4242/api/chat/events?device=d") as unknown as FakeEventSource);
      }
      return () => {};
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    mountImpl = null;
  });

  function arm(timerId: string, requireTail?: string) {
    act(() => {
      options().onAction({
        verb: "armTimer",
        args: { timerId, fireInMs: 1000, ...(requireTail ? { requireTail } : {}) },
      });
    });
  }

  it("fires locally on the ender tail while the stream is down", async () => {
    const onVoiceSubmit = vi.fn();
    await renderInput({ onVoiceSubmit, value: "take the trash out send it" });
    expect(sources).toHaveLength(1);
    // Drop the stream: error with no reopen.
    act(() => {
      sources[0]!.dispatchEvent(new Event("error"));
    });
    arm("t-1", "send it");
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000 + 500);
    });
    expect(onVoiceSubmit).toHaveBeenCalledExactlyOnceWith("take the trash out");
  });

  it("stands down while the stream is healthy", async () => {
    const onVoiceSubmit = vi.fn();
    await renderInput({ onVoiceSubmit, value: "take the trash out send it" });
    arm("t-1", "send it");
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000 + 500);
    });
    expect(onVoiceSubmit).not.toHaveBeenCalled();
  });

  it("stands down when the stream recovers before the deadline", async () => {
    const onVoiceSubmit = vi.fn();
    await renderInput({ onVoiceSubmit, value: "take the trash out send it" });
    act(() => {
      sources[0]!.dispatchEvent(new Event("error"));
    });
    arm("t-1", "send it");
    // Recover mid-hold: the server path owns the submit again.
    act(() => {
      sources[0]!.dispatchEvent(new Event("open"));
    });
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000 + 500);
    });
    expect(onVoiceSubmit).not.toHaveBeenCalled();
  });

  it("never double-submits when the server path wins first", async () => {
    const onVoiceSubmit = vi.fn();
    await renderInput({ onVoiceSubmit, value: "take the trash out send it" });
    act(() => {
      sources[0]!.dispatchEvent(new Event("error"));
    });
    arm("t-1", "send it");
    // A late submitNow for the same arming stages stripped text first: the
    // tail is gone, so the watchdog re-verify fails and it stands down.
    act(() => {
      options().onSubmit("take the trash out");
    });
    expect(onVoiceSubmit).toHaveBeenCalledExactlyOnceWith("take the trash out");
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000 + 500);
    });
    expect(onVoiceSubmit).toHaveBeenCalledTimes(1);
  });

  it("stands down when the tail is gone from the live buffer", async () => {
    const onVoiceSubmit = vi.fn();
    await renderInput({ onVoiceSubmit, value: "never mind, typing something else" });
    act(() => {
      sources[0]!.dispatchEvent(new Event("error"));
    });
    arm("t-1", "send it");
    await act(async () => {
      vi.advanceTimersByTime(1000 + 2000 + 500);
    });
    expect(onVoiceSubmit).not.toHaveBeenCalled();
  });
});

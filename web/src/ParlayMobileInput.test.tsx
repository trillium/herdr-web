/**
 * @vitest-environment jsdom
 *
 * Session/id coverage for the parlay voice box against the REAL `parlay-input`
 * wrapper: per-mount device isolation, stable per-box stream ids, and the
 * insecure-context mount that once crashed mobile Safari.
 *
 * `parlay-input` is a vendored `file:./vendor/parlay-input` dependency, so the
 * REAL wrapper resolves in every environment. The suite still skips if the
 * import rejects, mirroring the component's own guarded import.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const roots: Root[] = [];

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  listeners: Record<string, Array<(event: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    (this.listeners[type] ||= []).push(listener);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
}

let parlayAvailable = true;
try {
  await import("parlay-input");
} catch {
  parlayAvailable = false;
}

const realCrypto = globalThis.crypto;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plain HTTP on a non-localhost origin: no randomUUID, getRandomValues intact. */
function stubInsecureContextCrypto() {
  vi.stubGlobal("crypto", {
    randomUUID: undefined,
    getRandomValues: (bytes: Uint8Array) => realCrypto.getRandomValues(bytes),
  });
}

type EvalBody = {
  streamId: string;
  version: number;
  text: string;
  device: string;
  platform?: string;
};

let evalBodies: EvalBody[] = [];

function stubFetch() {
  evalBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/api/chat/eval")) {
        evalBodies.push(JSON.parse(init?.body ?? "{}") as EvalBody);
      }
      return new Response("{}", { headers: { "Content-Type": "application/json" } });
    }),
  );
}

function deviceIdsFromEventSources() {
  return FakeEventSource.instances.map(
    (instance) => new URL(instance.url).searchParams.get("device") ?? "",
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  stubFetch();
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

async function mountInput(boxId: string, value = "") {
  const { ParlayInput } = await import("./ParlayInput");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(
      <ParlayInput
        value={value}
        onValueChange={() => {}}
        onVoiceSubmit={() => {}}
        disabled={false}
        expandingInput={false}
        enterNewline={false}
        controlsScalePercent={100}
        boxId={boxId}
        inputRef={() => {}}
      />,
    );
  });
  return host;
}

async function typeInto(host: HTMLElement, text: string) {
  const input = host.querySelector("input");
  if (!input) {
    throw new Error("missing input");
  }
  await act(async () => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Default voice-settle debounce plus margin for the eval POST to land.
  await act(async () => {
    await sleep(600);
  });
}

describe.skipIf(!parlayAvailable)("ParlayMobileInput session ids", () => {
  it("mounts without crypto.randomUUID (insecure-context origins)", async () => {
    // Reproduces the mobile-mode crash: herdr-web served over plain HTTP to a
    // LAN / .local / Tailscale origin has no `crypto.randomUUID` (it is
    // secure-context only), so the unguarded call threw a TypeError during
    // render and React tore down the whole terminal tree with it.
    stubInsecureContextCrypto();

    const host = await mountInput("herdr-voice-box-pane-a");

    expect(host.querySelector("input.term-native-input")).not.toBeNull();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(deviceIdsFromEventSources()[0]).toMatch(/^herdr-web-mobile-.+/u);
  });

  it("mounts with no Web Crypto at all", async () => {
    vi.stubGlobal("crypto", undefined);

    const host = await mountInput("herdr-voice-box-pane-a");

    expect(host.querySelector("input.term-native-input")).not.toBeNull();
    expect(deviceIdsFromEventSources()[0]).toMatch(/^herdr-web-mobile-.+/u);
  });

  it("gives every mount a distinct device id when randomUUID is missing", async () => {
    // Two tabs must not share a device id, or one tab replays the other's
    // SSE-broadcast actions into its terminal.
    stubInsecureContextCrypto();

    await mountInput("herdr-voice-box-pane-a");
    await mountInput("herdr-voice-box-pane-b");

    const [first, second] = deviceIdsFromEventSources();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("keeps one streamId per box across remounts and tags evals herdr", async () => {
    // Per-box isolation is server-side by streamId: remounting the same pane's
    // box (submit, pane switch, expanding toggle) must not mint a new stream.
    const first = await mountInput("herdr-voice-box-pane-a");
    await typeInto(first, "take the trash out");

    await act(async () => {
      for (const root of roots.splice(0)) {
        root.unmount();
      }
    });

    const second = await mountInput("herdr-voice-box-pane-a");
    await typeInto(second, "take the trash out submit");

    expect(evalBodies.length).toBeGreaterThanOrEqual(2);
    for (const body of evalBodies) {
      expect(body.streamId).toBe("herdr-voice-box-pane-a");
      expect(body.platform).toBe("herdr");
    }
    // Fresh mount, fresh device: the two boxes never share an SSE identity.
    const [firstDevice, secondDevice] = deviceIdsFromEventSources();
    expect(firstDevice).toBeTruthy();
    expect(secondDevice).toBeTruthy();
    expect(firstDevice).not.toBe(secondDevice);
  });
});

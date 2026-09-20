/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";

import {
  ARM_TIMER_VERB,
  CANCEL_TIMER_VERB,
  isEnderCancel,
  parseEnderCountdown,
  postVoiceCommandSubmit,
  VOICE_ENDER_PLATFORM,
  VOICE_ENDER_SOURCE,
  withHerdrPlatform,
} from "./voiceEnder";

describe("parseEnderCountdown", () => {
  it("reads the advisory armTimer countdown", () => {
    expect(
      parseEnderCountdown({ verb: ARM_TIMER_VERB, args: { timerId: "t-1", fireInMs: 1000 } }),
    ).toEqual({ timerId: "t-1", fireInMs: 1000 });
  });

  it("ignores every other verb", () => {
    expect(parseEnderCountdown({ verb: CANCEL_TIMER_VERB })).toBeNull();
    expect(parseEnderCountdown({ verb: "submitNow", args: { requireTail: "submit" } })).toBeNull();
    expect(parseEnderCountdown({ verb: "noop" })).toBeNull();
  });

  it("falls back to the 1s verify hold for missing or bogus fireInMs", () => {
    expect(parseEnderCountdown({ verb: ARM_TIMER_VERB })).toEqual({ timerId: "", fireInMs: 1000 });
    expect(parseEnderCountdown({ verb: ARM_TIMER_VERB, args: { fireInMs: -5 } })).toEqual({
      timerId: "",
      fireInMs: 1000,
    });
    expect(parseEnderCountdown({ verb: ARM_TIMER_VERB, args: { fireInMs: NaN } })).toEqual({
      timerId: "",
      fireInMs: 1000,
    });
  });
});

describe("isEnderCancel", () => {
  it("matches cancelTimer only", () => {
    expect(isEnderCancel({ verb: CANCEL_TIMER_VERB })).toBe(true);
    expect(isEnderCancel({ verb: ARM_TIMER_VERB })).toBe(false);
    expect(isEnderCancel({ verb: "submitNow" })).toBe(false);
  });
});

describe("withHerdrPlatform", () => {
  function capture() {
    const calls: Array<{ url: string; body: string }> = [];
    const inner = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body ?? "" });
      return "ok";
    });
    return { calls, wrapped: withHerdrPlatform(inner), inner };
  }

  it("injects platform:'herdr' into eval POSTs, preserving every field", () => {
    const { calls } = capture();
    const evalBody = {
      streamId: "herdr-voice-box-pane-a",
      version: 3,
      text: "take the trash out submit",
      cursor: { anchor: 24, active: 24 },
      reason: "input",
      voiceEnabled: true,
      tabs: [],
      device: "herdr-web-mobile-xyz",
    };
    const wrapped = withHerdrPlatform(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, body: init?.body ?? "" });
      return "ok";
    });
    void wrapped("http://host:4242/api/chat/eval", {
      method: "POST",
      body: JSON.stringify(evalBody),
    });
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].body)).toEqual({ ...evalBody, platform: VOICE_ENDER_PLATFORM });
    expect(VOICE_ENDER_PLATFORM).toBe("herdr");
  });

  it("leaves non-eval traffic byte-identical", async () => {
    const { calls, wrapped, inner } = capture();
    await wrapped("http://host:4242/api/chat/send", { method: "POST", body: '{"text":"hi"}' });
    await wrapped("http://host:4242/api/chat/eval", { method: "GET" });
    await wrapped("http://host:4242/api/chat/eval", { method: "POST", body: "not-json" });
    expect(calls.map((call) => call.body)).toEqual(['{"text":"hi"}', "", "not-json"]);
    expect(inner).toHaveBeenCalledTimes(3);
  });
});

describe("postVoiceCommandSubmit", () => {
  function stubFetch(ok: boolean, status = 200) {
    const calls: Array<{ url: string; init: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init: unknown) => {
      calls.push({ url, init });
      return {
        ok,
        status,
        json: async () => ({ request_id: "req-1", pane_id: "pane-a", ts: 123 }),
      };
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("POSTs the bridge command-submit shape for the live pane", async () => {
    const { calls, fetchImpl } = stubFetch(true);
    const result = await postVoiceCommandSubmit(fetchImpl, {
      paneId: "pane-a",
      terminalId: "term-1",
      requestId: "req-1",
      source: VOICE_ENDER_SOURCE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/command-submit");
    const init = calls[0].init as { method: string; body: string };
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      pane_id: "pane-a",
      terminal_id: "term-1",
      request_id: "req-1",
      source: "parlay-ender",
    });
    expect(result).toEqual({ request_id: "req-1", pane_id: "pane-a", ts: 123 });
  });

  it("omits terminal_id when the pane has no terminal yet", async () => {
    const { calls, fetchImpl } = stubFetch(true);
    await postVoiceCommandSubmit(fetchImpl, {
      paneId: "pane-a",
      terminalId: null,
      requestId: "req-2",
      source: VOICE_ENDER_SOURCE,
    });
    expect(JSON.parse((calls[0].init as { body: string }).body)).toEqual({
      pane_id: "pane-a",
      request_id: "req-2",
      source: "parlay-ender",
    });
  });

  it("throws so the caller can leave the stripped text for a manual Send", async () => {
    const { fetchImpl } = stubFetch(false, 403);
    await expect(
      postVoiceCommandSubmit(fetchImpl, {
        paneId: "pane-a",
        terminalId: null,
        requestId: "req-3",
        source: VOICE_ENDER_SOURCE,
      }),
    ).rejects.toThrow("command-submit failed: 403");
  });
});

// Real-wrapper integration: drives the actual `parlay-input` protocol (REST
// up-channel + SSE down-channel) through the herdr fetch shim. Needs the
// gitignored `web/local-deps/parlay-input` symlink, so it skips exactly like
// the parlay session-id tests when the optional dep is absent.
let parlayInputReal: ((...args: never[]) => () => void) | null = null;
try {
  const mod = (await import("parlay-input")) as {
    parlayInput: (...args: never[]) => () => void;
  };
  parlayInputReal = mod.parlayInput;
} catch {
  parlayInputReal = null;
}

type EvalBody = {
  streamId: string;
  version: number;
  text: string;
  cursor: { anchor: number; active: number };
  reason: string;
  voiceEnabled: boolean;
  device: string;
  platform?: string;
};

function driveHarness(options?: {
  streamId?: string;
  onSubmit?: (text: string) => void;
  applies?: string[];
}) {
  if (!parlayInputReal) {
    throw new Error("parlay-input unavailable");
  }
  const el = document.createElement("input");
  document.body.append(el);
  const evalCalls: EvalBody[] = [];
  const submitted: string[] = [];
  let sseHandler: ((env: unknown) => void) | null = null;
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    if (String(url).endsWith("/api/chat/eval")) {
      evalCalls.push(JSON.parse(init?.body ?? "{}") as EvalBody);
    }
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const unsub = (
    parlayInputReal as (
      el: Element,
      opts: Record<string, unknown>,
    ) => () => void
  )(el, {
    server: "http://host:4242",
    settleMs: 5,
    device: "herdr-web-mobile-test",
    streamId: options?.streamId ?? "herdr-voice-box-test",
    voiceEnabled: true,
    fetch: withHerdrPlatform(fetchImpl),
    subscribe: (_event: string, handler: (env: unknown) => void) => {
      sseHandler = handler;
      return () => {
        sseHandler = null;
      };
    },
    onSubmit: (text: string) => {
      submitted.push(text);
      options?.onSubmit?.(text);
    },
    onApply: (result: string) => options?.applies?.push(result),
  });
  const push = (env: Record<string, unknown>) => {
    sseHandler?.({
      v: 1,
      streamId: "herdr-voice-box-test",
      seq: 0,
      baseVersion: 1_000_000,
      actions: [],
      ...env,
    });
  };
  const type = (text: string) => {
    el.value = text;
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const cleanup = () => {
    unsub();
    el.remove();
  };
  return { el, evalCalls, submitted, push, type, cleanup };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!parlayInputReal)("voice-ender up-channel payload", () => {
  it("POSTs one eval per box with streamId/version/text/cursor/platform", async () => {
    const h = driveHarness({ streamId: "herdr-voice-box-pane-a" });
    try {
      h.type("take the trash out");
      await sleep(30);
      expect(h.evalCalls).toHaveLength(1);
      const body = h.evalCalls[0];
      expect(body.streamId).toBe("herdr-voice-box-pane-a");
      expect(body.version).toBe(1);
      expect(body.text).toBe("take the trash out");
      expect(body.cursor).toEqual({ anchor: 18, active: 18 });
      expect(body.reason).toBe("input");
      expect(body.voiceEnabled).toBe(true);
      expect(body.platform).toBe("herdr");
      expect(body.device).toBe("herdr-web-mobile-test");

      h.type("take the trash out submit");
      await sleep(30);
      expect(h.evalCalls).toHaveLength(2);
      expect(h.evalCalls[1].version).toBe(2);
      expect(h.evalCalls[1].text).toBe("take the trash out submit");
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!parlayInputReal)("voice-ender submitNow tail re-verify", () => {
  it("strips the ender and submits when the tail is intact", async () => {
    const h = driveHarness({});
    try {
      h.type("take the trash out submit");
      await sleep(30);
      const baseVersion = h.evalCalls[h.evalCalls.length - 1].version;
      h.push({
        seq: 0,
        baseVersion,
        actions: [{ verb: "submitNow", args: { requireTail: "submit", text: "" } }],
      });
      expect(h.submitted).toEqual(["take the trash out"]);
    } finally {
      h.cleanup();
    }
  });

  it("never submits once the buffer moved past the tail", async () => {
    const h = driveHarness({});
    try {
      h.type("take the trash out submit");
      await sleep(30);
      const baseVersion = h.evalCalls[h.evalCalls.length - 1].version;
      // The tail moved on (more dictation after the ender): the async fire is
      // ~1 round-trip stale and must be rejected, not submitted.
      h.type("take the trash out submit plus more dictation");
      h.push({
        seq: 1,
        baseVersion,
        actions: [{ verb: "submitNow", args: { requireTail: "submit", text: "" } }],
      });
      expect(h.submitted).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!parlayInputReal)("voice-ender stale-envelope resync", () => {
  it("drops a stale mutating envelope and re-POSTs the live buffer", async () => {
    const applies: string[] = [];
    const h = driveHarness({ applies });
    try {
      h.type("first");
      await sleep(30);
      h.type("second");
      await sleep(30);
      const callsBefore = h.evalCalls.length;
      // An envelope computed against the older buffer version must not mutate
      // the box; the wrapper resyncs so the server recomputes on fresh text.
      h.push({
        seq: 9,
        baseVersion: h.evalCalls[0].version,
        actions: [{ verb: "setText", args: { text: "stale overwrite" } }],
      });
      expect(h.el.value).toBe("second");
      expect(applies).toContain("rejected-stale");
      expect(h.evalCalls.length).toBe(callsBefore + 1);
      expect(h.evalCalls[h.evalCalls.length - 1].text).toBe("second");
    } finally {
      h.cleanup();
    }
  });
});

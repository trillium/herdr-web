/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractEvalVerbs,
  formatEvalTrip,
  makeTrackedEventSource,
  observeEvalFetch,
  VoiceStreamHealth,
} from "./voiceStreamHealth";

describe("VoiceStreamHealth", () => {
  it("starts up and flips only on real transitions", () => {
    const health = new VoiceStreamHealth();
    expect(health.isDown()).toBe(false);
    expect(health.recordSseError()).toBe(true);
    expect(health.isDown()).toBe(true);
    expect(health.recordSseError()).toBe(false);
    expect(health.recordSseMessage()).toBe(true);
    expect(health.isDown()).toBe(false);
    expect(health.recordSseOpen()).toBe(false);
    expect(health.recordEvalFail()).toBe(true);
    expect(health.recordEvalOk()).toBe(true);
    expect(health.isDown()).toBe(false);
  });
});

class FakeEventSource extends EventTarget {
  url: string | URL;
  readyState = 0;
  constructor(url: string | URL) {
    super();
    this.url = url;
  }
  close() {}
}

describe("makeTrackedEventSource", () => {
  it("flips health on open/error and passes through undefined", () => {
    const health = new VoiceStreamHealth();
    const hooks = { onOpen: vi.fn(), onError: vi.fn(), onMessage: vi.fn() };
    const Tracked = makeTrackedEventSource(
      FakeEventSource as unknown as new (url: string | URL) => EventSource,
      health,
      hooks,
    );
    expect(Tracked).toBeDefined();
    const source = new Tracked!("http://x:4242/api/chat/events?device=d");
    expect((source as unknown as FakeEventSource).url).toBe(
      "http://x:4242/api/chat/events?device=d",
    );
    (source as unknown as FakeEventSource).readyState = 2;
    source.dispatchEvent(new Event("error"));
    expect(health.isDown()).toBe(true);
    expect(hooks.onError).toHaveBeenCalledTimes(1);
    // The drop reason (EventSource readyState) rides along for the log.
    expect(hooks.onError).toHaveBeenCalledWith(2);
    source.dispatchEvent(new Event("input_action"));
    expect(health.isDown()).toBe(false);
    expect(hooks.onMessage).toHaveBeenCalledTimes(1);
    source.dispatchEvent(new Event("open"));
    expect(hooks.onOpen).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when there is no EventSource", () => {
    expect(
      makeTrackedEventSource(undefined, new VoiceStreamHealth()),
    ).toBeUndefined();
  });
});

describe("observeEvalFetch", () => {
  it("reports eval POST outcomes and passes other traffic through", async () => {
    const ok = new Response("{}", { status: 200 });
    const fail = new Response("{}", { status: 403 });
    type EvalFetch = (url: string, init?: { method?: string; body?: string }) => Promise<Response>;
    const fetchImpl = vi.fn<EvalFetch>();
    fetchImpl
      .mockResolvedValueOnce(ok)
      .mockResolvedValueOnce(fail)
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const hooks = { onEvalOk: vi.fn(), onEvalFail: vi.fn() };
    const wrapped = observeEvalFetch(fetchImpl, hooks);

    const seen = await wrapped("http://h:4242/api/chat/eval", { method: "POST", body: "{}" });
    expect(seen).toBe(ok);
    expect(hooks.onEvalOk).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ status: "200", verbs: [] }),
    );
    await wrapped("http://h:4242/api/chat/eval", { method: "POST", body: "{}" });
    expect(hooks.onEvalFail).toHaveBeenCalledWith(
      "403",
      expect.objectContaining({ status: "403" }),
    );
    // Non-eval traffic is untouched and unobserved.
    await wrapped("http://h:4242/api/chat/send", { method: "POST", body: "{}" });
    expect(hooks.onEvalOk).toHaveBeenCalledTimes(1);
    expect(hooks.onEvalFail).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports network throws as failures and rethrows", async () => {
    type EvalFetch = (
      url: string,
      init?: { method?: string; body?: string },
    ) => Promise<Response>;
    const fetchImpl = vi.fn<EvalFetch>(async () => {
      throw new TypeError("blocked");
    });
    const hooks = { onEvalOk: vi.fn(), onEvalFail: vi.fn() };
    const wrapped = observeEvalFetch(fetchImpl, hooks);
    await expect(
      wrapped("http://h:4242/api/chat/eval", { method: "POST", body: "{}" }),
    ).rejects.toThrow("blocked");
    expect(hooks.onEvalFail).toHaveBeenCalledWith(
      "network",
      expect.objectContaining({ status: "network", verbs: [] }),
    );
  });

  it("reports latency and answered verbs per round trip", async () => {
    const body = JSON.stringify({ actions: [{ verb: "submitNow" }, { verb: "armTimer" }] });
    type EvalFetch = (
      url: string,
      init?: { method?: string; body?: string },
    ) => Promise<Response>;
    const fetchImpl = vi.fn<EvalFetch>(async () => new Response(body, { status: 200 }));
    const hooks = { onEvalOk: vi.fn(), onEvalFail: vi.fn() };
    const wrapped = observeEvalFetch(fetchImpl, hooks);
    const seen = await wrapped("http://h:4242/api/chat/eval", {
      method: "POST",
      body: "{}",
    });
    // The original response is untouched and still readable.
    expect(await seen.json()).toEqual({
      actions: [{ verb: "submitNow" }, { verb: "armTimer" }],
    });
    expect(hooks.onEvalOk).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ status: "200", verbs: ["submitNow", "armTimer"] }),
    );
    const trip = (hooks.onEvalOk.mock.calls[0] as unknown as [number, { latencyMs: number }])[1];
    expect(trip.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("stream autopsy", () => {
  it("reports readyState, time-to-drop, and messages between drops", () => {
    let now = 1_000_000;
    const health = new VoiceStreamHealth(() => now);
    health.recordSseOpen();
    now += 5_000;
    health.recordSseMessage();
    health.recordSseMessage();
    now += 500;
    const autopsy = health.autopsyOnDrop(2);
    expect(autopsy).toBe("rs=2 age=5500ms msgs=2 err=error-event");
    expect(autopsy).toMatch(/^[ -~]*$/u);
  });

  it("reports downtime since the last drop on reopen", () => {
    let now = 1_000_000;
    const health = new VoiceStreamHealth(() => now);
    expect(health.downtimeMs()).toBe(0);
    health.recordSseError();
    now += 3_000;
    expect(health.downtimeMs()).toBe(3000);
  });
});

describe("extractEvalVerbs / formatEvalTrip", () => {
  it("pulls verbs from actions arrays and top-level verbs", () => {
    expect(extractEvalVerbs({ actions: [{ verb: "submitNow" }] })).toEqual(["submitNow"]);
    expect(extractEvalVerbs({ verb: "armTimer" })).toEqual(["armTimer"]);
    expect(extractEvalVerbs({})).toEqual([]);
    expect(extractEvalVerbs(null)).toEqual([]);
    expect(extractEvalVerbs({ actions: "nope" })).toEqual([]);
  });

  it("rejects verb-shaped injections and caps the count", () => {
    expect(extractEvalVerbs({ actions: [{ verb: "do evil();" }] })).toEqual([]);
    expect(
      extractEvalVerbs({
        actions: [{ verb: "a" }, { verb: "b" }, { verb: "c" }, { verb: "d" }],
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("formats one printable round-trip line", () => {
    const line = formatEvalTrip({ status: "200", latencyMs: 42.7, verbs: ["submitNow"] });
    expect(line).toBe("status=200 latency=43ms verbs=submitNow");
    expect(formatEvalTrip({ status: "network", latencyMs: 5, verbs: [] })).toContain(
      "verbs=none",
    );
  });
});

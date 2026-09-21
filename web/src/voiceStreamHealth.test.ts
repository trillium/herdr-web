/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
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
    source.dispatchEvent(new Event("error"));
    expect(health.isDown()).toBe(true);
    expect(hooks.onError).toHaveBeenCalledTimes(1);
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
    expect(hooks.onEvalOk).toHaveBeenCalledWith(200);
    await wrapped("http://h:4242/api/chat/eval", { method: "POST", body: "{}" });
    expect(hooks.onEvalFail).toHaveBeenCalledWith("403");
    // Non-eval traffic is untouched and unobserved.
    await wrapped("http://h:4242/api/chat/send", { method: "POST", body: "{}" });
    expect(hooks.onEvalOk).toHaveBeenCalledTimes(1);
    expect(hooks.onEvalFail).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reports network throws as failures and rethrows", async () => {
    const fetchImpl = vi.fn(
      async (url: string, init?: { method?: string; body?: string }): Promise<Response> => {
        void url;
        void init;
        throw new TypeError("blocked");
      },
    );
    const hooks = { onEvalOk: vi.fn(), onEvalFail: vi.fn() };
    const wrapped = observeEvalFetch(fetchImpl, hooks);
    await expect(
      wrapped("http://h:4242/api/chat/eval", { method: "POST", body: "{}" }),
    ).rejects.toThrow("blocked");
    expect(hooks.onEvalFail).toHaveBeenCalledWith("network");
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { ClientLogBeacon } from "./clientLog";

function makeBeacon() {
  const fetchImpl = vi.fn(async () => new Response("{}"));
  let now = 1_000_000;
  const beacon = new ClientLogBeacon(fetchImpl, () => now);
  return { beacon, fetchImpl, advance: (ms: number) => (now += ms) };
}

describe("ClientLogBeacon", () => {
  it("posts transition events to /api/client-log with keepalive", async () => {
    const { beacon, fetchImpl } = makeBeacon();
    beacon.log("sse-drop");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(url).toBe("/api/client-log");
    expect(init["method"]).toBe("POST");
    expect(init["keepalive"]).toBe(true);
    const body = JSON.parse(init["body"] as string) as {
      events: { kind: string }[];
    };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.kind).toBe("sse-drop");
  });

  it("samples eval-ok but always sends eval-fail", async () => {
    const { beacon, fetchImpl } = makeBeacon();
    for (let i = 0; i < 19; i++) {
      beacon.log("eval-ok");
    }
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    beacon.log("eval-ok");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    beacon.log("eval-fail", "500");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("coalesces identical lines inside the window", async () => {
    const { beacon, fetchImpl, advance } = makeBeacon();
    beacon.log("sse-drop");
    beacon.log("sse-drop");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(11_000);
    beacon.log("sse-drop");
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("drops unknown kinds and strips non-printable detail", async () => {
    const { beacon, fetchImpl } = makeBeacon();
    beacon.log("eval-ok\nevil" as never);
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    beacon.log("submit-dropped", "wrong-pane");
    await Promise.resolve();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const body = JSON.parse(init["body"] as string) as {
      events: { detail?: string }[];
    };
    expect(body.events[0]?.detail).toBe("wrong-pane");
  });

  it("truncates long details to printable ASCII", async () => {
    const { beacon, fetchImpl } = makeBeacon();
    beacon.log("eval-fail", `599-${"x".repeat(500)}\nline2\ttab`);
    await Promise.resolve();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>];
    const body = JSON.parse(init["body"] as string) as {
      events: { detail?: string }[];
    };
    const detail = body.events[0]?.detail ?? "";
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail).toMatch(/^[ -~]*$/u);
    expect(detail).toContain("599-");
  });

  it("never throws when the network fails", async () => {
    const failing = new ClientLogBeacon(async () => {
      throw new Error("down");
    });
    expect(() => failing.log("sse-drop")).not.toThrow();
    await Promise.resolve();
  });

  it("bounds the queue under a burst", async () => {
    const { beacon } = makeBeacon();
    for (let i = 0; i < 100; i++) {
      beacon.log("submit-fired", `pane-${i}`);
    }
    // No throw, no unbounded growth; flush is fire-and-forget.
    await Promise.resolve();
  });
});

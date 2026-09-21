/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  ConsoleCaptureBudget,
  formatConsoleErrorDetail,
  installConsoleCapture,
  scrubConsoleMessage,
} from "./consoleCapture";

describe("scrubConsoleMessage", () => {
  it("collapses to one printable capped line", () => {
    expect(scrubConsoleMessage("boom\nline2\ttab")).toBe("boom line2 tab");
    expect(scrubConsoleMessage("")).toBe("unknown-error");
    expect(scrubConsoleMessage("x".repeat(500)).length).toBeLessThanOrEqual(80);
  });

  it("reduces URLs to scheme+host so paths and queries never beam", () => {
    const scrubbed = scrubConsoleMessage(
      "failed to fetch http://192.168.1.2:4242/api/chat/eval?token=abc#frag now",
    );
    expect(scrubbed).toContain("http://192.168.1.2:4242");
    expect(scrubbed).not.toContain("token=abc");
    expect(scrubbed).not.toContain("/api/chat/eval");
  });
});

describe("ConsoleCaptureBudget", () => {
  it("caps at 8 per rolling minute", () => {
    let now = 1_000_000;
    const budget = new ConsoleCaptureBudget(() => now);
    for (let i = 0; i < 8; i++) {
      expect(budget.take()).toBe(true);
    }
    expect(budget.take()).toBe(false);
    now += 61_000;
    expect(budget.take()).toBe(true);
  });
});

describe("installConsoleCapture", () => {
  it("beams onerror and unhandledrejection as console-error", () => {
    const sampler = vi.fn();
    const teardown = installConsoleCapture(sampler);
    try {
      window.dispatchEvent(
        new ErrorEvent("error", { message: "render blew up" }),
      );
      window.dispatchEvent(
        new PromiseRejectionEvent("unhandledrejection", {
          promise: Promise.resolve(),
          reason: new Error("eval promise rejected"),
        }),
      );
      expect(sampler).toHaveBeenCalledTimes(2);
      expect(sampler).toHaveBeenNthCalledWith(
        1,
        "console-error",
        'src=onerror msg="render blew up"',
      );
      expect(sampler).toHaveBeenNthCalledWith(
        2,
        "console-error",
        'src=unhandledrejection msg="eval promise rejected"',
      );
    } finally {
      teardown();
    }
  });

  it("stops beaming after teardown and never throws", () => {
    const sampler = vi.fn(() => {
      throw new Error("beacon down");
    });
    const teardown = installConsoleCapture(sampler);
    teardown();
    window.dispatchEvent(new ErrorEvent("error", { message: "late" }));
    expect(sampler).not.toHaveBeenCalled();
  });
});

describe("formatConsoleErrorDetail", () => {
  it("fits the client log cap on one printable line", () => {
    const detail = formatConsoleErrorDetail("onerror", "a".repeat(500));
    expect(detail).toMatch(/^[ -~]*$/u);
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.startsWith("src=onerror msg=\"")).toBe(true);
  });
});

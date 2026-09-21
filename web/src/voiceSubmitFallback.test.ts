/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
  formatEnderMatchDetail,
  matchFallbackTail,
  stripRequiredTail,
  VOICE_FALLBACK_ENDER_PHRASES,
} from "./voiceSubmitFallback";

describe("stripRequiredTail (server-armed tail)", () => {
  it("strips a trailing tail case-insensitively", () => {
    expect(stripRequiredTail("take the trash out SEND IT", "send it")).toBe(
      "take the trash out",
    );
  });

  it("allows trailing punctuation after the tail", () => {
    expect(stripRequiredTail("take the trash out submit.", "submit")).toBe(
      "take the trash out",
    );
  });

  it("tolerates dictation spacing/case/punctuation inside the tail", () => {
    // Doubled spaces from pause-separated dictation.
    expect(stripRequiredTail("take the trash out send  it", "send it")).toBe(
      "take the trash out",
    );
    // Comma-glued words and shouting case (the comma is consumed as the
    // separator, so the remainder stays clean).
    expect(stripRequiredTail("take the trash out,send it", "send it")).toBe(
      "take the trash out",
    );
    expect(stripRequiredTail("take the trash out SEND IT", "send it")).toBe(
      "take the trash out",
    );
    // Hyphenated dictation and a punctuated multi-word tail.
    expect(stripRequiredTail("take the trash out send-it", "send it")).toBe(
      "take the trash out",
    );
    expect(stripRequiredTail("please submit... that??", "submit that")).toBe(
      "please",
    );
    // The tail side normalizes the same way as the buffer side.
    expect(stripRequiredTail("take the trash out send it", "Send,  it")).toBe(
      "take the trash out",
    );
  });

  it("still rejects word-internal matches and mid-buffer tails", () => {
    expect(stripRequiredTail("please resubmit", "submit")).toBeNull();
    expect(stripRequiredTail("the submitter", "submit")).toBeNull();
    expect(stripRequiredTail("submit thatch", "submit that")).toBeNull();
  });

  it("rejects when text continues after the tail (stale buffer)", () => {
    expect(stripRequiredTail("submit the report tomorrow", "submit")).toBeNull();
  });

  it("rejects an absent tail and an empty remainder", () => {
    expect(stripRequiredTail("hello there", "submit")).toBeNull();
    expect(stripRequiredTail("submit", "submit")).toBeNull();
  });
});

describe("matchFallbackTail (phrase backstop)", () => {
  it("lists the documented ender phrases longest-first", () => {
    expect([...VOICE_FALLBACK_ENDER_PHRASES]).toEqual([
      "submit that",
      "send it",
      "submit",
    ]);
  });

  it("prefers the server tail when one is armed", () => {
    expect(matchFallbackTail("take the trash out send it", "send it")).toBe(
      "take the trash out",
    );
  });

  it("matches documented phrases with word boundaries", () => {
    expect(matchFallbackTail("take the trash out, send it")).toBe("take the trash out,");
    expect(matchFallbackTail("please submit that")).toBe("please");
    expect(matchFallbackTail("please SUBMIT")).toBe("please");
    // No boundary: "submit" inside a longer word must not fire.
    expect(matchFallbackTail("resubmit")).toBeNull();
    expect(matchFallbackTail("hello there")).toBeNull();
  });

  it("tolerates dictation realities in the phrase backstop", () => {
    expect(matchFallbackTail("take the trash out  SEND  IT")).toBe(
      "take the trash out",
    );
    expect(matchFallbackTail("take the trash out,send-it!")).toBe(
      "take the trash out",
    );
    expect(matchFallbackTail("please submit... that.")).toBe("please");
    expect(matchFallbackTail("go. Submit")).toBe("go.");
  });

  it("requires a non-empty remainder", () => {
    expect(matchFallbackTail("submit")).toBeNull();
  });
});

describe("formatEnderMatchDetail (flight-recorder trace)", () => {
  it("traces tail, remainder, and verdict on one printable line", () => {
    const detail = formatEnderMatchDetail({
      source: "requireTail",
      tail: "send it",
      remainder: "take the trash out",
      verdict: "verified",
    });
    expect(detail).toBe(
      'src=requireTail tail="send it" remainder="take the trash out" verdict=verified',
    );
    expect(detail).toMatch(/^[ -~]*$/u);
    expect(detail.length).toBeLessThanOrEqual(120);
  });

  it("marks a missing remainder stale with a dash", () => {
    const detail = formatEnderMatchDetail({
      source: "phrase",
      tail: "submit",
      remainder: null,
      verdict: "stale",
    });
    expect(detail).toContain('remainder="-"');
    expect(detail).toContain("verdict=stale");
  });

  it("truncates long previews to the tail and strips quotes", () => {
    const detail = formatEnderMatchDetail({
      source: "server",
      tail: `please "run" it ${"x".repeat(200)}`,
      remainder: `do the thing\nwith newline ${"y".repeat(200)}`,
      verdict: "verified",
    });
    expect(detail).not.toContain('"run"');
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual(120);
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
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

  it("requires a non-empty remainder", () => {
    expect(matchFallbackTail("submit")).toBeNull();
  });
});

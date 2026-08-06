import { describe, expect, it } from "vitest";
import {
  matchTrailingVoicePinPhrase,
  matchTrailingVoiceSubmitPhrase,
  matchTrailingVoiceThemePhrase,
  stripVoiceSubmitPhrase,
} from "./voiceSubmitPhrase";

describe("matchTrailingVoiceSubmitPhrase", () => {
  it("matches a trailing submit phrase case-insensitively", () => {
    expect(matchTrailingVoiceSubmitPhrase("run the tests bravely")).toBe("bravely");
    expect(matchTrailingVoiceSubmitPhrase("run the tests Bravely")).toBe("Bravely");
    expect(matchTrailingVoiceSubmitPhrase("git status LAP")).toBe("LAP");
  });

  it("tolerates trailing punctuation from dictation", () => {
    expect(matchTrailingVoiceSubmitPhrase("run the tests, bravely.")).toBe("bravely");
    expect(matchTrailingVoiceSubmitPhrase("git status lap!")).toBe("lap");
  });

  it("does not match a phrase that isn't trailing", () => {
    expect(matchTrailingVoiceSubmitPhrase("bravely run the tests")).toBeNull();
  });

  it("does not match a phrase embedded in a larger word", () => {
    expect(matchTrailingVoiceSubmitPhrase("do a lap around the block")).toBeNull();
    expect(matchTrailingVoiceSubmitPhrase("run overlap")).toBeNull();
  });

  it("returns null when there is no submit phrase", () => {
    expect(matchTrailingVoiceSubmitPhrase("just some text")).toBeNull();
    expect(matchTrailingVoiceSubmitPhrase("")).toBeNull();
  });
});

describe("matchTrailingVoicePinPhrase", () => {
  it("matches 'pin next' and its aliases", () => {
    expect(matchTrailingVoicePinPhrase("pin next")).toEqual({ direction: "next", tail: "pin next" });
    expect(matchTrailingVoicePinPhrase("okay one")).toEqual({ direction: "next", tail: "one" });
    expect(matchTrailingVoicePinPhrase("pan next")).toEqual({ direction: "next", tail: "pan next" });
    expect(matchTrailingVoicePinPhrase("pam next")).toEqual({ direction: "next", tail: "pam next" });
    expect(matchTrailingVoicePinPhrase("in next")).toEqual({ direction: "next", tail: "in next" });
  });

  it("matches 'pin previous'/'pin prev' and its aliases", () => {
    expect(matchTrailingVoicePinPhrase("pin previous")).toEqual({
      direction: "prev",
      tail: "pin previous",
    });
    expect(matchTrailingVoicePinPhrase("pin prev")).toEqual({ direction: "prev", tail: "pin prev" });
    expect(matchTrailingVoicePinPhrase("pan previous")).toEqual({
      direction: "prev",
      tail: "pan previous",
    });
    expect(matchTrailingVoicePinPhrase("pan prev")).toEqual({ direction: "prev", tail: "pan prev" });
    expect(matchTrailingVoicePinPhrase("pin past")).toEqual({ direction: "prev", tail: "pin past" });
    expect(matchTrailingVoicePinPhrase("pan past")).toEqual({ direction: "prev", tail: "pan past" });
  });

  it("does not match 'one' embedded in a larger word or not trailing", () => {
    expect(matchTrailingVoicePinPhrase("someone")).toBeNull();
    expect(matchTrailingVoicePinPhrase("one more thing")).toBeNull();
  });

  it("matches bare 'next' only when it's the entire buffer", () => {
    expect(matchTrailingVoicePinPhrase("next")).toEqual({ direction: "next", tail: "next" });
    expect(matchTrailingVoicePinPhrase("Next!")).toEqual({ direction: "next", tail: "Next" });
    expect(matchTrailingVoicePinPhrase("  next  ")).toEqual({ direction: "next", tail: "next" });
  });

  it("does not match 'next' trailing inside an ordinary command", () => {
    expect(matchTrailingVoicePinPhrase("run the next test")).toBeNull();
    expect(matchTrailingVoicePinPhrase("skip to the next")).toBeNull();
  });
});

describe("matchTrailingVoiceThemePhrase", () => {
  it("matches 'light mode' and its aliases", () => {
    expect(matchTrailingVoiceThemePhrase("light mode")).toEqual({
      theme: "light",
      tail: "light mode",
    });
    expect(matchTrailingVoiceThemePhrase("toggle light mode")).toEqual({
      theme: "light",
      tail: "toggle light mode",
    });
    expect(matchTrailingVoiceThemePhrase("light mode toggle")).toEqual({
      theme: "light",
      tail: "light mode toggle",
    });
  });

  it("matches 'dark mode' and its aliases", () => {
    expect(matchTrailingVoiceThemePhrase("dark mode")).toEqual({
      theme: "dark",
      tail: "dark mode",
    });
    expect(matchTrailingVoiceThemePhrase("toggle dark mode")).toEqual({
      theme: "dark",
      tail: "toggle dark mode",
    });
    expect(matchTrailingVoiceThemePhrase("dark mode toggle")).toEqual({
      theme: "dark",
      tail: "dark mode toggle",
    });
  });

  it("returns null when there is no theme phrase", () => {
    expect(matchTrailingVoiceThemePhrase("just some text")).toBeNull();
    expect(matchTrailingVoiceThemePhrase("")).toBeNull();
  });
});

describe("stripVoiceSubmitPhrase", () => {
  it("strips the matched phrase and surrounding whitespace", () => {
    expect(stripVoiceSubmitPhrase("run the tests bravely", "bravely")).toBe("run the tests");
    expect(stripVoiceSubmitPhrase("git status lap!", "lap")).toBe("git status");
  });

  it("returns null when the buffer changed since the phrase was matched", () => {
    expect(stripVoiceSubmitPhrase("run the tests bravely more text", "bravely")).toBeNull();
  });

  it("returns null when stripping the phrase leaves nothing to send", () => {
    expect(stripVoiceSubmitPhrase("bravely", "bravely")).toBeNull();
    expect(stripVoiceSubmitPhrase("  bravely  ", "bravely")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  COMPOSER_PIECE_UNITS,
  planComposerDelivery,
  splitComposerText,
  shouldBracketPaste,
  utf8ByteLength,
  wrapBracketedPaste,
} from "./terminalPaste";

const longMessage = (bytes: number) => {
  const parts: string[] = [];
  let size = 0;
  for (let line = 0; size < bytes; line += 1) {
    const chunk = `line ${line}: héllo wörld — naïve façade ✓ 日本語のテスト 🚀 emoji\n\tindented → arrow\n`;
    parts.push(chunk);
    size += utf8ByteLength(chunk);
  }
  return parts.join("");
};

describe("shouldBracketPaste", () => {
  it("wraps multi-line or large text only when the pane enabled bracketed paste", () => {
    expect(shouldBracketPaste("one\ntwo", true)).toBe(true);
    expect(shouldBracketPaste("x".repeat(2048), true)).toBe(true);
    expect(shouldBracketPaste("ls -la", true)).toBe(false);
    expect(shouldBracketPaste("one\ntwo", false)).toBe(false);
    expect(shouldBracketPaste("", true)).toBe(false);
  });
});

describe("wrapBracketedPaste", () => {
  it("wraps the text and strips an embedded end marker so it cannot close the paste early", () => {
    const wrapped = wrapBracketedPaste(`a${BRACKETED_PASTE_END}b`);
    expect(wrapped).toBe(`${BRACKETED_PASTE_START}ab${BRACKETED_PASTE_END}`);
  });
});

describe("planComposerDelivery", () => {
  it("sends a large multi-line non-ASCII message whole, as one paste, with Enter outside it", () => {
    const text = longMessage(256 * 1024);
    const plan = planComposerDelivery(text, ["\r"], true);
    expect(plan.warning).toBeNull();
    expect(plan.parts).toEqual([`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`, "\r"]);
  });

  it("leaves short text raw so shells and simple prompts behave as before", () => {
    expect(planComposerDelivery("ls", ["\r"], true).parts).toEqual(["ls", "\r"]);
  });

  it("warns when a large message goes to a pane without bracketed paste", () => {
    const plan = planComposerDelivery("x".repeat(8192), ["\r"], false);
    expect(plan.parts).toEqual(["x".repeat(8192), "\r"]);
    expect(plan.warning).toMatch(/8\.0 KB.*not in bracketed-paste mode/);
  });

  it("never refuses by size: an enormous message becomes ordered pastes that rejoin byte for byte", () => {
    const text = longMessage(9 * 1024 * 1024);
    const plan = planComposerDelivery(text, ["\r"], true);
    expect(plan.warning).toBeNull();
    expect(plan.parts.length).toBeGreaterThan(3);
    expect(plan.parts.at(-1)).toBe("\r");
    const pieces = plan.parts.slice(0, -1);
    for (const piece of pieces) {
      expect(piece.startsWith(BRACKETED_PASTE_START)).toBe(true);
      expect(piece.endsWith(BRACKETED_PASTE_END)).toBe(true);
      expect(utf8ByteLength(piece)).toBeLessThan(1024 * 1024);
    }
    const rejoined = pieces
      .map((piece) => piece.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length))
      .join("");
    expect(rejoined === text).toBe(true);
  });

  it("splits raw text for a pane without bracketed paste the same way", () => {
    const text = "x".repeat(COMPOSER_PIECE_UNITS * 2 + 5);
    const plan = planComposerDelivery(text, [], false);
    expect(plan.parts.map((part) => part.length)).toEqual([
      COMPOSER_PIECE_UNITS,
      COMPOSER_PIECE_UNITS,
      5,
    ]);
    expect(plan.parts.join("")).toBe(text);
  });

  it("keeps a multi-thousand-character dictated message in a single paste", () => {
    const text = "so what I was thinking is that we could actually use the porter agent ".repeat(120);
    const plan = planComposerDelivery(text, ["\r"], true);
    expect(plan.parts).toEqual([`${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`, "\r"]);
  });
});

describe("splitComposerText", () => {
  it("never tears a surrogate pair between pieces", () => {
    const text = "a" + "🚀".repeat(10);
    for (let units = 2; units <= 7; units += 1) {
      const pieces = splitComposerText(text, units);
      expect(pieces.join("")).toBe(text);
      for (const piece of pieces) {
        const first = piece.charCodeAt(0);
        const last = piece.charCodeAt(piece.length - 1);
        expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
    }
  });

  it("returns nothing for empty text", () => {
    expect(splitComposerText("")).toEqual([]);
  });
});

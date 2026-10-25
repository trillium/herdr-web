import { describe, expect, it } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  MAX_TERMINAL_INPUT_BYTES,
  planComposerDelivery,
  shouldBracketPaste,
  utf8ByteLength,
  wrapBracketedPaste,
} from "./terminalPaste";

const longMessage = (bytes: number) => {
  let out = "";
  for (let line = 0; utf8ByteLength(out) < bytes; line += 1) {
    out += `line ${line}: héllo wörld — naïve façade ✓ 日本語のテスト 🚀 emoji\n\tindented → arrow\n`;
  }
  return out;
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
    expect(plan.error).toBeNull();
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

  it("refuses a message over the bridge limit and says so, without producing parts", () => {
    const plan = planComposerDelivery("x".repeat(MAX_TERMINAL_INPUT_BYTES + 1), ["\r"], true);
    expect(plan.parts).toEqual([]);
    expect(plan.error).toMatch(/8\.0 MB.*at most 8\.0 MB.*Nothing was sent/);
  });

  it("accepts exactly the limit", () => {
    const plan = planComposerDelivery("x".repeat(MAX_TERMINAL_INPUT_BYTES - 1), ["\r"], false);
    expect(plan.error).toBeNull();
  });
});

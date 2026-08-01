import { describe, expect, it } from "vitest";
import { agentIconKindFromHint, agentIconKindFromValues } from "./AgentIcon";

describe("agentIconKindFromValues", () => {
  it("matches known agent labels", () => {
    expect(agentIconKindFromValues(["claude"])).toBe("claude");
    expect(agentIconKindFromValues(["codex"])).toBe("codex");
    expect(agentIconKindFromValues(["pi"])).toBe("pi");
    expect(agentIconKindFromValues(["grok"])).toBe("grok");
    expect(agentIconKindFromValues(["opencode"])).toBe("opencode");
    expect(agentIconKindFromValues(["open-code"])).toBe("opencode");
  });

  it("matches grok in compound labels without a separate grok-build kind", () => {
    expect(agentIconKindFromValues(["grok-build"])).toBe("grok");
  });

  it("prefers structured fields earlier in the list", () => {
    expect(agentIconKindFromValues(["codex", "claude session"])).toBe("codex");
  });

  it("returns null for unknown labels", () => {
    expect(agentIconKindFromValues([null, undefined, "", "shell"])).toBeNull();
  });
});

describe("agentIconKindFromHint", () => {
  it("maps launcher agent hints", () => {
    expect(agentIconKindFromHint("claude")).toBe("claude");
    expect(agentIconKindFromHint("codex")).toBe("codex");
    expect(agentIconKindFromHint("pi")).toBe("pi");
    expect(agentIconKindFromHint("grok")).toBe("grok");
    expect(agentIconKindFromHint("grok-build")).toBe("grok");
    expect(agentIconKindFromHint("opencode")).toBe("opencode");
    expect(agentIconKindFromHint("open-code")).toBe("opencode");
    expect(agentIconKindFromHint("claude-code")).toBe("claude");
  });

  it("ignores unknown or empty hints", () => {
    expect(agentIconKindFromHint(null)).toBeNull();
    expect(agentIconKindFromHint("")).toBeNull();
    expect(agentIconKindFromHint("unknown")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { resolveFaviconTint, tintLogoSvg } from "./faviconTint";

describe("resolveFaviconTint", () => {
  it("maps machine hostnames by first label", () => {
    expect(resolveFaviconTint("mini0.hippo-tilapia.ts.net", "")).toBe("#7bd88f");
    expect(resolveFaviconTint("MINI1", "")).toBe("#7fb2ff");
  });

  it("leaves other hosts standard", () => {
    expect(resolveFaviconTint("macbook.local", "")).toBeNull();
    expect(resolveFaviconTint("localhost", "")).toBeNull();
    expect(resolveFaviconTint("constructor", "")).toBeNull();
  });

  it("lets ?tint override and strips quotes", () => {
    expect(resolveFaviconTint("macbook", "?tint=red")).toBe("red");
    expect(resolveFaviconTint("mini0", "?tint=%23ff0000")).toBe("#ff0000");
    expect(resolveFaviconTint("macbook", '?tint=red"onload=x')).toBe("redonload=x");
  });
});

describe("tintLogoSvg", () => {
  it("replaces only the background fill", () => {
    const svg = '<rect fill="#d9dad8"/><g fill="#303438"/>';
    expect(tintLogoSvg(svg, "#7bd88f")).toBe('<rect fill="#7bd88f"/><g fill="#303438"/>');
  });
});

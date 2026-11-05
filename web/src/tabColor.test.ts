import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activeTab, activeTabId, TAB_HUES, tabColorKey, tabColorVars, tabHue } from "./tabColor";
import type { TabInfo } from "./types";

function tab(tab_id: string, label: string): TabInfo {
  return {
    tab_id,
    workspace_id: tab_id.split("-")[0],
    number: 1,
    label,
    focused: false,
    pane_count: 1,
    agent_status: "idle",
  };
}

describe("tabHue", () => {
  it("is stable for the same tab", () => {
    expect(tabHue(tab("1-1", "fm-kc-small-fixes"))).toBe(tabHue(tab("1-1", "fm-kc-small-fixes")));
  });

  it("always picks from the curated palette", () => {
    for (let n = 0; n < 200; n += 1) {
      expect(TAB_HUES).toContain(tabHue(tab(`1-${n}`, `tab ${n}`)));
    }
  });

  it("spreads tabs over most of the palette", () => {
    const hues = new Set<number>();
    for (let n = 0; n < 200; n += 1) {
      hues.add(tabHue(tab(`1-${n}`, `session-${n}`)));
    }
    expect(hues.size).toBe(TAB_HUES.length);
  });

  it("keys named tabs by name and unnamed tabs by id", () => {
    expect(tabColorKey(tab("1-2", "Build"))).toBe(tabColorKey(tab("9-9", " build ")));
    expect(tabColorKey(tab("1-2", "2"))).toBe("id:1-2");
    expect(tabColorKey(tab("1-2", "2"))).not.toBe(tabColorKey(tab("1-3", "3")));
  });
});

describe("active tab", () => {
  const space = { workspace_id: "1", active_tab_id: "1-1" };
  const tabs = [tab("1-1", "one"), tab("1-2", "two")];

  it("follows the selected pane's tab inside the active workspace", () => {
    expect(activeTabId(space, { workspace_id: "1", tab_id: "1-2" })).toBe("1-2");
    expect(activeTab({ tabs }, space, { workspace_id: "1", tab_id: "1-2" })?.label).toBe("two");
  });

  it("falls back to the workspace's active tab", () => {
    expect(activeTabId(space, { workspace_id: "2", tab_id: "2-1" })).toBe("1-1");
    expect(activeTab({ tabs }, space, null)?.label).toBe("one");
    expect(activeTab(null, space, null)).toBeNull();
  });
});

describe("tabColorVars", () => {
  it("carries the hue and a safe machine colour", () => {
    const vars = tabColorVars(tab("1-1", "x"), "#89b4fa");
    expect(vars["--tab-h"]).toBe(String(tabHue(tab("1-1", "x"))));
    expect(vars["--machine-color"]).toBe("#89b4fa");
  });

  it("drops machine colours that are not plain hex and yields nothing without a tab", () => {
    expect(tabColorVars(tab("1-1", "x"), "red; background: url(x)")["--machine-color"]).toBeUndefined();
    expect(tabColorVars(null, "#fff")).toEqual({});
  });
});

// The wash (and the active chip fill, over --row-active) is at most 30% (dark) / 12% (light) tab colour over the bar; text must stay readable on it. The
// numbers below mirror the `--tab-color` rules in styles.css (asserted against the file).
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function luminance([r, g, b]: [number, number, number]) {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function mix(
  top: [number, number, number],
  bottom: [number, number, number],
  amount: number,
): [number, number, number] {
  return top.map((v, i) => v * amount + bottom[i] * (1 - amount)) as [number, number, number];
}

describe("tab colour contrast", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const themes = [
    { name: "dark", wash: 0.3, sl: [72, 66], text: [205, 214, 244], bars: [[21, 21, 31], [24, 24, 37], [32, 32, 54]] },
    { name: "light", wash: 0.12, sl: [68, 40], text: [76, 79, 105], bars: [[211, 216, 226], [230, 233, 239], [221, 225, 234]] },
  ] as const;

  for (const theme of themes) {
    it(`keeps text readable on the ${theme.name} washes`, () => {
      expect(css).toContain(`hsl(var(--tab-h, 232) ${theme.sl[0]}% ${theme.sl[1]}%)`);
      for (const hue of TAB_HUES) {
        const tint = hslToRgb(hue, theme.sl[0], theme.sl[1]);
        for (const bar of theme.bars) {
          const wash = mix(tint, bar as unknown as [number, number, number], theme.wash);
          expect(contrast(theme.text as unknown as [number, number, number], wash)).toBeGreaterThan(4.5);
        }
      }
    });
  }
});

describe("machine colour contrast", () => {
  // Bridge colours are the pastel palette from bridge.tsx; white stands in for any custom
  // colour. The machine end of each wash is 24% (dark) / 14% (light).
  const machines = ["#89b4fa", "#a6e3a1", "#f9e2af", "#fab387", "#94e2d5", "#f38ba8", "#cba6f7", "#74c7ec", "#b4befe", "#ffffff"];
  const rgb = (hex: string) =>
    [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const cases = [
    { name: "dark", wash: 0.24, text: [205, 214, 244], bars: [[21, 21, 31], [24, 24, 37]] },
    { name: "light", wash: 0.14, text: [76, 79, 105], bars: [[211, 216, 226], [230, 233, 239]] },
  ] as const;

  for (const theme of cases) {
    it(`keeps text readable under every machine colour (${theme.name})`, () => {
      const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
      expect(css).toContain(`var(--machine-edge) ${Math.round(theme.wash * 100)}%, transparent`);
      for (const machine of machines) {
        for (const bar of theme.bars) {
          const wash = mix(rgb(machine), bar as unknown as [number, number, number], theme.wash);
          expect(contrast(theme.text as unknown as [number, number, number], wash)).toBeGreaterThan(4.5);
        }
      }
    });
  }
});

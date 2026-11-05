import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

function mediaBlocks(query: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  while (true) {
    const start = css.indexOf(query, from);
    if (start < 0) return blocks;
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") {
        depth--;
        if (depth === 0) {
          blocks.push(css.slice(start, i + 1));
          from = i + 1;
          break;
        }
      }
    }
  }
}

describe("composer mobile sizing", () => {
  it("keeps the desktop 34px composer grid as the base", () => {
    expect(css).toMatch(/--mobile-input-row-height:\s*calc\(34px/);
    expect(css).toMatch(/--mobile-send-width:\s*calc\(38px/);
  });

  it("restores a small-viewport breakpoint for the composer bar", () => {
    const small = mediaBlocks("@media (max-width: 820px)").filter((b) =>
      b.includes(".terminal-mobile-controls"),
    );
    expect(small.length).toBeGreaterThan(0);
    const rules = small.join("\n");
    // The main row (input, next pane, send) retains a 44px target despite a reduced user scale.
    expect(rules).toMatch(/--mobile-input-row-height:\s*max\(44px/);
    expect(rules).toMatch(/--mobile-send-width:\s*max\(44px/);
    // Tray keys (shown on demand, one row) may be 40px so the bar stays two rows tall.
    expect(rules).toMatch(/--mobile-key-height:\s*max\(40px/);
    expect(rules).toMatch(/padding:/);
  });

  it("puts the keys toggle, input, next pane and send on one main row, capping growth near four lines", () => {
    const small = mediaBlocks("@media (max-width: 820px)").join("\n");
    expect(small).toMatch(/\.term-input-row\s*\{[^}]*flex-direction:\s*row/);
    expect(small).toMatch(/\.term-input-row \.term-key,\s*\.term-input-row \.term-send\s*\{[^}]*height:\s*var\(--mobile-input-row-height\)/);
    expect(small).toMatch(/\.term-composer-input\s*\{[^}]*flex:\s*1 1 0/);
    expect(small).toMatch(/\.term-compact-toggle\s*\{[^}]*order:\s*0/);
    expect(small).toMatch(/\.term-pin-cycle\s*\{[^}]*order:\s*2/);
    expect(small).toMatch(/\.term-native-input\[data-expanding="true"\]\s*\{[^}]*\*\s*4/);
  });

  it("budgets the chrome above the terminal from the screen height on a phone", () => {
    const budget = mediaBlocks("@media (max-width: 820px)").filter((b) => b.includes(".tabbar"));
    expect(budget.length).toBeGreaterThan(0);
    const rules = budget.join("\n");
    expect(rules).toMatch(/\.tabbar\s*\{[^}]*clamp\([^)]*dvh/);
    expect(rules).toMatch(/\.stage-bar\s*\{[^}]*clamp\([^)]*dvh/);
  });

  it("sizes touch glyphs for thumbs while fitting the button grid", () => {
    const keyIcon = css.match(/\.term-key-icon svg\s*\{[^}]*\}/);
    expect(keyIcon?.[0]).toMatch(/width:\s*calc\(20px/);
    expect(keyIcon?.[0]).toMatch(/height:\s*calc\(20px/);
    const send = css.match(/\.term-send svg\s*\{[^}]*\}/);
    expect(send?.[0]).toMatch(/width:\s*calc\(20px/);
    expect(send?.[0]).toMatch(/height:\s*calc\(20px/);
  });
});

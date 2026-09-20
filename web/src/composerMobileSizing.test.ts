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
    // Taller input row and roomier keys/send target for a phone viewport.
    expect(rules).toMatch(/--mobile-input-row-height:\s*calc\(44px/);
    expect(rules).toMatch(/--mobile-key-height:\s*calc\(36px/);
    expect(rules).toMatch(/--mobile-send-width:\s*calc\(48px/);
    expect(rules).toMatch(/padding:/);
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

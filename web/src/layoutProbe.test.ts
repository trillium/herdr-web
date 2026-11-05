import { describe, expect, it } from "vitest";
import {
  LAYOUT_PROBE_STORAGE_KEY,
  PROBE_CHUNK_MAX_CHARS,
  formatProbeChunks,
  gapToViewportBottom,
  gapToVisualBottom,
  resolveLayoutProbeFlag,
} from "./layoutProbe";
import type { LayoutProbeSnapshot } from "./layoutProbe";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

const snapshot: LayoutProbeSnapshot = {
  innerW: 440,
  innerH: 956,
  clientH: 956,
  vvW: 440,
  vvH: 956,
  vvTop: 0,
  dvh: 956,
  svh: 956,
  lvh: 956,
  screenH: 956,
  dpr: 3,
  standalone: true,
  safeTop: 62,
  safeBottom: 34,
  inset: 0,
  appPadBottom: 0,
  barPadBottom: 24,
  app: { top: 62, bottom: 956, height: 894 },
  bar: { top: 884.5, bottom: 956, height: 71.5 },
  row: { top: 886, bottom: 932, height: 46 },
  host: { top: 118, bottom: 884, height: 766 },
};

describe("resolveLayoutProbeFlag", () => {
  it("is off by default and stays off without the flag", () => {
    expect(resolveLayoutProbeFlag("", memoryStorage())).toBe(false);
    expect(resolveLayoutProbeFlag("?other=1", memoryStorage())).toBe(false);
  });

  it("turns on from ?layout=1 and remembers it for the installed app", () => {
    const storage = memoryStorage();
    expect(resolveLayoutProbeFlag("?layout=1", storage)).toBe(true);
    expect(storage.getItem(LAYOUT_PROBE_STORAGE_KEY)).toBe("1");
    expect(resolveLayoutProbeFlag("", storage)).toBe(true);
  });

  it("turns off from ?layout=0 and forgets it", () => {
    const storage = memoryStorage({ [LAYOUT_PROBE_STORAGE_KEY]: "1" });
    expect(resolveLayoutProbeFlag("?layout=0", storage)).toBe(false);
    expect(resolveLayoutProbeFlag("", storage)).toBe(false);
  });

  it("still honours the URL when storage is unavailable", () => {
    expect(resolveLayoutProbeFlag("?layout=1", null)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(resolveLayoutProbeFlag("?layout=1", broken)).toBe(true);
    expect(resolveLayoutProbeFlag("", broken)).toBe(false);
  });
});

describe("gap helpers", () => {
  it("measures the row's distance to the layout and visual viewport bottoms", () => {
    expect(gapToViewportBottom(snapshot.row, 956)).toBe(24);
    expect(gapToVisualBottom(snapshot.row, 0, 956)).toBe(24);
    expect(gapToVisualBottom(snapshot.row, 10, 900)).toBe(-22);
    expect(gapToViewportBottom(null, 956)).toBeNull();
  });
});

describe("formatProbeChunks", () => {
  it("fits every chunk under the client-log detail cap and leads with the gap", () => {
    const chunks = formatProbeChunks(snapshot, 12);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(PROBE_CHUNK_MAX_CHARS);
      expect(chunk).toMatch(/^layout-probe n=12 \d\/\d /);
      expect(chunk).toMatch(/^[ -~]+$/);
    }
    expect(chunks[0]).toContain("gap=24");
    const all = chunks.join(" ");
    expect(all).toContain("safeB=34");
    expect(all).toContain("row=886-932");
  });

  it("reports a missing controls bar instead of throwing", () => {
    const chunks = formatProbeChunks({ ...snapshot, row: null, bar: null }, 1);
    expect(chunks[0]).toContain("gap=none");
  });
});

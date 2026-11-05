// Layout probe: reads where the phone controls bar really sits relative to the bottom of the
// page so a gap under the input row can be measured on the real device, not just emulation.
//
// Turn it on with `?layout=1` on any URL (`?layout=0` turns it off), or with Settings -> Bridge ->
// Layout probe, which is the way in for an installed home-screen app that has no URL bar. The
// choice is remembered in localStorage. While on, a corner overlay prints the numbers, outlines
// the input row, and beams the numbers to the bridge log (`herdr-web.log`, grep `layout-probe`) on load,
// on every rotation/resize, and when the overlay's Send button is tapped.

export const LAYOUT_PROBE_STORAGE_KEY = "herdr.layoutProbe.v1";
export const LAYOUT_PROBE_CHANGE_EVENT = "herdr:layout-probe-change";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * Resolves the flag from `?layout=` (which also persists the choice) or storage.
 * `layout=1|true|on` enables, `layout=0|false|off` disables, anything else defers to storage.
 */
export function resolveLayoutProbeFlag(search: string, storage: FlagStorage | null): boolean {
  const param = new URLSearchParams(search).get("layout")?.toLowerCase();
  const fromUrl = param === "1" || param === "true" || param === "on";
  const offUrl = param === "0" || param === "false" || param === "off";
  try {
    if (fromUrl) {
      storage?.setItem(LAYOUT_PROBE_STORAGE_KEY, "1");
      return true;
    }
    if (offUrl) {
      storage?.removeItem(LAYOUT_PROBE_STORAGE_KEY);
      return false;
    }
    return storage?.getItem(LAYOUT_PROBE_STORAGE_KEY) === "1";
  } catch {
    return fromUrl;
  }
}

export function readLayoutProbeFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  return resolveLayoutProbeFlag(window.location.search, storage);
}

export function setLayoutProbeFlag(enabled: boolean) {
  try {
    if (enabled) {
      window.localStorage.setItem(LAYOUT_PROBE_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(LAYOUT_PROBE_STORAGE_KEY);
    }
  } catch {
    // Storage can be blocked; the toggle just will not persist.
  }
  window.dispatchEvent(new CustomEvent(LAYOUT_PROBE_CHANGE_EVENT, { detail: enabled }));
}

export type ProbeRect = { top: number; bottom: number; height: number };

export type LayoutProbeSnapshot = {
  innerW: number;
  innerH: number;
  clientH: number;
  vvW: number;
  vvH: number;
  vvTop: number;
  dvh: number;
  svh: number;
  lvh: number;
  screenH: number;
  dpr: number;
  standalone: boolean;
  safeTop: number;
  safeBottom: number;
  inset: number;
  appPadBottom: number;
  barPadBottom: number;
  app: ProbeRect | null;
  bar: ProbeRect | null;
  row: ProbeRect | null;
  host: ProbeRect | null;
};

const round = (value: number) => Math.round(value * 10) / 10;

export function rectOf(el: Element | null): ProbeRect | null {
  if (!el) {
    return null;
  }
  const rect = el.getBoundingClientRect();
  return { top: round(rect.top), bottom: round(rect.bottom), height: round(rect.height) };
}

/** Distance from an element's bottom edge to the bottom of the layout viewport. */
export function gapToViewportBottom(rect: ProbeRect | null, viewportHeight: number): number | null {
  return rect ? round(viewportHeight - rect.bottom) : null;
}

/** Distance from the bottom edge to the bottom of the visual viewport (what the user sees). */
export function gapToVisualBottom(
  rect: ProbeRect | null,
  vvTop: number,
  vvH: number,
): number | null {
  return rect ? round(vvTop + vvH - rect.bottom) : null;
}

const rectText = (rect: ProbeRect | null) =>
  rect ? `${rect.top.toFixed(0)}-${rect.bottom.toFixed(0)}` : "none";

/** Field list for the bridge log, ordered so the answer (the gap) comes first. */
export function probeFields(s: LayoutProbeSnapshot): string[] {
  const gap = gapToViewportBottom(s.row, s.innerH);
  const vvGap = gapToVisualBottom(s.row, s.vvTop, s.vvH);
  return [
    `gap=${gap ?? "none"}`,
    `vvgap=${vvGap ?? "none"}`,
    `inner=${s.innerW}x${s.innerH}`,
    `vv=${s.vvW}x${s.vvH}@${s.vvTop}`,
    `client=${s.clientH}`,
    `dvh=${s.dvh}`,
    `svh=${s.svh}`,
    `lvh=${s.lvh}`,
    `screen=${s.screenH}`,
    `dpr=${s.dpr}`,
    `pwa=${s.standalone ? 1 : 0}`,
    `safeB=${s.safeBottom}`,
    `safeT=${s.safeTop}`,
    `inset=${s.inset}`,
    `appPadB=${s.appPadBottom}`,
    `barPadB=${s.barPadBottom}`,
    `app=${rectText(s.app)}`,
    `bar=${rectText(s.bar)}`,
    `row=${rectText(s.row)}`,
    `host=${rectText(s.host)}`,
  ];
}

/** Stable single-line form, used to tell whether the numbers moved. */
export function formatProbeLine(s: LayoutProbeSnapshot): string {
  return probeFields(s).join(" ");
}

/** The bridge's client-log detail cap is 160 bytes and the page's own sanitizer keeps 120. */
export const PROBE_CHUNK_MAX_CHARS = 118;

/**
 * Splits one measurement into log details that each fit under the client-log detail cap.
 * Every chunk is `layout-probe n=<seq> <i>/<total> fields...`, so `grep layout-probe` in
 * `herdr-web.log` recovers the whole measurement and `n` ties its chunks together.
 */
export function formatProbeChunks(s: LayoutProbeSnapshot, seq: number): string[] {
  const groups: string[][] = [[]];
  const budget = PROBE_CHUNK_MAX_CHARS - `layout-probe n=${seq} 9/9 `.length;
  for (const field of probeFields(s)) {
    const current = groups[groups.length - 1];
    if (current.length > 0 && [...current, field].join(" ").length > budget) {
      groups.push([field]);
    } else {
      current.push(field);
    }
  }
  return groups.map((fields, index) => `layout-probe n=${seq} ${index + 1}/${groups.length} ${fields.join(" ")}`);
}

/** Probes in the multi-line form shown inside the overlay. */
export function formatProbeLines(s: LayoutProbeSnapshot): string[] {
  const gap = gapToViewportBottom(s.row, s.innerH);
  const vvGap = gapToVisualBottom(s.row, s.vvTop, s.vvH);
  const barGap = gapToViewportBottom(s.bar, s.innerH);
  return [
    `row->bottom gap ${gap ?? "-"}px (visual ${vvGap ?? "-"})`,
    `bar->bottom gap ${barGap ?? "-"}px  bar pad-bottom ${s.barPadBottom}px`,
    `inner ${s.innerW}x${s.innerH}  vv ${s.vvW}x${s.vvH}@${s.vvTop}`,
    `dvh ${s.dvh} svh ${s.svh} lvh ${s.lvh}  client ${s.clientH}`,
    `safe-area bottom ${s.safeBottom} top ${s.safeTop}  inset ${s.inset}`,
    `${s.standalone ? "standalone" : "browser"}  dpr ${s.dpr}  screen ${s.screenH}`,
    `row ${rectText(s.row)}  bar ${rectText(s.bar)}  host ${rectText(s.host)}`,
  ];
}

/** Hidden element whose height resolves a CSS length, so units JS cannot read are measurable. */
function measureCss(host: HTMLElement, height: string, paddingBottom = ""): number {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:fixed;left:-9999px;top:0;width:1px;visibility:hidden;pointer-events:none;" +
    `height:${height};padding-bottom:${paddingBottom || "0"};box-sizing:content-box;`;
  host.appendChild(probe);
  const value = paddingBottom ? parseFloat(getComputedStyle(probe).paddingBottom) : probe.offsetHeight;
  host.removeChild(probe);
  return Number.isFinite(value) ? round(value) : 0;
}

function numericPx(value: string | null | undefined) {
  const parsed = parseFloat(value ?? "");
  return Number.isFinite(parsed) ? round(parsed) : 0;
}

export function captureLayoutProbe(doc: Document = document): LayoutProbeSnapshot {
  const win = doc.defaultView ?? window;
  const vv = win.visualViewport;
  const body = doc.body;
  const app = doc.querySelector(".app");
  const bar = doc.querySelector(".terminal-mobile-controls, .terminal-command-controls");
  const row = bar?.querySelector(".term-input-row") ?? null;
  const host = doc.querySelector(".terminal-host");
  const inset = numericPx(app ? getComputedStyle(app).getPropertyValue("--content-inset-bottom") : "");
  return {
    innerW: win.innerWidth,
    innerH: win.innerHeight,
    clientH: doc.documentElement.clientHeight,
    vvW: round(vv?.width ?? 0),
    vvH: round(vv?.height ?? 0),
    vvTop: round(vv?.offsetTop ?? 0),
    dvh: measureCss(body, "100dvh"),
    svh: measureCss(body, "100svh"),
    lvh: measureCss(body, "100lvh"),
    screenH: win.screen?.height ?? 0,
    dpr: win.devicePixelRatio,
    standalone:
      win.matchMedia?.("(display-mode: standalone)").matches === true ||
      (win.navigator as Navigator & { standalone?: boolean }).standalone === true,
    safeTop: measureCss(body, "0px", "env(safe-area-inset-top)"),
    safeBottom: measureCss(body, "0px", "env(safe-area-inset-bottom)"),
    inset,
    appPadBottom: app ? numericPx(getComputedStyle(app).paddingBottom) : 0,
    barPadBottom: bar ? numericPx(getComputedStyle(bar).paddingBottom) : 0,
    app: rectOf(app),
    bar: rectOf(bar),
    row: rectOf(row),
    host: rectOf(host),
  };
}

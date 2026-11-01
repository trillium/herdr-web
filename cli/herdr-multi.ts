#!/usr/bin/env bun
// herdr-multi — multi-host herdr tab browser
// Usage: bun herdr-multi.ts [bridge-url ...]
// Defaults: localhost:8787 + 100.111.197.110:8787
//
// Shows workspaces and tabs from multiple herdr-web-bridge instances.
// Enter on a local tab → tab.focus. Enter on remote → prints herdr --remote hint.

import * as readline from "readline";

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_BRIDGES = [
  { url: "http://localhost:8787", host: "local" },
  { url: "http://100.111.197.110:8787", host: "mini2" },
];

const BRIDGES: Array<{ url: string; host: string }> = process.argv.slice(2).length
  ? process.argv.slice(2).map((arg) => {
      const u = new URL(arg);
      return { url: arg, host: u.hostname === "localhost" ? "local" : u.hostname };
    })
  : DEFAULT_BRIDGES;

// ── Types ────────────────────────────────────────────────────────────────────

type AgentStatus = "working" | "idle" | "done" | "unknown";

interface SnapshotTab {
  tab_id: string;
  workspace_id: string;
  label: string;
  agent_status: AgentStatus;
  focused: boolean;
}

interface SnapshotWorkspace {
  workspace_id: string;
  label: string;
  focused: boolean;
  agent_status: AgentStatus;
}

interface SnapshotPane {
  pane_id: string;
  tab_id: string;
  cwd: string;
  foreground_cwd?: string;
  focused: boolean;
}

interface Snapshot {
  workspaces: SnapshotWorkspace[];
  tabs: SnapshotTab[];
  panes: SnapshotPane[];
}

interface BridgeData {
  host: string;
  url: string;
  snapshot: Snapshot | null;
  error?: string;
}

// ── Nav items (flat selectable list) ─────────────────────────────────────────

type NavHeader = { type: "host"; bridgeIdx: number };
type NavWorkspace = { type: "workspace"; bridgeIdx: number; label: string };
type NavTab = {
  type: "tab";
  bridgeIdx: number;
  tabId: string;
  label: string;
  status: AgentStatus;
  focused: boolean;
  cwd: string;
};
type NavItem = NavHeader | NavWorkspace | NavTab;

function buildNav(data: BridgeData[]): NavItem[] {
  const items: NavItem[] = [];
  for (let bi = 0; bi < data.length; bi++) {
    items.push({ type: "host", bridgeIdx: bi });
    const snap = data[bi].snapshot;
    if (!snap) continue;
    for (const ws of snap.workspaces) {
      items.push({ type: "workspace", bridgeIdx: bi, label: ws.label });
      for (const tab of snap.tabs.filter((t) => t.workspace_id === ws.workspace_id)) {
        const pane = snap.panes.find((p) => p.tab_id === tab.tab_id);
        const rawCwd = pane?.foreground_cwd ?? pane?.cwd ?? "";
        items.push({
          type: "tab",
          bridgeIdx: bi,
          tabId: tab.tab_id,
          label: tab.label,
          status: tab.agent_status,
          focused: tab.focused,
          cwd: rawCwd.replace(process.env.HOME ?? "/Users/trilliumsmith", "~"),
        });
      }
    }
  }
  return items;
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const REV = "\x1b[7m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";

function statusGlyph(s: AgentStatus): string {
  if (s === "working") return `${GREEN}●${R}`;
  if (s === "idle") return `${D}○${R}`;
  if (s === "done") return `${BLUE}✓${R}`;
  return `${D}·${R}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

// ── State ────────────────────────────────────────────────────────────────────

let bridges: BridgeData[] = BRIDGES.map((b) => ({ ...b, snapshot: null }));
let nav: NavItem[] = [];
let cursor = 0;
let status = "loading…";

// ── Render ───────────────────────────────────────────────────────────────────

function render() {
  const w = Math.max(process.stdout.columns || 80, 40);
  const out: string[] = [];

  out.push(`\x1b[2J\x1b[H`); // clear + home
  out.push(`  ${CYAN}${B}herdr-multi${R}  ${D}↑↓ move  Enter focus  r refresh  q quit${R}`);
  out.push("");

  for (let i = 0; i < nav.length; i++) {
    const item = nav[i];
    const sel = i === cursor && item.type === "tab";

    if (item.type === "host") {
      const b = bridges[item.bridgeIdx];
      const dot = b.error ? `${RED}✗${R}` : `${GREEN}●${R}`;
      const err = b.error ? `  ${RED}${b.error}${R}` : "";
      out.push(`  ${dot} ${B}${b.host}${R}  ${D}${b.url.replace("http://", "")}${R}${err}`);
    } else if (item.type === "workspace") {
      out.push(`    ${D}╰─${R} ${item.label}`);
    } else {
      const focusMark = item.focused ? `${YELLOW}▶${R}` : " ";
      const glyph = statusGlyph(item.status);
      const labelW = 16;
      const cwdW = w - 26; // prefix is 4+1+1+1+1+16+2 = 26 visible chars
      // Apply REV only to the label (no inner ANSI codes there) so reset codes
      // inside focusMark/glyph don't cancel the highlight mid-line.
      const labelDisplay = sel
        ? `${REV}${pad(item.label, labelW)}${R}`
        : pad(item.label, labelW);
      const line =
        `    ${focusMark} ${glyph} ${labelDisplay}  ` +
        `${D}${item.cwd.slice(0, Math.max(0, cwdW))}${R}`;
      out.push(line);
    }
  }

  out.push("");
  out.push(`  ${D}${status}${R}`);
  process.stdout.write(out.join("\n"));
}

// ── Data fetching ─────────────────────────────────────────────────────────────

async function fetchAll() {
  status = "refreshing…";
  render();

  const results = await Promise.allSettled(
    BRIDGES.map(async (b, i) => {
      const res = await fetch(`${b.url}/api/snapshot`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { i, snapshot: (await res.json()) as Snapshot };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") {
      bridges[r.value.i].snapshot = r.value.snapshot;
      bridges[r.value.i].error = undefined;
    } else {
      bridges[i].error = (r.reason as Error)?.message ?? "error";
    }
  }

  nav = buildNav(bridges);

  // clamp first (nav may have shrunk), then ensure cursor lands on a tab
  if (nav.length > 0) cursor = Math.min(cursor, nav.length - 1);
  if (nav[cursor]?.type !== "tab") {
    const first = nav.findIndex((n) => n.type === "tab");
    if (first >= 0) cursor = first;
  }

  status = `ready · ${new Date().toLocaleTimeString()}`;
  render();
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function focusSelected() {
  const item = nav[cursor];
  if (item?.type !== "tab") return;
  const bridge = bridges[item.bridgeIdx];

  if (bridge.host === "local") {
    try {
      const res = await fetch(`${bridge.url}/api/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tab.focus", params: { tab_id: item.tabId } }),
        signal: AbortSignal.timeout(2000),
      });
      status = res.ok ? `focused → ${item.label}` : `focus failed (${res.status})`;
    } catch (e: unknown) {
      status = `error: ${(e as Error).message}`;
    }
  } else {
    status = `remote: run  herdr --remote ${bridge.host}  in a new tab`;
  }
  render();
}

function moveCursor(dir: 1 | -1) {
  let next = cursor + dir;
  while (next >= 0 && next < nav.length && nav[next]?.type !== "tab") next += dir;
  if (next >= 0 && next < nav.length) cursor = next;
  render();
}

// ── Main ──────────────────────────────────────────────────────────────────────

function cleanup() {
  process.stdout.write("\x1b[?25h\x1b[2J\x1b[H");
  process.exit(0);
}

process.stdout.write("\x1b[?25l"); // hide cursor
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);

process.stdin.on("keypress", async (_str: string, key: { name?: string; ctrl?: boolean }) => {
  if (!key) return;
  if ((key.ctrl && key.name === "c") || key.name === "q") cleanup();
  else if (key.name === "up" || (key.ctrl && key.name === "p")) moveCursor(-1);
  else if (key.name === "down" || (key.ctrl && key.name === "n")) moveCursor(1);
  else if (key.name === "r") await fetchAll();
  else if (key.name === "return") await focusSelected();
});

process.on("exit", () => process.stdout.write("\x1b[?25h"));
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
process.stdout.on("resize", render);

// initial load + auto-refresh every 10s
await fetchAll();
setInterval(fetchAll, 10_000);

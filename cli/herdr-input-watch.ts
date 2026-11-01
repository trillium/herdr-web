#!/usr/bin/env bun
// herdr-input-watch — watch what's being typed in every herdr pane
// Subscribes to /ws/terminal for each pane, parses VT100 bytes, extracts
// the cursor line after a debounce window, emits JSON events to stdout.
//
// Usage: bun herdr-input-watch.ts [bridge-url ...] [--debounce-ms N]
// Output: one JSON line per change — {type, host, pane_id, tab_id, tab_label, input, ts}
//
// Pipe to any downstream tool or use as an event source.

const DEFAULT_BRIDGES = [
  { url: "http://localhost:8787", host: "local" },
  { url: "http://100.111.197.110:8787", host: "mini2" },
];
const DEFAULT_DEBOUNCE_MS = 400;

// ── CLI args ─────────────────────────────────────────────────────────────────

let debounceMs = DEFAULT_DEBOUNCE_MS;
const bridgeArgs: string[] = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--debounce-ms" && process.argv[i + 1]) {
    debounceMs = parseInt(process.argv[++i]);
  } else {
    bridgeArgs.push(process.argv[i]);
  }
}

const BRIDGES = bridgeArgs.length
  ? bridgeArgs.map((arg) => {
      const u = new URL(arg);
      return { url: arg, host: u.hostname === "localhost" ? "local" : u.hostname };
    })
  : DEFAULT_BRIDGES;

// ── Minimal VT100 virtual terminal ────────────────────────────────────────────
// Tracks cursor position and screen content. Only what we need — no color state,
// no alternate screen swap, no scrollback. Good enough for shell prompt lines.

class VT100Terminal {
  readonly rows: number;
  readonly cols: number;
  private screen: string[][];
  cursorRow = 0;
  cursorCol = 0;
  private buf = "";
  private decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(cols = 200, rows = 50) {
    this.rows = rows;
    this.cols = cols;
    this.screen = Array.from({ length: rows }, () => Array(cols).fill(" "));
  }

  feed(bytes: Uint8Array) {
    this.buf += this.decoder.decode(bytes, { stream: true });
    this.parse();
  }

  private parse() {
    let i = 0;
    while (i < this.buf.length) {
      const ch = this.buf[i];

      if (ch === "\x1b") {
        if (i + 1 >= this.buf.length) break;
        const next = this.buf[i + 1];

        if (next === "[") {
          // CSI: ESC [ <params> <final>
          const csiStart = i + 2;
          let j = csiStart;
          while (j < this.buf.length && !isCsiFinal(this.buf[j])) j++;
          if (j >= this.buf.length) break;
          this.handleCSI(this.buf.slice(csiStart, j), this.buf[j]);
          i = j + 1;
        } else if (next === "]") {
          // OSC: ESC ] ... BEL or ST
          const end = findOscEnd(this.buf, i + 2);
          if (end < 0) break;
          i = end;
        } else if (next === "(" || next === ")" || next === "*" || next === "+") {
          // Charset designator — ESC ( A etc
          if (i + 2 >= this.buf.length) break;
          i += 3;
        } else {
          // Two-char escape (ESC M, ESC =, ESC >, etc.) — skip both
          i += 2;
        }
      } else if (ch === "\r") {
        this.cursorCol = 0;
        i++;
      } else if (ch === "\n") {
        this.cursorRow = Math.min(this.cursorRow + 1, this.rows - 1);
        i++;
      } else if (ch === "\b") {
        this.cursorCol = Math.max(0, this.cursorCol - 1);
        i++;
      } else if (ch === "\t") {
        this.cursorCol = Math.min(this.cols - 1, (Math.floor(this.cursorCol / 8) + 1) * 8);
        i++;
      } else if (ch === "\x07" || ch === "\x0e" || ch === "\x0f") {
        // BEL, SO, SI — ignore
        i++;
      } else if (ch.charCodeAt(0) >= 0x20) {
        // Printable
        if (this.cursorRow < this.rows && this.cursorCol < this.cols) {
          this.screen[this.cursorRow][this.cursorCol] = ch;
          this.cursorCol = Math.min(this.cursorCol + 1, this.cols - 1);
        }
        i++;
      } else {
        i++;
      }
    }
    this.buf = this.buf.slice(i);
  }

  private handleCSI(params: string, cmd: string) {
    const nums = params.split(";").map((s) => parseInt(s) || 0);
    const n = nums[0];
    const m = nums[1];

    switch (cmd) {
      case "H": // CUP - cursor position
      case "f":
        this.cursorRow = Math.min(Math.max((n || 1) - 1, 0), this.rows - 1);
        this.cursorCol = Math.min(Math.max((m || 1) - 1, 0), this.cols - 1);
        break;
      case "A": // CUU
        this.cursorRow = Math.max(0, this.cursorRow - (n || 1));
        break;
      case "B": // CUD
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + (n || 1));
        break;
      case "C": // CUF
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + (n || 1));
        break;
      case "D": // CUB
        this.cursorCol = Math.max(0, this.cursorCol - (n || 1));
        break;
      case "G": // CHA
        this.cursorCol = Math.min(Math.max((n || 1) - 1, 0), this.cols - 1);
        break;
      case "d": // VPA
        this.cursorRow = Math.min(Math.max((n || 1) - 1, 0), this.rows - 1);
        break;
      case "J": { // ED - erase display
        if (n === 0) {
          this.clearRange(this.cursorRow, this.cursorCol, this.rows - 1, this.cols);
        } else if (n === 1) {
          this.clearRange(0, 0, this.cursorRow, this.cursorCol + 1);
        } else {
          for (let r = 0; r < this.rows; r++) this.clearRow(r, 0, this.cols);
          if (n === 2) { this.cursorRow = 0; this.cursorCol = 0; }
        }
        break;
      }
      case "K": // EL - erase line
        if (n === 0) this.clearRow(this.cursorRow, this.cursorCol, this.cols);
        else if (n === 1) this.clearRow(this.cursorRow, 0, this.cursorCol + 1);
        else this.clearRow(this.cursorRow, 0, this.cols);
        break;
      case "L": { // IL - insert lines
        const cnt = n || 1;
        for (let r = this.rows - 1; r >= this.cursorRow + cnt; r--)
          this.screen[r] = [...this.screen[r - cnt]];
        for (let r = this.cursorRow; r < Math.min(this.cursorRow + cnt, this.rows); r++)
          this.clearRow(r, 0, this.cols);
        break;
      }
      case "M": { // DL - delete lines
        const cnt = n || 1;
        for (let r = this.cursorRow; r < this.rows - cnt; r++)
          this.screen[r] = [...this.screen[r + cnt]];
        for (let r = this.rows - cnt; r < this.rows; r++) this.clearRow(r, 0, this.cols);
        break;
      }
      case "P": { // DCH - delete characters
        const row = this.screen[this.cursorRow];
        row.splice(this.cursorCol, n || 1);
        while (row.length < this.cols) row.push(" ");
        break;
      }
      case "X": // ECH - erase characters
        this.clearRow(this.cursorRow, this.cursorCol, this.cursorCol + (n || 1));
        break;
      // SGR, DECSTBM, mode sequences — no-op
    }
  }

  private clearRow(row: number, from: number, to: number) {
    if (row < 0 || row >= this.rows) return;
    const end = Math.min(to, this.cols);
    for (let c = from; c < end; c++) this.screen[row][c] = " ";
  }

  private clearRange(r1: number, c1: number, r2: number, c2: number) {
    if (r1 === r2) {
      this.clearRow(r1, c1, c2);
      return;
    }
    this.clearRow(r1, c1, this.cols);
    for (let r = r1 + 1; r < r2; r++) this.clearRow(r, 0, this.cols);
    this.clearRow(r2, 0, c2);
  }

  cursorLine(): string {
    if (this.cursorRow < 0 || this.cursorRow >= this.rows) return "";
    return this.screen[this.cursorRow].join("").trimEnd();
  }

  // Scan bottom-up for the first row starting with ❯ (Claude Code input prompt).
  // More reliable than cursorLine() because after a full Ink repaint the cursor
  // parks at the status footer — not the input row — so cursorLine() is wrong.
  promptLine(): string {
    for (let r = this.rows - 1; r >= 0; r--) {
      const trimmed = this.screen[r].join("").trimEnd().trimStart();
      if (trimmed.startsWith("❯")) return trimmed;
    }
    return "";
  }
}

function isCsiFinal(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function findOscEnd(buf: string, start: number): number {
  for (let i = start; i < buf.length; i++) {
    if (buf[i] === "\x07") return i + 1;
    if (buf[i] === "\x1b" && i + 1 < buf.length && buf[i + 1] === "\\") return i + 2;
  }
  return -1;
}

// ── Snapshot types ────────────────────────────────────────────────────────────

interface SnapshotTab { tab_id: string; label: string }
interface SnapshotPane { pane_id: string; tab_id: string }
interface Snapshot { tabs: SnapshotTab[]; panes: SnapshotPane[] }

// ── Emit ──────────────────────────────────────────────────────────────────────

function emit(event: Record<string, unknown>) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ── Pane watcher ──────────────────────────────────────────────────────────────

function watchPane(
  bridgeUrl: string,
  host: string,
  paneId: string,
  tabId: string,
  tabLabel: string,
) {
  const wsUrl =
    bridgeUrl.replace(/^http/, "ws") +
    `/ws/terminal?terminal_id=${encodeURIComponent(paneId)}&cols=200&rows=50`;

  const vt = new VT100Terminal(200, 50);
  let lastEmit = "";
  let pendingLine = "";           // candidate from previous flush
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function checkAndEmit() {
    const line = vt.promptLine();
    // Strip the ❯ prompt glyph to get the raw typed content
    const content = line.replace(/^❯\s*/, "").trim();

    // Two-flush stability: require the same content across two consecutive
    // checkAndEmit calls before emitting, to avoid acting on mid-repaint frames.
    if (content === pendingLine && content.length > 0 && line !== lastEmit) {
      lastEmit = line;
      emit({ type: "input_changed", host, pane_id: paneId, tab_id: tabId, tab_label: tabLabel, input: content, ts: Date.now() });
      pendingLine = "";
    } else {
      pendingLine = content;
      // Re-schedule for a second confirmation flush after a short settle window
      if (content.length > 0 && line !== lastEmit) {
        debounceTimer = setTimeout(checkAndEmit, 60);
      }
    }
  }

  function connect() {
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    ws.binaryType = "arraybuffer";

    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      vt.feed(new Uint8Array(e.data));
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkAndEmit, debounceMs);
    };

    ws.onerror = () => {};
    ws.onclose = () => setTimeout(connect, 5000);
  }

  connect();
}

// ── Bridge bootstrap ──────────────────────────────────────────────────────────

async function watchBridge(bridgeUrl: string, host: string) {
  let snap: Snapshot;
  try {
    const res = await fetch(`${bridgeUrl}/api/snapshot`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    snap = (await res.json()) as Snapshot;
  } catch (e) {
    process.stderr.write(`[herdr-input-watch] ${host}: ${(e as Error).message}\n`);
    return;
  }

  const tabLabel = new Map(snap.tabs.map((t) => [t.tab_id, t.label]));
  for (const pane of snap.panes) {
    watchPane(bridgeUrl, host, pane.pane_id, pane.tab_id, tabLabel.get(pane.tab_id) ?? "");
  }
  process.stderr.write(`[herdr-input-watch] ${host}: watching ${snap.panes.length} pane(s)\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

for (const b of BRIDGES) watchBridge(b.url, b.host).catch(() => {});

process.stderr.write(
  `[herdr-input-watch] bridges=${BRIDGES.map((b) => b.host).join(",")} debounce=${debounceMs}ms\n`,
);

// Keep alive — event loop stays warm via WS connections
setInterval(() => {}, 60_000);

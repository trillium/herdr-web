#!/usr/bin/env bun
// herdr-channel — watch ALL WezTerm panes for "channel <name>" commands.
//
// Usage: bun herdr-channel.ts [--bridge-url URL] [--debounce-ms N]
//
// Commands detected in any terminal:
//   channel <name>        — focus the named herdr tab (Parlay id/nickname/label)
//   channel list          — split-pane picker, all tabs (mode C)
//   channel list active   — split-pane picker, active/listening tabs only (mode C)
//   channel list full     — new-tab fzf picker, all tabs (mode A)
//   channel list cards    — new-tab custom TUI, all tabs (mode B)
//   pin next / pin prev   — cycle focus to the next/previous pinned tab
//
// Resolution order for <name>:
//   1. Parlay agent id (exact, case-insensitive)
//   2. Parlay agent nicknames (exact, case-insensitive)
//   3. herdr tab label (exact, case-insensitive)
//   4. herdr tab label (substring, case-insensitive)

const BRIDGE_URL = (() => {
  const idx = process.argv.indexOf("--bridge-url")
  return idx >= 0 ? process.argv[idx + 1] : "http://localhost:8787"
})()

const DEBOUNCE_MS = (() => {
  const idx = process.argv.indexOf("--debounce-ms")
  return idx >= 0 ? parseInt(process.argv[idx + 1]) : 400
})()

const POLL_PANES_MS = 3000   // re-scan pane list this often
const POLL_LINE_MS  = 200    // sample each pane's last line this often

const PARLAY_AGENTS_PATH = `${process.env.HOME}/.claude/PAI/MEMORY/STATE/parlay-agents.json`
const LIST_SCRIPT = `${import.meta.dir}/herdr-channel-list.ts`

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentInfo {
  id: string
  name: string
  color: string
  nicknames?: string[]
}

interface SnapshotTab  { tab_id: string; label: string; focused?: boolean }
interface SnapshotPane { pane_id: string; tab_id: string; focused?: boolean }
interface Snapshot     { tabs: SnapshotTab[]; panes?: SnapshotPane[] }

interface AgentPin { pane_id: string; tab_id: string; created_at: string }
interface AgentPinsListResponse { pins?: AgentPin[] }

interface WezPane { pane_id: number; tab_id: number; title: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadAgents(): AgentInfo[] {
  try {
    return JSON.parse(require("fs").readFileSync(PARLAY_AGENTS_PATH, "utf-8")) as AgentInfo[]
  } catch { return [] }
}

async function fetchSnapshot(): Promise<Snapshot> {
  try {
    const r = await fetch(`${BRIDGE_URL}/api/snapshot`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return { tabs: [], panes: [] }
    const snap = (await r.json()) as Snapshot
    return { tabs: snap.tabs ?? [], panes: snap.panes ?? [] }
  } catch { return { tabs: [], panes: [] } }
}

async function fetchTabs(): Promise<SnapshotTab[]> {
  return (await fetchSnapshot()).tabs
}

async function fetchPins(): Promise<AgentPin[]> {
  try {
    const r = await fetch(`${BRIDGE_URL}/api/agent-pins`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return []
    return ((await r.json()) as AgentPinsListResponse).pins ?? []
  } catch { return [] }
}

function wezRun(...args: string[]): string {
  const r = Bun.spawnSync(["wezterm", "cli", ...args], { stderr: "ignore" })
  return r.stdout.toString().trim()
}

function listWezPanes(): WezPane[] {
  try {
    return JSON.parse(wezRun("list", "--format", "json")) as WezPane[]
  } catch { return [] }
}

// Matches the herdr split-panel separator (▕ or «) followed by │ and the
// Claude Code input prompt character (❯), then captures the typed content.
const HERDR_INPUT_RE = /[▕«]│\s*❯\s*(.*)/

function getPaneCommandLine(paneId: number): string {
  const text = wezRun("get-text", "--pane-id", String(paneId))
  const lines = text.split("\n")

  // Herdr panes: Claude Code input box is on the ❯ line inside the right panel.
  // The cursor ends up on the status bar after each repaint, so cursorLine() is wrong.
  // Scan ALL lines for the │❯ separator pattern and extract right-panel content.
  for (const line of lines) {
    const m = line.match(HERDR_INPUT_RE)
    if (m) {
      const content = m[1].trim()
      if (content && isWatchedLine(content)) return content
    }
  }

  // Shell panes: scan bottom 5 lines for a direct command match.
  const bottom = lines.slice(-5)
  for (let i = bottom.length - 1; i >= 0; i--) {
    const t = bottom[i].trim()
    if (t && isWatchedLine(t)) return t
  }
  return ""
}

function sendCtrlU(paneId: number) {
  const proc = Bun.spawn(
    ["wezterm", "cli", "send-text", "--pane-id", String(paneId), "--no-paste"],
    { stdin: Buffer.from("\x15"), stderr: "ignore" },
  )
  proc.exited.catch(() => {})
}

// ── Name resolution ───────────────────────────────────────────────────────────

function resolveTab(
  name: string,
  agents: AgentInfo[],
  tabs: SnapshotTab[],
): SnapshotTab | null {
  const n = name.toLowerCase().trim()

  // 1. Exact Parlay agent id → match herdr tab whose label == agent id
  const byId = agents.find(a => a.id.toLowerCase() === n)
  if (byId) {
    const tab = tabs.find(t => t.label.toLowerCase() === byId.id.toLowerCase())
    if (tab) return tab
  }

  // 2. Parlay nickname → agent id → tab label
  for (const agent of agents) {
    if (agent.nicknames?.some(nick => nick.toLowerCase() === n)) {
      const tab = tabs.find(t => t.label.toLowerCase() === agent.id.toLowerCase())
      if (tab) return tab
    }
  }

  // 3. Exact tab label match
  const exact = tabs.find(t => t.label.toLowerCase() === n)
  if (exact) return exact

  // 4. Substring tab label match
  return tabs.find(t => t.label.toLowerCase().includes(n)) ?? null
}

// ── Focus action ──────────────────────────────────────────────────────────────

async function focusChannel(tabId: string) {
  // Activate the herdr WezTerm tab (lowest tab_id titled "herdr")
  const panes = listWezPanes()
  const herdrPane = panes
    .filter(p => p.title.toLowerCase() === "herdr")
    .sort((a, b) => a.tab_id - b.tab_id)[0]

  if (herdrPane) {
    wezRun("activate-tab", "--tab-id", String(herdrPane.tab_id))
  }

  // Focus the herdr-internal tab via bridge API
  try {
    await fetch(`${BRIDGE_URL}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tab.focus", params: { tab_id: tabId } }),
      signal: AbortSignal.timeout(2000),
    })
  } catch { /* bridge unreachable — WezTerm switch still happened */ }
}

// ── Pin cycling ───────────────────────────────────────────────────────────────

async function focusPinned(direction: "next" | "prev"): Promise<boolean> {
  const [snapshot, pins] = await Promise.all([fetchSnapshot(), fetchPins()])
  if (pins.length === 0) {
    process.stderr.write(`[herdr-channel] no pinned tabs\n`)
    return false
  }

  // Pins are per-pane and ordered by creation time. Map to still-open tabs,
  // dedupe by tab_id (a pane can be re-pinned), keep pin order.
  const openTabIds = new Set(snapshot.tabs.map(t => t.tab_id))
  const pinnedTabIds: string[] = []
  for (const pin of pins) {
    if (openTabIds.has(pin.tab_id) && !pinnedTabIds.includes(pin.tab_id)) {
      pinnedTabIds.push(pin.tab_id)
    }
  }
  if (pinnedTabIds.length === 0) {
    process.stderr.write(`[herdr-channel] no pinned tabs still open\n`)
    return false
  }

  const currentTabId =
    snapshot.tabs.find(t => t.focused)?.tab_id ??
    snapshot.panes?.find(p => p.focused)?.tab_id ??
    null

  const currentIdx = currentTabId ? pinnedTabIds.indexOf(currentTabId) : -1
  const targetIdx =
    currentIdx === -1
      ? 0
      : (currentIdx + (direction === "next" ? 1 : -1) + pinnedTabIds.length) % pinnedTabIds.length

  const targetTabId = pinnedTabIds[targetIdx]
  const targetTab = snapshot.tabs.find(t => t.tab_id === targetTabId)
  process.stderr.write(`[herdr-channel] pin ${direction} → ${targetTab?.label ?? targetTabId}\n`)
  await focusChannel(targetTabId)
  return true
}

// ── List picker launchers ─────────────────────────────────────────────────────

function launchPicker(mode: "split" | "full" | "cards", filter: "all" | "active", sourcePaneId: number) {
  const BUN = process.execPath  // full path — safe under launchd minimal PATH
  const args = [
    BUN, LIST_SCRIPT,
    "--mode", mode,
    "--filter", filter,
    "--source-pane", String(sourcePaneId),
    "--bridge-url", BRIDGE_URL,
  ]

  if (mode === "split") {
    // C — split current pane, picker appears below
    Bun.spawn(
      ["wezterm", "cli", "split-pane", "--pane-id", String(sourcePaneId),
       "--bottom", "--percent", "40", "--", ...args],
      { stderr: "ignore" },
    )
  } else {
    // A/B — spawn a new WezTerm tab
    Bun.spawn(
      ["wezterm", "cli", "spawn", "--", ...args],
      { stderr: "ignore" },
    )
  }
}

// ── Command parser ────────────────────────────────────────────────────────────

const CMD_RE = /\bchannel\s+(list(?:\s+\S+)*|\S+)/i
const PIN_CMD_RE = /\bpin\s+(next|prev|previous)\b/i

function isWatchedLine(text: string): boolean {
  return CMD_RE.test(text) || PIN_CMD_RE.test(text)
}

async function handleLine(line: string, sourcePaneId: number): Promise<boolean> {
  line = line.trim()

  const pinMatch = line.match(PIN_CMD_RE)
  if (pinMatch) {
    const direction = pinMatch[1].toLowerCase() === "next" ? "next" : "prev"
    const fired = await focusPinned(direction)
    if (fired && sourcePaneId >= 0) sendCtrlU(sourcePaneId)
    return fired
  }

  const m = line.match(CMD_RE)
  if (!m) return false

  const arg = m[1].trim().toLowerCase()

  if (arg === "list")               { launchPicker("split", "all",    sourcePaneId); return true }
  if (arg === "list active")        { launchPicker("split", "active", sourcePaneId); return true }
  if (arg === "list full")          { launchPicker("full",  "all",    sourcePaneId); return true }
  if (arg === "list cards")         { launchPicker("cards", "all",    sourcePaneId); return true }
  if (arg === "list full active")   { launchPicker("full",  "active", sourcePaneId); return true }
  if (arg === "list cards active")  { launchPicker("cards", "active", sourcePaneId); return true }

  // Direct jump
  const agents = loadAgents()
  const tabs   = await fetchTabs()
  const tab    = resolveTab(arg, agents, tabs)

  if (!tab) {
    process.stderr.write(`[herdr-channel] no tab matching "${arg}"\n`)
    return false
  }

  process.stderr.write(`[herdr-channel] → ${tab.label} (${tab.tab_id})\n`)
  await focusChannel(tab.tab_id)
  if (sourcePaneId >= 0) sendCtrlU(sourcePaneId)
  return true
}

// ── Pane watcher ──────────────────────────────────────────────────────────────

const lastLine   = new Map<number, string>()    // pane_id → last seen line
const debounce   = new Map<number, Timer>()     // pane_id → pending timer
const cooldown   = new Set<number>()            // pane_id → just fired, skip next cycle

function watchPane(paneId: number) {
  const line = getPaneCommandLine(paneId)
  const prev = lastLine.get(paneId) ?? ""

  if (line === prev) return
  lastLine.set(paneId, line)

  // Clear any existing debounce
  const existing = debounce.get(paneId)
  if (existing) clearTimeout(existing)

  // Don't re-fire immediately after a ctrl-u clear
  if (cooldown.has(paneId)) return

  debounce.set(paneId, setTimeout(async () => {
    debounce.delete(paneId)
    // Re-read at fire time — debounce window may have changed things
    const current = getPaneCommandLine(paneId)
    const fired = await handleLine(current, paneId)
    if (fired) {
      cooldown.add(paneId)
      setTimeout(() => cooldown.delete(paneId), 1500)
    }
  }, DEBOUNCE_MS))
}

// ── Herdr pane watcher (subprocess → herdr-input-watch JSON stream) ───────────
// herdr-input-watch.ts speaks WebSocket VT100 to each herdr pane and emits
// {type:"input_changed", pane_id, input} on stdout. We consume that stream so
// commands typed inside herdr terminals (not just bare WezTerm panes) are caught.

const INPUT_WATCH_SCRIPT = `${import.meta.dir}/herdr-input-watch.ts`

const herdrLastLine = new Map<string, string>()
const herdrDebounce = new Map<string, Timer>()
const herdrCooldown = new Set<string>()

function handleHerdrInput(paneId: string, rawInput: string) {
  const line = rawInput.trim()
  const prev = herdrLastLine.get(paneId) ?? ""
  if (line === prev) return
  herdrLastLine.set(paneId, line)

  const existing = herdrDebounce.get(paneId)
  if (existing) clearTimeout(existing)
  if (herdrCooldown.has(paneId)) return

  herdrDebounce.set(paneId, setTimeout(async () => {
    herdrDebounce.delete(paneId)
    const fired = await handleLine(line, -1)  // -1 = no WezTerm pane to ctrl-u
    if (fired) {
      herdrCooldown.add(paneId)
      setTimeout(() => herdrCooldown.delete(paneId), 1500)
    }
  }, DEBOUNCE_MS))
}

function watchHerdr() {
  const proc = Bun.spawn(
    [process.execPath, INPUT_WATCH_SCRIPT, BRIDGE_URL],
    { stdout: "pipe", stderr: "pipe" },
  )

  let buf = ""
  const decoder = new TextDecoder()

  async function drain() {
    const reader = proc.stdout.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""
        for (const raw of lines) {
          if (!raw.trim()) continue
          try {
            const ev = JSON.parse(raw)
            if (ev.type === "input_changed" && typeof ev.input === "string") {
              handleHerdrInput(String(ev.pane_id), ev.input)
            }
          } catch { /* malformed JSON */ }
        }
      }
    } catch { /* stream closed */ }
    // Reconnect after herdr-input-watch exits
    setTimeout(watchHerdr, 3000)
  }

  drain()
  // Forward herdr-input-watch stderr so startup errors are visible
  ;(async () => {
    const r = proc.stderr.getReader()
    const dec = new TextDecoder()
    while (true) {
      const { value, done } = await r.read()
      if (done) break
      process.stderr.write(`[herdr-input-watch] ${dec.decode(value)}`)
    }
  })()
  process.stderr.write(`[herdr-channel] herdr-input-watch started\n`)
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let paneIds: number[] = []
let lineTimers: Timer[] = []

function refreshPanes() {
  paneIds = listWezPanes().map(p => p.pane_id)
}

function startPolling() {
  for (const t of lineTimers) clearInterval(t)
  lineTimers = paneIds.map(id =>
    setInterval(() => watchPane(id), POLL_LINE_MS),
  )
}

// ── Match mode: bun herdr-channel.ts --match <text> ───────────────────────────
// Exits 0 and prints the extracted name if text matches the channel rule.
// Exits 1 silently if no match. Useful for Talon / external callers.
const matchIdx = process.argv.indexOf("--match")
if (matchIdx >= 0) {
  const input = process.argv[matchIdx + 1] ?? ""
  const m = input.trim().match(CMD_RE)
  if (m?.[1]) { process.stdout.write(m[1].trim() + "\n"); process.exit(0) }
  process.exit(1)
}

// ── Would-fire mode: bun herdr-channel.ts --would-fire <text> ────────────────
// Exits 0 if <text> contains "channel <name>" AND <name> resolves to an open tab.
// This is the exact condition the daemon uses to decide whether to act.
const wfIdx = process.argv.indexOf("--would-fire")
if (wfIdx >= 0) {
  const text = process.argv[wfIdx + 1] ?? ""
  const m = text.trim().match(CMD_RE)
  if (!m?.[1]) process.exit(1)
  const name = m[1].trim()
  // list commands always fire — no tab resolution needed
  if (name.startsWith("list")) { process.stdout.write(name + "\n"); process.exit(0) }
  const agents = loadAgents()
  const tabs   = await fetchTabs()
  const tab    = resolveTab(name, agents, tabs)
  if (tab) { process.stdout.write(`${name} → ${tab.tab_id}\n`); process.exit(0) }
  process.exit(1)
}

// ── Exists mode: bun herdr-channel.ts --exists <name> ────────────────────────
// Exits 0 (and prints resolved tab_id) if <name> resolves to an open herdr tab.
// Exits 1 silently if not. Fast check for Talon / external callers.
const existsIdx = process.argv.indexOf("--exists")
if (existsIdx >= 0) {
  const name = process.argv[existsIdx + 1] ?? ""
  const agents = loadAgents()
  const tabs   = await fetchTabs()
  const tab    = resolveTab(name, agents, tabs)
  if (tab) { process.stdout.write(tab.tab_id + "\n"); process.exit(0) }
  process.exit(1)
}

// ── Direct switch mode: bun herdr-channel.ts --switch <name> ──────────────────
const switchIdx = process.argv.indexOf("--switch")
if (switchIdx >= 0) {
  const name = process.argv[switchIdx + 1]
  if (!name) { process.stderr.write("Usage: --switch <name>\n"); process.exit(1) }
  const agents = loadAgents()
  const tabs   = await fetchTabs()
  const tab    = resolveTab(name, agents, tabs)
  if (!tab) {
    process.stderr.write(`no tab matching "${name}"\ntabs: ${tabs.map(t => t.label).join(", ")}\n`)
    process.exit(1)
  }
  process.stdout.write(`→ ${tab.label} (${tab.tab_id})\n`)
  await focusChannel(tab.tab_id)
  process.exit(0)
}

// ── Pin cycle mode: bun herdr-channel.ts --pin next|prev ──────────────────────
const pinIdx = process.argv.indexOf("--pin")
if (pinIdx >= 0) {
  const arg = (process.argv[pinIdx + 1] ?? "next").toLowerCase()
  const direction = arg === "prev" || arg === "previous" ? "prev" : "next"
  const fired = await focusPinned(direction)
  process.exit(fired ? 0 : 1)
}

// ── Daemon mode ────────────────────────────────────────────────────────────────
refreshPanes()
startPolling()
setInterval(() => { refreshPanes(); startPolling() }, POLL_PANES_MS)
watchHerdr()

process.stderr.write(
  `[herdr-channel] watching ${paneIds.length} WezTerm pane(s) + herdr · debounce=${DEBOUNCE_MS}ms · bridge=${BRIDGE_URL}\n`,
)

// Keep alive
setInterval(() => {}, 60_000)

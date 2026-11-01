#!/usr/bin/env bun
// herdr-channel-list — picker UI for "channel list" commands.
//
// Args:
//   --mode   <split|full|cards>   UI mode
//   --filter <all|active>         which tabs to show
//   --source-pane <id>            WezTerm pane that triggered the command
//   --bridge-url <url>            herdr bridge
//
// Modes:
//   split  (C) — fzf in current pane (spawned into a split); closes pane on select
//   full   (A) — fzf full-screen in new tab; closes tab on select
//   cards  (B) — custom box-drawing TUI, one card per agent; closes tab on select

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string, fallback = ""): string {
  const idx = process.argv.indexOf(name)
  return idx >= 0 ? (process.argv[idx + 1] ?? fallback) : fallback
}

const MODE        = arg("--mode",        "split") as "split" | "full" | "cards"
const FILTER      = arg("--filter",      "all")   as "all" | "active"
const SOURCE_PANE = parseInt(arg("--source-pane", "-1"))
const BRIDGE_URL  = arg("--bridge-url",  "http://localhost:8787")
const PULSE_URL   = "http://localhost:31337"
const MY_PANE_ID  = parseInt(process.env.WEZTERM_PANE ?? "-1")

const PARLAY_AGENTS_PATH = `${process.env.HOME}/.claude/PAI/MEMORY/STATE/parlay-agents.json`

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentInfo {
  id: string; name: string; color: string; nicknames?: string[]
}

interface SnapshotTab { tab_id: string; label: string }

interface PresenceEntry {
  channel: string
  name?: string
  color?: string
  status: "listening" | "idle" | "offline"
  listening: boolean
}

interface Channel {
  tab_id: string
  label:  string
  agent:  AgentInfo | null
  status: "listening" | "idle" | "offline"
}

// ── Data fetching ─────────────────────────────────────────────────────────────

function loadAgents(): AgentInfo[] {
  try {
    return JSON.parse(require("fs").readFileSync(PARLAY_AGENTS_PATH, "utf-8")) as AgentInfo[]
  } catch { return [] }
}

async function fetchTabs(): Promise<SnapshotTab[]> {
  try {
    const r = await fetch(`${BRIDGE_URL}/api/snapshot`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return []
    return ((await r.json()) as { tabs: SnapshotTab[] }).tabs ?? []
  } catch { return [] }
}

async function fetchPresence(): Promise<Map<string, PresenceEntry>> {
  const map = new Map<string, PresenceEntry>()
  try {
    const r = await fetch(`${PULSE_URL}/api/chat/subscribers`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) return map
    const body = await r.json() as { presence: PresenceEntry[] }
    for (const p of body.presence ?? []) map.set(p.channel, p)
  } catch { /* Pulse offline — all show as offline */ }
  return map
}

async function buildChannels(): Promise<Channel[]> {
  const [tabs, agents, presence] = await Promise.all([fetchTabs(), Promise.resolve(loadAgents()), fetchPresence()])

  const channels: Channel[] = tabs.map(tab => {
    const agent = agents.find(a => a.id.toLowerCase() === tab.label.toLowerCase()) ?? null
    const pres  = presence.get(tab.label) ?? presence.get(tab.label.toLowerCase())
    return {
      tab_id: tab.tab_id,
      label:  tab.label,
      agent,
      status: (pres?.status ?? "offline") as "listening" | "idle" | "offline",
    }
  })

  if (FILTER === "active") {
    return channels.filter(c => c.status === "listening" || c.status === "idle")
  }
  return channels
}

// ── Focus action ──────────────────────────────────────────────────────────────

function wezRun(...args: string[]) {
  Bun.spawnSync(["wezterm", "cli", ...args], { stderr: "ignore" })
}

async function focusChannel(tabId: string) {
  // Bring herdr WezTerm tab to front
  const panes = JSON.parse(
    Bun.spawnSync(["wezterm", "cli", "list", "--format", "json"], { stderr: "ignore" }).stdout.toString()
  ) as { pane_id: number; tab_id: number; title: string }[]

  const herdr = panes
    .filter(p => p.title.toLowerCase() === "herdr")
    .sort((a, b) => a.tab_id - b.tab_id)[0]
  if (herdr) wezRun("activate-tab", "--tab-id", String(herdr.tab_id))

  // Focus internal herdr tab
  try {
    await fetch(`${BRIDGE_URL}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tab.focus", params: { tab_id: tabId } }),
      signal: AbortSignal.timeout(2000),
    })
  } catch { /* bridge unreachable */ }

  // Clear the source pane's input line
  if (SOURCE_PANE >= 0) {
    const proc = Bun.spawn(
      ["wezterm", "cli", "send-text", "--pane-id", String(SOURCE_PANE), "--no-paste"],
      { stdin: Buffer.from("\x15"), stderr: "ignore" },
    )
    await proc.exited.catch(() => {})
  }

  // Close this picker pane
  if (MY_PANE_ID >= 0) {
    wezRun("kill-pane", "--pane-id", String(MY_PANE_ID))
  }
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const R    = "\x1b[0m"
const B    = "\x1b[1m"
const D    = "\x1b[2m"
const REV  = "\x1b[7m"

function hexToAnsi(hex: string): string {
  // True-color foreground: ESC[38;2;R;G;Bm
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const bl = parseInt(h.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(bl)) return ""
  return `\x1b[38;2;${r};${g};${bl}m`
}

function hexToBgAnsi(hex: string): string {
  const h = hex.replace("#", "")
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const bl = parseInt(h.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(bl)) return ""
  return `\x1b[48;2;${r};${g};${bl}m`
}

function statusDot(status: string): string {
  if (status === "listening") return `\x1b[32m●${R}` // green
  if (status === "idle")      return `\x1b[33m○${R}` // yellow
  return `\x1b[90m·${R}`                              // gray offline
}

function statusLabel(status: string): string {
  if (status === "listening") return `\x1b[32mlistening${R}`
  if (status === "idle")      return `\x1b[33midle${R}`
  return `\x1b[90moffline${R}`
}

// ── Mode A / C — fzf ─────────────────────────────────────────────────────────
// Used for "split" (C) and "full" (A) — difference is just the pane context.

async function runFzf(channels: Channel[]) {
  // Build ANSI-colored entries: "<tab_id>\t<display line>"
  // tab_id is hidden via fzf --with-nth, display is what the user sees.
  const entries = channels.map(ch => {
    const color = ch.agent?.color ?? "#6b7280"
    const dot   = statusDot(ch.status)
    const slab  = statusLabel(ch.status)
    const nick  = ch.agent?.nicknames?.length
      ? `  ${D}(${ch.agent.nicknames.join(", ")})${R}`
      : ""
    const block = `${hexToAnsi(color)}█${R}`
    const name  = `${B}${ch.label}${R}`
    return `${ch.tab_id}\t${block}  ${name}  ${dot} ${slab}${nick}`
  })

  if (entries.length === 0) {
    process.stderr.write("[herdr-channel-list] no channels available\n")
    process.exit(0)
  }

  const header = FILTER === "active"
    ? "ACTIVE CHANNELS — ↑↓ navigate  Enter select  Esc cancel"
    : "ALL CHANNELS — ↑↓ navigate  Enter select  Esc cancel"

  // Rose-pine moon colors
  const fzfColors = [
    "--color=bg:#1e1e2e,bg+:#313244",
    "--color=fg:#cdd6f4,fg+:#cdd6f4",
    "--color=hl:#89b4fa,hl+:#89b4fa",
    "--color=info:#94e2d5,prompt:#cba6f7",
    "--color=pointer:#f38ba8,marker:#f38ba8",
    "--color=spinner:#f38ba8,header:#89b4fa",
    "--color=border:#45475a",
  ]

  const proc = Bun.spawn(
    [
      "fzf",
      "--ansi",
      "--delimiter", "\t",
      "--with-nth", "2..",        // hide tab_id column from display
      "--height", "100%",
      "--border", "rounded",
      "--border-label", `  herdr channels  `,
      "--border-label-pos", "3",
      "--prompt", "  channel › ",
      "--pointer", "▶",
      "--header", header,
      "--header-first",
      "--no-sort",
      ...fzfColors,
    ],
    {
      stdin:  Buffer.from(entries.join("\n")),
      stdout: "pipe",
      stderr: "inherit",
    },
  )

  const out    = await new Response(proc.stdout).text()
  const code   = await proc.exited
  if (code !== 0 || !out.trim()) process.exit(0)   // cancelled

  const tabId  = out.trim().split("\t")[0]
  const ch     = channels.find(c => c.tab_id === tabId)
  if (!ch) process.exit(0)

  process.stderr.write(`[herdr-channel-list] → ${ch.label}\n`)
  await focusChannel(ch.tab_id)
}

// ── Mode B — custom card TUI ──────────────────────────────────────────────────

async function runCards(channels: Channel[]) {
  if (channels.length === 0) {
    process.stdout.write("\x1b[2J\x1b[H  No channels available.\n")
    await Bun.sleep(1500)
    if (MY_PANE_ID >= 0) Bun.spawnSync(["wezterm", "cli", "kill-pane", "--pane-id", String(MY_PANE_ID)])
    process.exit(0)
  }

  let cursor = 0
  const readline = await import("readline")

  function draw() {
    const cols = process.stdout.columns || 80
    const out: string[] = []
    out.push("\x1b[2J\x1b[H")  // clear + home

    const title = `  ${B}CHANNELS${R}  ${D}↑↓ move  Enter select  Esc cancel${R}`
    out.push(title)
    out.push("")

    for (let i = 0; i < channels.length; i++) {
      const ch  = channels[i]
      const sel = i === cursor
      const color = ch.agent?.color ?? "#6b7280"

      // Card top border
      const cardW = Math.min(cols - 4, 60)
      const border = sel ? `${hexToAnsi(color)}` : `\x1b[90m`

      const topLine = `${border}╭${"─".repeat(cardW - 2)}╮${R}`
      const botLine = `${border}╰${"─".repeat(cardW - 2)}╯${R}`

      // Card content
      const dot    = statusDot(ch.status)
      const slab   = statusLabel(ch.status)
      const nick   = ch.agent?.nicknames?.length
        ? ch.agent.nicknames.join(", ")
        : ""

      const namePart = sel
        ? `${hexToBgAnsi(color)}\x1b[30m  ${ch.label.padEnd(20)}  ${R}`
        : `  ${B}${hexToAnsi(color)}${ch.label}${R}  `

      const statusPart = `${dot} ${slab}`
      const nickPart   = nick ? `  ${D}${nick}${R}` : ""

      const inner = `${border}│${R} ${namePart}${statusPart}${nickPart}`
      // pad to cardW
      const stripped = ch.label.padEnd(20) + "  " + ch.status + (nick ? "  " + nick : "")
      const padLen   = Math.max(0, cardW - 2 - stripped.length - 2)
      const rowLine  = inner + " ".repeat(padLen) + `${border} │${R}`

      out.push(`  ${topLine}`)
      out.push(`  ${rowLine}`)
      out.push(`  ${botLine}`)
      out.push("")
    }

    process.stdout.write(out.join("\n"))
  }

  process.stdout.write("\x1b[?25l")  // hide cursor
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) process.stdin.setRawMode(true)

  draw()

  process.stdin.on("keypress", async (_: unknown, key: { name?: string; ctrl?: boolean }) => {
    if (!key) return
    if (key.name === "escape" || (key.ctrl && key.name === "c")) {
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H")
      if (MY_PANE_ID >= 0) Bun.spawnSync(["wezterm", "cli", "kill-pane", "--pane-id", String(MY_PANE_ID)])
      process.exit(0)
    }
    if (key.name === "up"   && cursor > 0)                   cursor--
    if (key.name === "down" && cursor < channels.length - 1) cursor++
    if (key.name === "return") {
      const ch = channels[cursor]
      process.stdout.write("\x1b[?25h\x1b[2J\x1b[H")
      process.stderr.write(`[herdr-channel-list] → ${ch.label}\n`)
      await focusChannel(ch.tab_id)
      process.exit(0)
    }
    draw()
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────

const channels = await buildChannels()

if (MODE === "cards") {
  await runCards(channels)
} else {
  await runFzf(channels)
}

#!/usr/bin/env bun
// herdr-channel-health — component checks + live end-to-end detection test.
//
// Usage:
//   bun herdr-channel-health.ts          # all checks including E2E
//   bun herdr-channel-health.ts --static # component checks only (no text injection)

const BRIDGE_URL = "http://localhost:8787"
const PULSE_URL  = "http://localhost:31337"
const PARLAY_AGENTS_PATH = `${process.env.HOME}/.claude/PAI/MEMORY/STATE/parlay-agents.json`
const CMD_RE = /\bchannel\s+(list(?:\s+\S+)*|\S+)/i
const STATIC_ONLY = process.argv.includes("--static")

let pass = 0, fail = 0, skip = 0

function ok(label: string, detail = "")   { console.log(`  ✅  ${label}${detail ? "  →  " + detail : ""}`); pass++ }
function ko(label: string, detail = "")   { console.log(`  ❌  ${label}${detail ? "  →  " + detail : ""}`); fail++ }
function sk(label: string, detail = "")   { console.log(`  ⏭️   ${label}${detail ? "  →  " + detail : ""}`); skip++ }
function section(t: string)               { console.log(`\n── ${t}`) }

function wezRun(...args: string[]): string {
  return Bun.spawnSync(["wezterm", "cli", ...args], { stderr: "ignore" }).stdout.toString().trim()
}

async function fetchJSON<T>(url: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000), ...opts })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as T
}

// ── 1. Daemon ─────────────────────────────────────────────────────────────────
section("Daemon")

const daemonLines = Bun.spawnSync(["pgrep", "-fl", "herdr-channel.ts"], { stderr: "ignore" })
  .stdout.toString().split("\n")
  .filter(l => l.includes("herdr-channel.ts") && !l.includes("health"))
if (daemonLines.length > 0) {
  ok("daemon running", daemonLines[0].trim().slice(0, 60))
} else {
  ko("daemon NOT running", "start: bun cli/herdr-channel.ts &")
}

const watchLines = Bun.spawnSync(["pgrep", "-fl", "herdr-input-watch"], { stderr: "ignore" })
  .stdout.toString().trim()
if (watchLines.includes("herdr-input-watch")) {
  ok("herdr-input-watch subprocess running")
} else {
  ko("herdr-input-watch subprocess NOT running", "daemon failed to spawn it or crashed")
}

// ── 2. WezTerm ────────────────────────────────────────────────────────────────
section("WezTerm")

let panes: { pane_id: number; tab_id: number; title: string }[] = []
try {
  panes = JSON.parse(wezRun("list", "--format", "json"))
  ok(`wezterm cli reachable`, `${panes.length} pane(s)`)
} catch {
  ko("wezterm cli list failed")
}

// Find a shell pane for E2E injection (titled "~", not herdr)
const shellPane = panes.find(p => p.title === "~")
if (shellPane) {
  const lastLine = wezRun("get-text", "--pane-id", String(shellPane.pane_id))
    .split("\n").filter(l => l.trim()).at(-1)?.trim() ?? ""
  ok(`shell pane available for E2E test`, `pane ${shellPane.pane_id} — last line: ${JSON.stringify(lastLine.slice(0, 40))}`)
} else {
  ko("no shell pane found (need a bare '~' terminal for E2E injection)")
}

// ── 3. Bridge ─────────────────────────────────────────────────────────────────
section("herdr bridge")

let tabs: { tab_id: string; label: string; focused: boolean }[] = []
try {
  const snap = await fetchJSON<{ tabs: typeof tabs }>(`${BRIDGE_URL}/api/snapshot`)
  tabs = snap.tabs ?? []
  ok(`bridge reachable`, `${tabs.length} tab(s)`)
} catch (e) {
  ko(`bridge unreachable`, (e as Error).message)
}

// ── 4. Agents ─────────────────────────────────────────────────────────────────
section("Parlay agents")

let agents: { id: string; name: string; color: string; nicknames?: string[] }[] = []
try {
  agents = JSON.parse(require("fs").readFileSync(PARLAY_AGENTS_PATH, "utf-8"))
  ok("agents file readable", `${agents.length} agent(s)`)
} catch {
  ko("cannot read parlay-agents.json", PARLAY_AGENTS_PATH)
}

// ── 5. Name resolution ────────────────────────────────────────────────────────
section("Name resolution — 'fable'")

const TARGET = "fable"
const agentMatch = agents.find(a => a.id.toLowerCase() === TARGET)
agentMatch ? ok("Parlay agent found", `id=${agentMatch.id} color=${agentMatch.color}`)
           : ko(`no Parlay agent with id "${TARGET}"`)

const tabMatch = tabs.find(t => t.label.toLowerCase() === TARGET)
tabMatch ? ok("herdr tab found", `tab_id=${tabMatch.tab_id}`)
         : ko(`no herdr tab labelled "${TARGET}"`, `tabs: ${tabs.map(t => t.label).join(", ")}`)

// ── 6. Regex ──────────────────────────────────────────────────────────────────
section("Regex (CMD_RE)")

const regexTests: [string, string][] = [
  ["channel fable",          "fable"],
  ["Channel fable",          "fable"],
  ["Channel Fable",          "Fable"],
  ["➜  channel fable",       "fable"],
  ["❯  channel list",        "list"],
  ["❯  channel list active", "list active"],
  ["❯  channel list full",   "list full"],
  [" channel fable",         "fable"],
]
let regexOk = true
for (const [input, expected] of regexTests) {
  const m = input.trim().match(CMD_RE)
  if (m?.[1]?.trim().toLowerCase() !== expected.toLowerCase()) {
    ko(`regex mismatch: ${JSON.stringify(input)} → got "${m?.[1] ?? "NO MATCH"}" want "${expected}"`)
    regexOk = false
  }
}
if (regexOk) ok(`all ${regexTests.length} regex variants match`)

// ── 7. tab.focus API ─────────────────────────────────────────────────────────
section("Bridge tab.focus API")

if (tabMatch) {
  try {
    const resp = await fetchJSON<{ tab?: { focused?: boolean }; error?: string }>(
      `${BRIDGE_URL}/api/command`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "tab.focus", params: { tab_id: tabMatch.tab_id } }),
      },
    )
    resp.tab?.focused ? ok("tab.focus API works", `fable focused=true`)
                      : ko("tab.focus returned unexpected response", JSON.stringify(resp).slice(0, 80))
  } catch (e) {
    ko("tab.focus request failed", (e as Error).message)
  }
} else {
  sk("tab.focus skipped — no fable tab")
}

// ── 8. Pulse presence ─────────────────────────────────────────────────────────
section("Pulse presence (optional)")

try {
  const body = await fetchJSON<{ presence: { channel: string; status: string }[] }>(`${PULSE_URL}/api/chat/subscribers`)
  ok("Pulse reachable", `${body.presence?.length ?? 0} presence entries`)
} catch {
  ok("Pulse offline (non-critical)", "channels will show as 'offline' in picker")
}

// ── 9. E2E detection test ─────────────────────────────────────────────────────
section("E2E detection — inject 'channel fable' into shell pane")

if (STATIC_ONLY) {
  sk("skipped (--static flag)")
} else if (!shellPane) {
  sk("skipped — no shell pane available")
} else if (!tabMatch) {
  sk("skipped — fable tab not found")
} else if (daemonLines.length === 0) {
  sk("skipped — daemon not running")
} else {
  // Switch to a non-fable tab first so we can detect the daemon switching back
  const nonTarget = tabs.find(t => t.label.toLowerCase() !== TARGET)
  if (nonTarget) {
    await fetch(`${BRIDGE_URL}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "tab.focus", params: { tab_id: nonTarget.tab_id } }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {})
    await Bun.sleep(150)
  }

  // Record current focused tab so we can detect a change
  const beforeSnap = await fetchJSON<{ tabs: typeof tabs }>(`${BRIDGE_URL}/api/snapshot`)
  const before = beforeSnap.tabs.find(t => t.focused)?.label ?? "(none)"

  // Inject "channel fable" into the shell pane (no Enter)
  const injected = "channel fable"
  const sendProc = Bun.spawn(
    ["wezterm", "cli", "send-text", "--pane-id", String(shellPane.pane_id), "--no-paste"],
    { stdin: Buffer.from(injected), stderr: "ignore" },
  )
  await sendProc.exited

  // Wait for debounce (400ms) + poll cycle (200ms) + bridge round-trip (100ms)
  await Bun.sleep(800)

  // Read what the pane actually contains now (daemon should have seen it)
  const paneLastLine = wezRun("get-text", "--pane-id", String(shellPane.pane_id))
    .split("\n").filter(l => l.trim()).at(-1)?.trim() ?? ""

  // Check if fable is now focused
  const afterSnap = await fetchJSON<{ tabs: typeof tabs }>(`${BRIDGE_URL}/api/snapshot`)
  const after = afterSnap.tabs.find(t => t.focused)?.label ?? "(none)"
  const fableNowFocused = afterSnap.tabs.find(t => t.label === TARGET)?.focused ?? false

  if (fableNowFocused) {
    ok(`detection fired — fable is now focused`, `was: ${before} → now: ${after}`)
  } else {
    ko(`detection did NOT fire`, `focused before: ${before}, after: ${after} | pane last line: ${JSON.stringify(paneLastLine.slice(0, 60))}`)
  }

  // Cleanup: ctrl-u to clear the injected text from the shell pane
  const cleanProc = Bun.spawn(
    ["wezterm", "cli", "send-text", "--pane-id", String(shellPane.pane_id), "--no-paste"],
    { stdin: Buffer.from("\x15"), stderr: "ignore" },
  )
  await cleanProc.exited
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n── Summary  ${pass} passed · ${fail} failed · ${skip} skipped\n`)
process.exit(fail > 0 ? 1 : 0)

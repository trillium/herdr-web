#!/usr/bin/env bash
#
# Scripted end-to-end for the voice submit leg against an isolated local bridge.
#
# Boots a throwaway bridge on 127.0.0.1:<port> with `--session voice-e2e-tmp`
# (its own data dir and file log, so the live bridge and live log are
# untouched), then proves every hop of the submit leg:
#
#   1. the client-log beacon pipeline accepts every beacon kind the page beams
#      (eval-ok/fail, sse-open/drop, fallback-engaged, submit-fired/dropped,
#      ender-result) and rejects unknown kinds / bad shapes;
#   2. the beacon lines land in the bridge file log;
#   3. POST /api/command-submit validates pane_id and gates on daemon-known
#      panes (unknown panes never broadcast);
#   4. /ws/ui-events accepts subscribers (the broadcast delivery path).
#
# Daemon boundary (read-only): the bridge hard-requires a Herdr daemon at
# boot, so this script points HERDR_SOCKET_PATH at the LOCAL daemon socket for
# a boot status query and a ghost-pane negative check only. It NEVER creates
# panes, NEVER posts to a real pane (a pane-scoped POST would submit whatever
# sits in a real box), and NEVER touches the live bridge. Override with
# HERDR_SOCKET_PATH to aim at a throwaway daemon when one exists. The positive
# pane-scoped broadcast is covered by the bridge unit test
# `command_submit_broadcast_reaches_subscribers_with_request_id` and the page
# half (POST + broadcast -> guard -> submit) by
# web/src/commandSubmitEvent.test.tsx.
#
# Companion to scripts/voice-loop-trip.sh: the trip script proves the positive
# pane-scoped path against the LIVE bridge; this script proves the beacon
# pipeline, validation negatives, pane gating, and subscriber handshake against
# an ISOLATED bridge it boots and tears down itself.
#
# Usage: scripts/voice-submit-e2e.sh [--port 18987] [--bin path/to/bridge]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="18987"
BRIDGE_BIN="${BRIDGE_BIN:-$ROOT/bridge/target/debug/herdr-web-bridge}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --bin) BRIDGE_BIN="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$BRIDGE_BIN" ]] || [[ -n "$(find "$ROOT/bridge/src" "$ROOT/vendor/herdr-compat" -name '*.rs' -newer "$BRIDGE_BIN" -print -quit 2>/dev/null)" ]]; then
  echo "building bridge binary under test..." >&2
  (cd "$ROOT" && npm run bridge:build >&2)
fi

SESSION="voice-e2e-tmp"
WORK="$(mktemp -d)"
STATIC_DIR="$WORK/static"
mkdir -p "$STATIC_DIR"
BASE="http://127.0.0.1:$PORT"

SESSION_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions/$SESSION"
cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill "$BRIDGE_PID" 2>/dev/null || true
    wait "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
  # The isolated session dir only ever holds this run's log (+ the probe symlink).
  rm -rf "$SESSION_DIR"
}
trap cleanup EXIT

# Read-only daemon access for boot + the ghost-pane negative check (see header).
HERDR_SOCKET_PATH="${HERDR_SOCKET_PATH:-$HOME/.config/herdr/herdr.sock}"
export HERDR_SOCKET_PATH
if [[ ! -S "$HERDR_SOCKET_PATH" ]]; then
  echo "FAIL: no Herdr daemon socket at HERDR_SOCKET_PATH=$HERDR_SOCKET_PATH" >&2
  echo "start Herdr first, or point HERDR_SOCKET_PATH at a throwaway daemon." >&2
  exit 1
fi
# `--session` reroutes BOTH the data dir (isolated log: good) and the daemon
# socket (sessions/$SESSION/herdr.sock, nonexistent: fatal at boot). Bridge the
# gap with a symlink so the test bridge talks to the local daemon through its
# isolated session path; the daemon only ever sees read-only status/pane-list
# queries (boot check + the ghost-pane negative below). Removed on exit.
mkdir -p "$SESSION_DIR"
ln -sf "$HERDR_SOCKET_PATH" "$SESSION_DIR/herdr.sock"

"$BRIDGE_BIN" --host 127.0.0.1 --port "$PORT" --static-dir "$STATIC_DIR" \
  --session "$SESSION" >"$WORK/bridge.log" 2>&1 &
BRIDGE_PID=$!

for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "$BASE/api/health" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fs -o /dev/null "$BASE/api/health" || {
  echo "FAIL: test bridge never became healthy (see $WORK/bridge.log preserved below)" >&2
  cat "$WORK/bridge.log" >&2
  exit 1
}

export VOICE_E2E_BASE="$BASE"
export VOICE_E2E_PORT="$PORT"
node --input-type=module -e '
const base = process.env.VOICE_E2E_BASE;
let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) {
    console.log(`ok: ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${name} ${extra}`);
  }
};

const post = async (path, body) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
};

// 1. Beacon pipeline: every kind the page beams is accepted together.
const kinds = [
  ["eval-ok", undefined],
  ["eval-fail", "500"],
  ["sse-open", undefined],
  ["sse-drop", "es-closed"],
  ["fallback-engaged", "tail"],
  ["submit-fired", "parlay-ender"],
  ["submit-dropped", "stale ageMs=6123"],
  ["ender-result", "submitnow-tail-stale"],
  ["ender-result", "fallback-no-tail"],
];
const all = await post("/api/client-log", {
  events: kinds.map(([kind, detail]) => ({ kind, ...(detail ? { detail } : {}) })),
});
check("client-log accepts all beacon kinds", all.status === 200 && all.json?.received === kinds.length, JSON.stringify(all));

// 2. Unknown kinds and bad shapes are rejected, never logged.
const unknown = await post("/api/client-log", { events: [{ kind: "eval-ok\nevil" }] });
check("client-log rejects unknown kinds", unknown.status === 400, JSON.stringify(unknown));
const empty = await post("/api/client-log", { events: [] });
check("client-log rejects empty batches", empty.status === 400, JSON.stringify(empty));
const burst = await post("/api/client-log", {
  events: Array.from({ length: 33 }, () => ({ kind: "eval-ok" })),
});
check("client-log rejects oversized batches", burst.status === 400, JSON.stringify(burst));

// 3. Submit leg: pane validation runs before any broadcast.
const missing = await post("/api/command-submit", { request_id: "req-e2e-1" });
check(
  "command-submit rejects missing pane_id",
  missing.status === 400 || missing.status === 422,
  JSON.stringify(missing),
);
const blank = await post("/api/command-submit", { pane_id: "  ", request_id: "req-e2e-1b" });
check("command-submit rejects blank pane_id", blank.status === 400, JSON.stringify(blank));
const ghost = await post("/api/command-submit", {
  pane_id: "pane-that-cannot-exist",
  request_id: "req-e2e-2",
  source: "parlay-ender",
});
check(
  "command-submit gates on daemon-known panes (ghost pane, no broadcast)",
  ghost.status !== 200,
  JSON.stringify(ghost),
);

// 4. Health + subscriber path are up.
const health = await fetch(`${base}/api/health`);
check("health serves on the test bridge", health.ok, String(health.status));

// 5. /ws/ui-events completes a websocket handshake (raw socket, no ws dep).
const { default: net } = await import("node:net");
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const wsStatus = await new Promise((resolve) => {
  const sock = net.connect({ host: "127.0.0.1", port: Number(process.env.VOICE_E2E_PORT ?? "18987") }, () => {
    const url = new URL(base);
    sock.write(
      `GET /ws/ui-events HTTP/1.1\r\nHost: 127.0.0.1:${url.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
  });
  let data = "";
  const done = (value) => {
    sock.destroy();
    resolve(value);
  };
  sock.setTimeout(5000, () => done("timeout"));
  sock.on("data", (chunk) => {
    data += chunk.toString("latin1");
    if (data.includes("\r\n\r\n")) {
      done(data.split("\r\n")[0] ?? "");
    }
  });
  sock.on("error", (err) => done(`socket-error: ${err.message}`));
});
check("ui-events accepts websocket subscribers", /101/.test(wsStatus), wsStatus);

if (failures > 0) {
  console.log(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("voice submit leg e2e: all checks passed");
'
# Give the async file logger a beat, then prove the beacon lines landed.
sleep 1
LOG_LINE="$(grep -h "client kind=ender-result" "${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions/$SESSION"/herdr-web.log 2>/dev/null | head -1 || true)"
if [[ -z "$LOG_LINE" ]]; then
  echo "FAIL: no ender-result beacon line in the isolated bridge log" >&2
  exit 1
fi
echo "ok: beacon line in bridge log: $LOG_LINE"
echo "voice submit leg e2e: PASS"

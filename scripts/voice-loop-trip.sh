#!/usr/bin/env bash
# voice-loop-trip.sh — synthetic herdr-web hop trip check (voice-submit loop phase 2).
#
# Box-event in, submit-command out, timed: POSTs a synthetic command-submit request — the
# same event a voice ender or relay box emits — and asserts the bridge accepts it and fans
# it out, after gating on /api/health. Proves the herdr-web hop end to end as one runnable
# check with per-leg timings.
#
# What each leg proves:
#   health         bridge is up AND its downstream (Herdr daemon) was seen recently.
#   snapshot       a live pane exists to target (the box side always names a pane).
#   command-submit the box event lands, validates, and fans
#                  `herdr_web.command_submit_requested` out on /ws/ui-events, echoed back
#                  as the request_id in the 200 response. Subscribed composers submit
#                  their drafts off that event (client side covered by
#                  web/src/commandSubmitEvent.test.tsx).
#   client-log     every flight-recorder beacon kind validates end to end
#                  (received=14, including main's `ender-result`) and malformed
#                  shapes 400 (unknown kind, empty events, oversized batch).
#
# Usage: scripts/voice-loop-trip.sh [bridge-base-url]   (default http://localhost:8787)
# Exit 0 = trip complete; 1 = any leg failed.

set -u
BASE="${1:-http://localhost:8787}"
fail=0

now_ms() {
  # python3 first (macOS default, reliable ms); GNU date when its %3N is numeric
  # (BSD date exits 0 but emits a literal "3N", so validate digits, not exit code);
  # whole seconds as the last resort.
  if command -v python3 >/dev/null 2>&1; then python3 -c 'import time; print(int(time.time()*1000))'; return; fi
  local stamp; stamp=$(date +%s%3N 2>/dev/null)
  if [[ "$stamp" =~ ^[0-9]+$ ]]; then printf '%s' "$stamp"; return; fi
  printf '%s000' "$(date +%s)"
}

leg_ms() { printf '%s' "$(( $2 - $1 ))"; }

echo "== voice-loop trip against $BASE"

t0=$(now_ms)
health=$(curl -fsS -m 5 "$BASE/api/health" 2>/dev/null)
t1=$(now_ms)
if [ -z "$health" ]; then
  echo "  FAIL health: endpoint unreachable in $(leg_ms "$t0" "$t1")ms"
  fail=1
else
  ok=$(printf '%s' "$health" | jq -r '.ok // false')
  bv=$(printf '%s' "$health" | jq -r '.bridge_version // empty')
  dseen=$(printf '%s' "$health" | jq -r '.daemon.last_seen_ms // empty')
  if [ "$ok" = "true" ]; then
    echo "  PASS health ($(leg_ms "$t0" "$t1")ms): bridge_version=${bv:-unknown} daemon_last_seen_ms=${dseen:-unknown}"
  else
    echo "  FAIL health ($(leg_ms "$t0" "$t1")ms): ok=false — daemon unreachable (last_seen_ms=${dseen:-never})"
    fail=1
  fi
fi

t0=$(now_ms)
snapshot=$(curl -fsS -m 5 "$BASE/api/snapshot" 2>/dev/null)
t1=$(now_ms)
pane_id=""
if [ -z "$snapshot" ]; then
  echo "  FAIL snapshot: endpoint unreachable in $(leg_ms "$t0" "$t1")ms"
  fail=1
else
  pane_id=$(printf '%s' "$snapshot" | jq -r '.panes[0].pane_id // empty' 2>/dev/null)
  if [ -n "$pane_id" ]; then
    echo "  PASS snapshot ($(leg_ms "$t0" "$t1")ms): targeting pane_id=$pane_id"
  else
    echo "  FAIL snapshot ($(leg_ms "$t0" "$t1")ms): no panes — open a terminal first"
    fail=1
  fi
fi

if [ -n "$pane_id" ]; then
  request_id="trip-$(now_ms)"
  body=$(jq -n --arg pane "$pane_id" --arg req "$request_id" \
    '{pane_id: $pane, source: "voice-loop-trip", request_id: $req}')
  t0=$(now_ms)
  response=$(curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d "$body" \
    "$BASE/api/command-submit" 2>/dev/null)
  t1=$(now_ms)
  if [ -z "$response" ]; then
    echo "  FAIL command-submit: endpoint unreachable in $(leg_ms "$t0" "$t1")ms"
    fail=1
  else
    echoed=$(printf '%s' "$response" | jq -r '.request_id // empty' 2>/dev/null)
    if [ "$echoed" = "$request_id" ]; then
      echo "  PASS command-submit ($(leg_ms "$t0" "$t1")ms): request_id echoed, event fanned out on /ws/ui-events"
    else
      echo "  FAIL command-submit ($(leg_ms "$t0" "$t1")ms): request_id mismatch (sent $request_id, got ${echoed:-none})"
      fail=1
    fi
  fi
fi

# --- client-log flight-recorder beacons (task-gu0ka): every beacon kind
# the page can send must validate end to end, and malformed shapes must 400.
# (Brief names this leg voice-submit-e2e.sh; the repo's e2e trip script is
# this file, so beacon coverage lives here.)
t0=$(now_ms)
kinds="eval-ok eval-fail sse-open sse-drop fallback-engaged fallback-standdown submit-fired submit-dropped submit-ack ender-match ender-result page-load voice-toggle console-error"
events_body=""
for kind in $kinds; do
  events_body="$events_body$(jq -n --arg k "$kind" '{kind:$k,detail:("trip-probe "+$k)}')\n"
done
client_log_payload=$(printf '%b' "$events_body" | jq -s '{events:.}')
client_log_response=$(curl -fsS -m 5 -X POST -H 'Content-Type: application/json' -d "$client_log_payload" \
  "$BASE/api/client-log" 2>/dev/null)
t1=$(now_ms)
if [ -z "$client_log_response" ]; then
  echo "  FAIL client-log: endpoint unreachable in $(leg_ms "$t0" "$t1")ms"
  fail=1
else
  received=$(printf '%s' "$client_log_response" | jq -r '.received // empty' 2>/dev/null)
  if [ "$received" = "14" ]; then
    echo "  PASS client-log ($(leg_ms "$t0" "$t1")ms): all 14 flight-recorder kinds accepted (received=14)"
  else
    echo "  FAIL client-log ($(leg_ms "$t0" "$t1")ms): expected received=14, got ${received:-none} ($client_log_response)"
    fail=1
  fi
fi

# Malformed shapes must 400: unknown kind, empty events, oversized batch.
check_client_log_reject() {
  local name="$1" payload="$2"
  local code
  code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d "$payload" "$BASE/api/client-log" 2>/dev/null)
  if [ "$code" = "400" ]; then
    echo "  PASS client-log/$name: rejected with 400"
  else
    echo "  FAIL client-log/$name: expected HTTP 400, got ${code:-unreachable}"
    fail=1
  fi
}
check_client_log_reject "unknown-kind" '{"events":[{"kind":"nope-not-a-kind"}]}'
check_client_log_reject "empty-events" '{"events":[]}'
too_many=$(jq -n '[range(33) | {kind:"sse-drop"}] | {events:.}')
check_client_log_reject "too-many-events" "$too_many"

if [ "$fail" -eq 0 ]; then
  echo "TRIP OK: box-event in, submit-command out"
else
  echo "TRIP FAILED"
fi
exit $fail

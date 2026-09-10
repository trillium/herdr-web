#!/usr/bin/env bash
# tailnet-bridge-check — herdr-web fleet compatibility probe (project-xyq).
#
# Verifies every tailnet host's herdr-web-bridge is reachable AND compatible
# with this web app's expectations. Designed to run from ANY machine on the
# tailnet — no MacBook dependency. Pure curl+jq.
#
# Usage:
#   scripts/tailnet-bridge-check.sh [host ...]        # explicit hosts
#   scripts/tailnet-bridge-check.sh                   # hosts from `tailscale status`
#
# Env:
#   HERDR_WEB_PORT   bridge port per host (default 8787)
#   APP_MIN_WEB_COMPAT / EXPECTED_* are matched against the web app's own gate
#   (web/src/bridge.tsx APP_MIN_WEB_COMPAT) — keep in sync when bumping.
#
# Exit codes: 0 all reachable+compatible; 1 any failure (details printed).

set -u
PORT="${HERDR_WEB_PORT:-8787}"
MIN_WEB_COMPAT=1

hosts=()
if [ $# -gt 0 ]; then
  hosts=("$@")
elif command -v tailscale >/dev/null 2>&1 || [ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]; then
  TS=$(command -v tailscale || echo "/Applications/Tailscale.app/Contents/MacOS/Tailscale")
  while IFS= read -r line; do
    # Skip blank lines, comments, and the `tailscale status` footer
    # (e.g. "# Funnel on:" / "- https://<host>.ts.net" lines).
    stripped=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//')
    case "$stripped" in ""|\#*|"-"*) continue;; esac
    # Column 2 is the short hostname (e.g. `macbook`); MagicDNS answers
    # for short names, so use it directly instead of hunting for a
    # dotted DNS name (which skipped every real row and matched the
    # Funnel footer URL, scheme included, yielding always-UNREACHABLE).
    h=$(printf '%s' "$line" | awk '{print $2}')
    # Defense in depth: strip any URL scheme/path/trailing dot that
    # slips through, and reject non-hostname tokens (IPs, user@, OS).
    h=$(printf '%s' "$h" | sed -e 's#^[a-zA-Z][a-zA-Z0-9+.-]*://##' -e 's#/.*##' -e 's/\.$//')
    case "$h" in
      ""|*@*|macOS|iOS|linux|windows|active*|idle|offline*|direct*) continue;;
      *[!A-Za-z0-9_.-]*) continue;;
    esac
    hosts+=("$h")
  done < <("$TS" status 2>/dev/null)
fi

if [ ${#hosts[@]} -eq 0 ]; then
  echo "no hosts given and tailscale status unavailable" >&2
  exit 1
fi

fail=0
printf '%-42s %-14s %-10s %s\n' HOST VERDICT WEB_COMPAT BRIDGE_VERSION
for h in "${hosts[@]}"; do
  body=$(curl -fsS -m 4 "http://${h}:${PORT}/api/capabilities" 2>/dev/null)
  if [ -z "$body" ]; then
    printf '%-42s %-14s %-10s %s\n' "$h" UNREACHABLE - -
    fail=1
    continue
  fi
  version=$(printf '%s' "$body" | jq -r '.bridge_version // empty' 2>/dev/null)
  compat=$(printf '%s' "$body" | jq -r '.web_compat // empty' 2>/dev/null)
  if [ -z "$compat" ]; then
    # Pre-capability bridge: reachable but stale relative to the web app.
    printf '%-42s %-14s %-10s %s\n' "$h" "LEGACY(rebuild)" "<$MIN_WEB_COMPAT?" "${version:-unknown}"
    fail=1
    continue
  fi
  if [ "$compat" -lt "$MIN_WEB_COMPAT" ] 2>/dev/null; then
    printf '%-42s %-14s %-10s %s\n' "$h" INCOMPATIBLE "$compat" "${version:-unknown}"
    fail=1
    continue
  fi
  printf '%-42s %-14s %-10s %s\n' "$h" OK "$compat" "${version:-unknown}"
done

exit $fail

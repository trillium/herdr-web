# @herdr/web

React + Vite frontend for `herdr-web`.

Run from this directory:

```bash
npm install
npm run dev
npm run lint
npm run test
npm run build
```

The production build is written to `web/dist/` and served by `herdr-web-bridge` through
`scripts/run-bridge.sh`.

For the normal one-command development workflow, start the bridge and Vite from the repository root:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/ws` to the managed bridge and hot-reloads
frontend edits. See the root README for address and socket overrides.

To manage the two processes separately instead:

```bash
# terminal 1, from the repository root
npm run bridge:build && scripts/run-bridge.sh

# terminal 2, from the repository root
npm run dev:web
```

`scripts/run-bridge.sh` points debug bridge builds at the stable Herdr socket by default instead of
the debug `herdr-dev` socket. Override `HERDR_SOCKET_PATH` when targeting a named or development
session.

## Optional: Enable Parlay-backed Voice Input

The `ParlayInput` voice box (`src/ParlayInput.tsx`) is wired to the Parlay eval
loop through `parlay-input` (the zero-dependency DOM wrapper implementing the
real REST up-channel + shared SSE down-channel) and degrades gracefully to a
plain text input when parlay is unavailable. To enable voice line-ender submit
(dictating a line ending with "send it" / "submit" / "submit that" auto-submits
after the server's 1s verify hold), set up a local symlink to your parlay
checkout and build the wrapper:

```bash
mkdir -p web/local-deps
ln -s /path/to/parlay/packages/input web/local-deps/parlay-input
cd /path/to/parlay/packages/input && bun install && bun run build
```

`parlay-input` is intentionally NOT listed in `package.json`/`package-lock.json`
(it is never published and never fetched from a registry). The Vite resolver in
`vite.config.ts` picks up the symlink directly, so no reinstall is needed — just
restart the dev server / rebuild after creating it.

Parlay requires the eval engine and server running:

```bash
# Terminal 1: eval engine (compiled Go)
cd /path/to/parlay && parlay eval serve  # :4343

# Terminal 2: parlay server (port 4242)
cd /path/to/parlay/packages/server && bun run start  # or the Go server
```

How it works: every voice-box change POSTs
`{streamId, version, text, cursor, reason:'input', voiceEnabled:true,
platform:'herdr'}` to `POST /api/chat/eval` (one stable `streamId` per box —
per-box isolation is server-side). `armTimer`/`cancelTimer` render the advisory
"Sending in 1s…" countdown only and never submit locally; the async `submitNow`
re-verifies the ender tail against the live buffer, strips it, and submits the
remainder through the live bridge path (`POST /api/command-submit` →
`herdr_web.command_submit_requested`).

Two serving prerequisites, both verified against the origin guard:

- **Bridge CSP:** the page must be allowed to reach the Parlay server. Pass
  the server origin to the bridge, e.g.
  `herdr-web-bridge --allow-connect-origin http://192.168.1.10:4242`.
  Without it the browser blocks every parlay round trip and the box stays a
  plain input.
- **Parlay origin guard:** private-LAN page origins (`192.168.x`, `10.x`,
  `.local`, loopback) are accepted as-is. A Tailnet (`100.x`) page origin is
  NOT in the private-LAN set and gets a `403` (indistinguishable from down
  without reading the status) — set `PARLAY_ALLOWED_ORIGINS` on the parlay
  server to the exact serving origin, e.g.
  `PARLAY_ALLOWED_ORIGINS=http://100.x.y.z:8787`.

If the symlink is missing or stale, the app will still build and run with a plain text input —
no special action needed. `web/local-deps/` is gitignored. Note that the symlink's presence is
baked into `web/dist`: a production build made without it externalizes `parlay-input`, so the
built app always falls back to the plain input. See [docs/packaging.md](../docs/packaging.md).

## Vite dev server environment variables:

- `HERDR_WEB_BRIDGE` — bridge URL the dev server proxies `/api` and `/ws` to. Defaults to
  `http://127.0.0.1:8787`.
- `HERDR_WEB_ALLOWED_HOSTS` — comma-separated list of hostnames the Vite dev server accepts `Host`
  headers from, e.g. `dev.example.ts.net`. Useful when reaching the dev server over Tailscale, a
  tunnel, or a reverse proxy. Set to `*` to allow any host. Unset by default (Vite's standard host
  restrictions apply).

The app expects these bridge routes:

- `/api/capabilities`
- `/api/snapshot`
- `/api/command`
- `/api/launcher-presets`
- `/api/launcher-presets/launch`
- `/api/selection`
- `/api/notes` (and `/api/notes/{note_id}/...` actions)
- `/api/agent-pins` (and `/api/agent-pins/{pane_id}/pin|unpin`)
- `/api/agent-activity`
- `/api/mobile-mode`
- `/api/uploads`
- `/ws/activity`
- `/ws/events`
- `/ws/ui-events`
- `/ws/terminal`

Launcher execution belongs to the bridge. The frontend selects a preset and placement; it does not
construct Herdr `agent.start` requests. Built-in agents use Herdr's managed-agent flow after the
bridge creates the destination pane, while custom presets retain their exact configured `argv`.

New space uses the active space on the selected bridge as its launch-directory source.
Herdr still controls the directory policy. Its default in `~/.config/herdr/config.toml` is:

```toml
[terminal]
new_cwd = "follow"
```

This inherits the source space's directory as resolved by Herdr (its active tab's focused
pane, or the space's seed directory).
Other Herdr directory policies remain in effect; the browser does not override `cwd`.
When there is no active space, Herdr chooses its default source.
If another client closes the source space before creation, Herdr rejects the request;
refresh/select an existing space and retry. The browser does not silently switch the
launch directory by retrying without a source.

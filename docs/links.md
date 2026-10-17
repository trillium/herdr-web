# Links & notes page

`/links` is the human's inbox for things an agent hands off: URLs to open and short notes. It
exists so a link printed in a scrolling terminal is no longer the only way to receive one.

## Human: see and open results

1. Open `http://<bridge-host>:<port>/links` (the terminal UI has no link yet; bookmark it, or
   use the "Open terminal" link on the page to go back).
2. Newest first. Unopened items carry a **New** badge and the tab title shows `(n) Links`.
3. Click a title to open the link in a new tab. Opening marks it read.
4. **Dismiss** hides an item; tick **Show dismissed** to see it again and **Restore** it.

The page polls every 3 seconds, so items published from the CLI appear without a reload.

## Agent: publish

The CLI is a subcommand of the bridge binary, so it is present wherever the bridge is installed:

```bash
herdr-web-bridge link https://github.com/org/repo/pull/12 --title "PR: fix login"
herdr-web-bridge link --note "Needs your call on the retry policy" --title "Decision"
printf 'multi\nline note' | herdr-web-bridge link --note -
herdr-web-bridge link --list [--all] [--json]
```

- `--source TEXT` labels who sent it (default: none). `--pane ID` links it to a pane; it defaults
  to `$HERDR_PANE_ID`, which Herdr sets inside every pane.
- Only `http://` and `https://` URLs are accepted. Anything else exits with status 2.
- Publishing a URL that is already on the page does not add a row: it bumps `sent N×`, resets it
  to **New**, and refreshes the title/source when given.
- The CLI writes the same locked JSON store the bridge reads (`$HERDR_WEB_LINKS_DIR`, else
  `$XDG_DATA_HOME/herdr-web/links`, else `~/.local/share/herdr-web/links`). It needs no running
  bridge, no network and no Origin header. Run it as the same user as the bridge.
- Exit codes: `0` ok, `1` store/IO error, `2` bad arguments.

### Publishing what `herdr-links` finds

`herdr-links` (on-demand scanner of every pane's recent output) already extracts URLs. Feed it to
the page instead of re-implementing extraction:

```bash
herdr-links --json | herdr-web-bridge link --from-herdr-links
```

This publishes every URL found, tagged `--source herdr-links` and the first pane it was seen in.
It is idempotent: a URL already on the page is left alone (not bumped, a read link stays read),
including one you dismissed: it stays dismissed (use **Restore** to bring it back), so it is safe to run on a timer or after each agent turn.

### HTTP alternative (remote agents)

```bash
curl -X POST http://<bridge-host>:<port>/api/links \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","title":"Example","source":"my-agent"}'
```

Body fields: `url` or `body` (a note), `title`, `source`, `pane_id`. Other routes:
`GET /api/links[?include_dismissed=true]` and `POST /api/links/{id}/open|dismiss|restore`.
Requests pass the bridge's Host/Origin policy; that is not authentication, so anyone who can reach
the bridge can read and write the page. It stores at most 500 entries, evicting dismissed ones first.

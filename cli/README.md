# cli/

Bun scripts for working with herdr tabs from the terminal. Run with `bun <file>`.

- `herdr-channel.ts` — watches all WezTerm panes for `channel <name>`, `channel list [active|full|cards]`, and `pin next/prev` commands and focuses the matching herdr tab or opens a picker.
- `herdr-channel-health.ts` — component checks plus a live end-to-end detection test (`--static` skips text injection).
- `herdr-channel-list.ts` — picker UI behind `channel list` (modes split, full, cards).
- `herdr-input-watch.ts` — watches what is typed in every herdr pane and emits JSON events to stdout.
- `herdr-multi.ts` — multi-host herdr tab browser across several bridges.

The launchd service `com.herdr.channel` runs `herdr-channel.ts` with bun.

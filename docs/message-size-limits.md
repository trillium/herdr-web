# Long messages: limits and delivery

How a long composer or `/send` message reaches a pane, where it can be cut, and what herdr-web
does about it. Numbers below were measured against a scratch Herdr session (never a live agent
pane) with a byte-comparing receiver and a real Claude Code TUI.

## Two send paths

| Path | Route | Bridge limit |
| --- | --- | --- |
| Mobile/desktop composer | `TerminalView` -> `/ws/terminal` `{type:"input"}` frames -> bridge -> Herdr attach protocol -> pty | 8 MiB per frame (the input backlog budget) |
| `/send` page | `POST /api/command` `pane.send_text` / `pane.send_input` -> bridge -> Herdr API socket -> pty | 8 MiB of text |

## Every cap or drop point

| Point | Limit | Behavior at the limit |
| --- | --- | --- |
| Composer `<input>`/`<textarea>` | none (no `maxlength`) | n/a |
| WebSocket text frame | 8 MiB backlog budget (`MAX_QUEUED_TERMINAL_INPUT_BYTES`) | A larger frame closes the socket, nothing is sent. The composer now refuses it before clearing the draft and says so. |
| Bridge chunking to the daemon | 768 KiB per `Input` message (`MAX_TERMINAL_INPUT_CHUNK_BYTES`), Herdr frame cap 2 MiB | Splits, in order, lossless. |
| Global HTTP body limit | 25 MiB | `413`. Text is capped at 8 MiB first, so JSON escaping would need to exceed 3x to reach it. |
| `/send` text size (`MAX_FOCUSED_PANE_SEND_BYTES`) | was 64 KiB, now 8 MiB | Over the limit: `400` naming the size and the limit. The `/send` page also blocks the button and says so before sending. |
| Herdr API socket request line | about 1 MiB | The request is dropped and the bridge saw `502 Broken pipe`. The bridge now splits a send into 128 KiB pieces (worst-case JSON escaping is 6x, still under 1 MiB), in order, with Enter only after the last. A failure part-way names how many bytes were already delivered. |
| Line discipline | none observed up to 1 MiB (raw) / 16 KB (cooked) | A raw pty delivered every byte at every size tested, also with a slow reader. A cooked pty delivered all bytes up to 16 KB (only CR became LF). Larger cooked sizes were not measured. |
| Agent TUI input (Claude Code) | not a size limit; it keeps only the tail of a large raw burst | **Truncates**. This is what cut the long messages to their tail. See below. |

## The agent TUI truncation

Claude Code, fed the same bytes as a raw burst, records only the tail: 243 of 4,385 bytes,
365 of 66,704 bytes, 238 of 266,105 bytes. The pty had received every byte, so no bridge or Herdr
cap is involved. The same text wrapped in a bracketed paste (`ESC[200~ ... ESC[201~`) was recorded
whole at 4 KB, 16 KB, 64 KB and 256 KB. One paste spread over several writes also lost everything
but the tail, while one paste per write (each at most 128 KiB) arrived whole, so pieces are pasted
individually.

So:

- Composer: when the pane has bracketed paste enabled (DEC mode 2004, read from the terminal
  renderer) and the text has a line break or is 1 KiB or more, it is sent as one bracketed paste and
  Enter goes after the end marker. Short single-line text stays raw. An embedded end marker is
  removed so it cannot close the paste early.
- `/send`: the bridge cannot see the pane's modes, so it wraps each piece as its own paste when
  Herdr reports a detected agent for the focused pane (`pane.agent`), under the same text rule.
  Shell panes get the raw text, as before.
- Whitespace at the start or end of a paste may be trimmed by the TUI, and tabs may be shown as
  spaces. Both are the TUI's own normalization.

## Measured results (scratch pane)

Raw receiver, bytes compared exactly, multi-line non-ASCII payload plus Enter:

| Size | Composer (WebSocket) | `/send` before | `/send` now |
| --- | --- | --- | --- |
| 1 KB | full | full | full |
| 4 KB | full | full | full |
| 16 KB | full | full | full |
| 64 KB | full | full | full |
| 256 KB | full | rejected (`400`, nothing sent) | full |
| 1 MB | full | `400` | full |
| 4 MB | n/a | `400` | full |
| 8 MB (8,000,000 B) | n/a | `400` | full |
| 9 MiB | not measured (composer refuses client-side) | `400` | `400` with a message naming size and limit |

Before this change `/send` stopped at 64 KiB with `400`. With that cap lifted alone, requests over
about 1 MB reached Herdr's API socket and failed with `502`, which is why the bridge now chunks.

Real Claude Code TUI: raw bursts kept only the tail (see above). Bracketed pastes from the
composer path were recorded whole at 4 KB, 16 KB, 64 KB and 256 KB, and `/send` delivered 4 KB,
256 KB and 1 MiB whole.

## Warnings the sender sees

- Composer: over 8 MiB, the draft is kept and the status says the size, the limit and that nothing
  was sent. Over 4 KB into a pane without bracketed paste, a status warns the app may keep only
  part of it.
- `/send`: over 64 KB the page says it will be sent in several pieces, in order; over 8 MiB the
  Send button is disabled and the page says nothing will be sent.

## Tests

- `bridge/src/web_bridge.rs`: `split_pane_send_*`, `agent_pane_sends_wrap_each_piece_*`,
  `large_multiline_non_ascii_send_arrives_intact_in_order_with_enter_last` (a mock Herdr API socket
  that drops requests over 1 MiB), `mid_send_failure_reports_how_much_text_was_already_delivered`,
  `terminal_input_chunks_keep_a_large_bracketed_paste_byte_identical_and_in_order`.
- `web/src/terminalPaste.test.ts`, `web/src/sendOnly.test.ts`.

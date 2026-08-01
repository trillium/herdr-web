// Every terminal scroll delta (wheel, touch drag, PageUp/PageDown) is forwarded to the
// bridge as a request to move the remote session's view, since the live pty/session
// scrollback is server-owned rather than mirrored locally. There is no server signal for
// "at the bottom" today, so presence is inferred purely from the net lines requested.
export const MAX_TERMINAL_SCROLL_JUMP_LINES = 65535;

export function advanceTerminalScrollOffset(offsetLines: number, deltaLines: number): number {
  if (!Number.isFinite(deltaLines) || deltaLines === 0) {
    return offsetLines;
  }
  return Math.max(0, offsetLines - deltaLines);
}

export function isTerminalScrolledAwayFromPresent(offsetLines: number): boolean {
  return offsetLines > 0;
}

const NEWLINE_BYTE = 0x0a;

// Output that streams in while scrolled away pushes the true bottom further down without
// the user scrolling, so the tracked offset must grow too or "jump to present" undershoots.
export function countTerminalOutputNewlines(data: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] === NEWLINE_BYTE) {
      count += 1;
    }
  }
  return count;
}

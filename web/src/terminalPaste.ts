// Delivery of composer text to a pane: when to wrap it in a bracketed paste, and how a
// long message is split so no length is refused.

/**
 * Longest run of UTF-16 units sent in one frame. Worst case 3 UTF-8 bytes per unit, so a
 * piece stays under 768 KiB, one bridge chunk. The bridge holds back the next frame until
 * the pty has drained, so the number of pieces is unbounded.
 */
export const COMPOSER_PIECE_UNITS = 256 * 1024;

/**
 * Composer text at or above this size (or with any line break) is sent as a
 * bracketed paste when the pane has enabled the mode. Measured: Claude Code keeps
 * only the tail of a multi-KB raw burst, but takes the whole thing as a paste.
 */
export const BRACKETED_PASTE_MIN_BYTES = 1024;

/** Without bracketed paste, text this large may still be truncated by the app. */
export const UNBRACKETED_WARN_BYTES = 4096;

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";

const encoder = new TextEncoder();

export function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Wrap text so the app receives it as one paste; an embedded end marker is removed. */
export function wrapBracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text.split(BRACKETED_PASTE_END).join("")}${BRACKETED_PASTE_END}`;
}

export function shouldBracketPaste(text: string, bracketedPasteEnabled: boolean): boolean {
  if (!bracketedPasteEnabled || text.length === 0) {
    return false;
  }
  return text.includes("\n") || text.includes("\r") || utf8ByteLength(text) >= BRACKETED_PASTE_MIN_BYTES;
}

export type ComposerDelivery = {
  /** Input parts to enqueue, in order; the command text may be split and wrapped as pastes. */
  parts: string[];
  /** Set when the text will be sent but may be cut by the receiving app. */
  warning: string | null;
};

/** Split at code-point boundaries so a surrogate pair is never torn between frames. */
export function splitComposerText(text: string, pieceUnits = COMPOSER_PIECE_UNITS): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + pieceUnits, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) {
        end -= 1;
      }
    }
    pieces.push(text.slice(start, end));
    start = end;
  }
  return pieces;
}

export function planComposerDelivery(
  command: string,
  suffix: string[],
  bracketedPasteEnabled: boolean,
): ComposerDelivery {
  const bytes = utf8ByteLength(command);
  const bracket = shouldBracketPaste(command, bracketedPasteEnabled);
  const warning =
    !bracketedPasteEnabled && bytes >= UNBRACKETED_WARN_BYTES
      ? `Sending ${formatByteSize(bytes)}; this pane is not in bracketed-paste mode, so the app may keep only part of it.`
      : null;
  // Each piece is its own paste: an agent TUI keeps only the tail of one paste spread over
  // several writes, but takes a paste per write whole.
  const pieces = splitComposerText(command).map((piece) =>
    bracket ? wrapBracketedPaste(piece) : piece,
  );
  return { parts: [...pieces, ...suffix], warning };
}

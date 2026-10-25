// Delivery of composer text to a pane: when to wrap it in a bracketed paste, and
// the one limit the client cannot lift (the bridge's per-socket input backlog).

/** Mirrors `MAX_QUEUED_TERMINAL_INPUT_BYTES` in `bridge/src/web_bridge.rs`. */
export const MAX_TERMINAL_INPUT_BYTES = 8 * 1024 * 1024;

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
  /** Input parts to enqueue, in order; the command text may be wrapped as a paste. */
  parts: string[];
  /** Set when the text cannot be sent; the composer must keep the draft. */
  error: string | null;
  /** Set when the text will be sent but may be cut by the receiving app. */
  warning: string | null;
};

export function planComposerDelivery(
  command: string,
  suffix: string[],
  bracketedPasteEnabled: boolean,
): ComposerDelivery {
  const bytes = utf8ByteLength(command);
  if (bytes + suffix.reduce((sum, part) => sum + part.length, 0) > MAX_TERMINAL_INPUT_BYTES) {
    return {
      parts: [],
      error: `Message is ${formatByteSize(bytes)}; the bridge accepts at most ${formatByteSize(
        MAX_TERMINAL_INPUT_BYTES,
      )} per send. Nothing was sent.`,
      warning: null,
    };
  }
  const bracket = shouldBracketPaste(command, bracketedPasteEnabled);
  const warning =
    !bracketedPasteEnabled && bytes >= UNBRACKETED_WARN_BYTES
      ? `Sending ${formatByteSize(bytes)}; this pane is not in bracketed-paste mode, so the app may keep only part of it.`
      : null;
  return { parts: [bracket ? wrapBracketedPaste(command) : command, ...suffix], error: null, warning };
}

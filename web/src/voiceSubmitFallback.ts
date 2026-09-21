// Client-side submit fallback (task-qj0k1 backstop): when the server eval
// path/SSE drops, the box must still submit on the ender phrase locally.
// This module is the pure tail-matching half; ParlayInput owns the
// when-to-fire policy (ONLY while the stream is flagged down, standing down
// the moment it recovers or the countdown resolves).
//
// Never double-submit with the server path: the caller must re-verify the
// tail against the LIVE buffer immediately before firing, and fire only while
// its own armed countdown is still pending. A server submit that won first
// stages stripped text (tail gone) or clears the box, so the re-verify fails
// and the fallback stands down — and vice versa, because the wrapper's own
// submitNow re-verifies the same way before its onSubmit fires.
//
// Tail source priority: the server-armed requireTail when the armTimer
// carries one (exact, server-defined), else the documented ender phrases
// ("send it" / "submit that" / "submit" — see web/README.md).

/** Server-independent ender phrases, longest first for trailing match. */
export const VOICE_FALLBACK_ENDER_PHRASES = ["submit that", "send it", "submit"] as const;

/** Extra grace past the server verify-hold deadline before the fallback fires. */
export const VOICE_FALLBACK_GRACE_MS = 2000;

/**
 * Dictation-tolerant trailing-tail match shared by the server-armed tail and
 * the phrase backstop.
 *
 * Dictation engines do not emit the ender phrase verbatim: words arrive
 * capitalized ("Send It"), separated by doubled spaces, glued to the
 * previous word with a comma ("out,send it"), or hyphenated ("send-it").
 * The match therefore compares word sequences, not substrings: the tail is
 * split into words (on whitespace AND punctuation, so both sides normalize
 * the same way), the words are joined with a separator class that accepts
 * any run of whitespace or punctuation, and the whole pattern is anchored to
 * the end of the buffer with only trailing junk allowed after it. A word
 * boundary (start of buffer, whitespace, or punctuation) is required before
 * the first word so "submit" never matches inside "resubmit".
 *
 * The strip point is the regex match start, so the returned remainder keeps
 * the caller's original text byte-identical (only trimmed).
 */
function splitTailWords(tail: string): string[] {
  return tail
    .split(/\s+/u)
    .flatMap((token) => token.split(/[\p{P}]+/u))
    .filter((word) => word.length > 0);
}

function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTrailingTailPattern(words: string[]): RegExp | null {
  if (words.length === 0) {
    return null;
  }
  const body = words.map(escapeRegExp).join("[\\s\\p{P}]+" );
  return new RegExp(`(?:^|[\\s\\p{P}])${body}[\\s\\p{P}]*$`, "iu");
}

function stripTrailingTail(liveValue: string, words: string[]): string | null {
  const pattern = buildTrailingTailPattern(words);
  if (!pattern) {
    return null;
  }
  const match = pattern.exec(liveValue);
  if (!match || match.index === undefined) {
    return null;
  }
  const stripped = liveValue.slice(0, match.index).trim();
  return stripped ? stripped : null;
}

/**
 * Match a trailing ender tail against the live buffer. Returns the stripped
 * remainder to submit, or null when the tail is absent, stale, or empty.
 */
export function matchFallbackTail(liveValue: string, requireTail?: string): string | null {
  const tail = requireTail?.trim();
  if (tail) {
    return stripRequiredTail(liveValue, tail);
  }
  return stripFallbackPhrase(liveValue);
}

/**
 * Mirror of the wrapper's submitNow tail check, hardened for dictation
 * realities: case-insensitive, internal whitespace/punctuation runs in either
 * side collapse ("send  it", "send, it", "Send-It" all match a "send
 * it" tail), only whitespace/punctuation allowed after the tail.
 */
export function stripRequiredTail(liveValue: string, requireTail: string): string | null {
  return stripTrailingTail(liveValue, splitTailWords(requireTail));
}

/** Re-verify outcome for the flight-recorder ender-match trace. */
export type EnderMatchVerdict = "verified" | "stale" | "empty";

/** Where the matched tail came from: server-armed, local phrase, or wrapper. */
export type EnderMatchSource = "requireTail" | "phrase" | "server";

const MAX_TRACE_PREVIEW_CHARS = 30;

function tracePreview(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const tail = flat.length > MAX_TRACE_PREVIEW_CHARS
    ? flat.slice(-MAX_TRACE_PREVIEW_CHARS)
    : flat;
  return tail.replace(/"/g, "'");
}

/**
 * Flight-recorder ender-match trace (task-gu0ka signal 4): buffer tail,
 * matched phrase, stripped remainder, and re-verify verdict in one
 * printable-ASCII line sized for the 120-char client log cap. Previews are
 * truncated tails of the user's own voice box — the diagnostic the phone
 * loop needs when a submit silently never fires.
 */
export function formatEnderMatchDetail(input: {
  source: EnderMatchSource;
  tail: string;
  remainder: string | null;
  verdict: EnderMatchVerdict;
}): string {
  const remainder = input.remainder === null ? "-" : tracePreview(input.remainder);
  return `src=${input.source} tail="${tracePreview(input.tail)}" remainder="${remainder}" verdict=${input.verdict}`;
}
function stripFallbackPhrase(liveValue: string): string | null {
  for (const phrase of VOICE_FALLBACK_ENDER_PHRASES) {
    const stripped = stripTrailingTail(liveValue, splitTailWords(phrase));
    if (stripped !== null) {
      return stripped;
    }
  }
  return null;
}

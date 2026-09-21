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

const TRAILING_JUNK = /[.!?,;\s]+$/;

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
 * Mirror of the wrapper's submitNow tail check: case-insensitive trailing
 * match, only whitespace/punctuation allowed after the tail.
 */
export function stripRequiredTail(liveValue: string, requireTail: string): string | null {
  const idx = liveValue.toLowerCase().lastIndexOf(requireTail.toLowerCase());
  if (idx === -1) {
    return null;
  }
  const after = liveValue
    .slice(idx + requireTail.length)
    .trim()
    .replace(/[.!?,;]+/g, "");
  if (after !== "") {
    return null;
  }
  const stripped = liveValue.slice(0, idx).trim();
  return stripped ? stripped : null;
}

function stripFallbackPhrase(liveValue: string): string | null {
  const cleaned = liveValue.replace(TRAILING_JUNK, "");
  const lower = cleaned.toLowerCase();
  for (const phrase of VOICE_FALLBACK_ENDER_PHRASES) {
    if (!lower.endsWith(phrase)) {
      continue;
    }
    const start = cleaned.length - phrase.length;
    const before = start === 0 ? "" : cleaned[start - 1];
    if (before !== "" && !/\s/.test(before)) {
      continue;
    }
    const stripped = cleaned.slice(0, start).trim();
    if (stripped) {
      return stripped;
    }
    return null;
  }
  return null;
}

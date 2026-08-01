// Voice dictation on iPhone rewrites/corrects itself mid-stream, so the mobile
// command input buffers it before it reaches the pty. A trailing "submit
// phrase" lets the captain speak a magic word to send the buffered text once
// dictation settles — mirrors Parlay's `submit` built-in (trailing match,
// case-insensitive, tolerant of trailing punctuation).
export const VOICE_SUBMIT_PHRASES = ["bravely", "gravely", "briefly", "lap"];
// Trailing "clear phrase" discards the buffered text instead of sending it —
// for when dictation goes sideways and the captain wants to start over.
export const VOICE_CLEAR_PHRASES = ["change"];
// "pin next"/"pin previous" cycle focus across pinned panes instead of
// touching the buffered text at all — the buffer is left as-is on fire.
// "one" is a short, more reliably-transcribed alias for "pin next"; "pan
// next"/"pam next"/"in next" cover dictation mishearing "pin" as
// "pan"/"pam"/"in". "pan previous"/"pan prev"/"pin past"/"pan past" cover the
// same "pin"->"pan" mishearing plus "prev"->"past" for the previous phrase.
export const VOICE_PIN_NEXT_PHRASES = ["pin next", "pan next", "pam next", "in next", "one"];
export const VOICE_PIN_PREV_PHRASES = [
  "pin previous",
  "pin prev",
  "pan previous",
  "pan prev",
  "pin past",
  "pan past",
];
export const VOICE_SUBMIT_TIMER_MS = 1000;

const VOICE_SUBMIT_PHRASE_SEP = "[\\s,.!?;:]+";

function escapeVoiceSubmitPhraseRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildVoiceSubmitPhraseCore(phrase: string): string {
  const words = phrase.trim().split(/\s+/);
  return words
    .map((word, index) => {
      const isLast = index === words.length - 1;
      return `${escapeVoiceSubmitPhraseRegExp(word)}${isLast ? "" : VOICE_SUBMIT_PHRASE_SEP}`;
    })
    .join("");
}

function buildVoicePhraseMatchers(phrases: string[]): RegExp[] {
  return phrases.map(
    (phrase) => new RegExp(`(?:^|\\s+)(${buildVoiceSubmitPhraseCore(phrase)})[.!?,;]*\\s*$`, "i"),
  );
}

const VOICE_SUBMIT_PHRASE_MATCHERS = buildVoicePhraseMatchers(VOICE_SUBMIT_PHRASES);
const VOICE_CLEAR_PHRASE_MATCHERS = buildVoicePhraseMatchers(VOICE_CLEAR_PHRASES);
const VOICE_PIN_NEXT_PHRASE_MATCHERS = buildVoicePhraseMatchers(VOICE_PIN_NEXT_PHRASES);
const VOICE_PIN_PREV_PHRASE_MATCHERS = buildVoicePhraseMatchers(VOICE_PIN_PREV_PHRASES);

function matchTrailingPhrase(value: string, matchers: RegExp[]): string | null {
  for (const matcher of matchers) {
    const match = value.match(matcher);
    if (match) {
      return match[1] ?? match[0];
    }
  }
  return null;
}

/** Returns the trailing submit phrase text if `value` ends with one, else null. */
export function matchTrailingVoiceSubmitPhrase(value: string): string | null {
  return matchTrailingPhrase(value, VOICE_SUBMIT_PHRASE_MATCHERS);
}

/** Returns the trailing clear phrase text if `value` ends with one, else null. */
export function matchTrailingVoiceClearPhrase(value: string): string | null {
  return matchTrailingPhrase(value, VOICE_CLEAR_PHRASE_MATCHERS);
}

/** Returns the trailing "pin next/previous" phrase direction + matched text, else null. */
export function matchTrailingVoicePinPhrase(
  value: string,
): { direction: "next" | "prev"; tail: string } | null {
  const nextTail = matchTrailingPhrase(value, VOICE_PIN_NEXT_PHRASE_MATCHERS);
  if (nextTail) {
    return { direction: "next", tail: nextTail };
  }
  const prevTail = matchTrailingPhrase(value, VOICE_PIN_PREV_PHRASE_MATCHERS);
  if (prevTail) {
    return { direction: "prev", tail: prevTail };
  }
  return null;
}

/**
 * True if `value` still ends with `matchedTail` (allowing trailing
 * punctuation) — used to re-verify a phrase match right before it fires,
 * since dictation may keep correcting the tail during the arm window.
 */
export function voiceTailStillMatches(value: string, matchedTail: string): boolean {
  const idx = value.toLowerCase().lastIndexOf(matchedTail.toLowerCase());
  return idx !== -1 && value.slice(idx + matchedTail.length).trim().replace(/[.!?,;]+/g, "") === "";
}

/**
 * Re-verifies `value` still ends with `matchedTail` (allowing trailing
 * punctuation) and returns the text with the phrase stripped, or null if the
 * buffer changed since the phrase was matched.
 */
export function stripVoiceSubmitPhrase(value: string, matchedTail: string): string | null {
  if (!voiceTailStillMatches(value, matchedTail)) {
    return null;
  }
  const idx = value.toLowerCase().lastIndexOf(matchedTail.toLowerCase());
  const stripped = value.slice(0, idx).trim();
  return stripped || null;
}

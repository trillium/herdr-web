export const DEFAULT_CONTENT_INSET_TOP_PX = 0;
export const DEFAULT_CONTENT_INSET_BOTTOM_PX = 0;
export const DEFAULT_MOBILE_CONTROLS_SCALE_PERCENT = 100;
export const DEFAULT_AGENT_FEATURES_IN_TABS = true;
export const DEFAULT_MULTI_HOST_SPACE_SELECTION = true;
/** Voice-submit switch default: ON (current parlay-input behavior preserved). */
export const DEFAULT_VOICE_SUBMIT_ENABLED = true;

export const MIN_CONTENT_INSET_TOP_PX = 0;
export const MAX_CONTENT_INSET_TOP_PX = 96;
export const MIN_CONTENT_INSET_BOTTOM_PX = 0;
export const MAX_CONTENT_INSET_BOTTOM_PX = 160;
export const MIN_MOBILE_CONTROLS_SCALE_PERCENT = 80;
export const MAX_MOBILE_CONTROLS_SCALE_PERCENT = 150;

export function parseContentInsetTopPx(value: unknown) {
  return parseClampedInteger(
    value,
    MIN_CONTENT_INSET_TOP_PX,
    MAX_CONTENT_INSET_TOP_PX,
    DEFAULT_CONTENT_INSET_TOP_PX,
  );
}

export function parseContentInsetBottomPx(value: unknown) {
  return parseClampedInteger(
    value,
    MIN_CONTENT_INSET_BOTTOM_PX,
    MAX_CONTENT_INSET_BOTTOM_PX,
    DEFAULT_CONTENT_INSET_BOTTOM_PX,
  );
}

export function parseMobileControlsScalePercent(value: unknown) {
  return parseClampedInteger(
    value,
    MIN_MOBILE_CONTROLS_SCALE_PERCENT,
    MAX_MOBILE_CONTROLS_SCALE_PERCENT,
    DEFAULT_MOBILE_CONTROLS_SCALE_PERCENT,
  );
}

export function parseAgentFeaturesInTabs(
  value: unknown,
  fallback = DEFAULT_AGENT_FEATURES_IN_TABS,
) {
  return typeof value === "boolean" ? value : fallback;
}

export function parseMultiHostSpaceSelection(
  value: unknown,
  fallback = DEFAULT_MULTI_HOST_SPACE_SELECTION,
) {
  return typeof value === "boolean" ? value : fallback;
}

export function parseVoiceSubmitEnabled(
  value: unknown,
  fallback = DEFAULT_VOICE_SUBMIT_ENABLED,
) {
  return typeof value === "boolean" ? value : fallback;
}

function parseClampedInteger(value: unknown, min: number, max: number, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * One-time reset of a saved "Bottom padding" on phones. Before the controls bar
 * cleared the home-indicator inset itself, people added bottom padding by hand to
 * keep the bar off the indicator; that padding is now a dead strip under the input.
 * The marker makes the reset a one-off, so a value set again afterwards is kept.
 */
export const PHONE_BOTTOM_INSET_RESET_KEY = "herdr.mobileWeb.phoneBottomInsetReset.v1";

/** True exactly once per browser profile, on the first phone-width read. */
export function consumePhoneBottomInsetReset(
  storage: Pick<Storage, "getItem" | "setItem">,
  isPhone: boolean,
) {
  if (!isPhone || storage.getItem(PHONE_BOTTOM_INSET_RESET_KEY) !== null) {
    return false;
  }
  storage.setItem(PHONE_BOTTOM_INSET_RESET_KEY, "1");
  return true;
}

/** Zeroes a saved bottom padding in a parsed prefs object; true when it changed. */
export function clearSavedBottomInset(parsed: { contentInsetBottomPx?: unknown }) {
  if (parseContentInsetBottomPx(parsed.contentInsetBottomPx) === DEFAULT_CONTENT_INSET_BOTTOM_PX) {
    return false;
  }
  parsed.contentInsetBottomPx = DEFAULT_CONTENT_INSET_BOTTOM_PX;
  return true;
}

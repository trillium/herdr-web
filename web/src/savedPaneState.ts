import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";

export const SHARED_NAVIGATION_PREFS_KEY = "herdr.mobileWeb.sharedNavigation.v1";
export const LEGACY_DISPLAY_PREFS_KEY = "herdr.mobileWeb.displayPrefs.v1";

const SAVED_PANE_STATE_KEYS = [SHARED_NAVIGATION_PREFS_KEY, LEGACY_DISPLAY_PREFS_KEY];

/**
 * Drops this device's remembered pane/workspace selection so the next load
 * starts from the bridge's own view. Display preferences (theme, font size) are
 * deliberately kept: only stale pane references mangle the shared UI.
 */
export async function clearSavedPaneState(
  storage: Pick<Storage, "removeItem"> | null = browserLocalStorage(),
) {
  for (const key of SAVED_PANE_STATE_KEYS) {
    try {
      storage?.removeItem(key);
    } catch {
      // Storage can be unavailable in private or locked-down browser contexts.
    }
  }
  if (Capacitor.isNativePlatform()) {
    for (const key of SAVED_PANE_STATE_KEYS) {
      try {
        await Preferences.remove({ key });
      } catch {
        // Native preferences are a best-effort backup of the browser copy.
      }
    }
  }
}

function browserLocalStorage() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

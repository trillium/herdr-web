import { useSyncExternalStore } from "react";

/** Phone-width viewports: the same breakpoint the stylesheet uses for the compact layout. */
export const PHONE_LAYOUT_QUERY = "(max-width: 820px)";

function subscribe(onChange: () => void) {
  const list = typeof window === "undefined" ? null : window.matchMedia?.(PHONE_LAYOUT_QUERY);
  list?.addEventListener?.("change", onChange);
  return () => list?.removeEventListener?.("change", onChange);
}

function getSnapshot() {
  return typeof window !== "undefined" && window.matchMedia?.(PHONE_LAYOUT_QUERY).matches === true;
}

/** True on a phone-width viewport. Environments without matchMedia (tests, SSR) read as desktop. */
export function usePhoneLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

import { useSyncExternalStore } from "react";

/** Where the composer's "next agent" button sits relative to Submit. */
export type NextAgentSide = "opposite" | "same";

const KEY = "herdr-web:next-agent-side";
const listeners = new Set<() => void>();

export function readNextAgentSide(): NextAgentSide {
  try {
    return globalThis.localStorage?.getItem(KEY) === "same" ? "same" : "opposite";
  } catch {
    return "opposite";
  }
}

export function writeNextAgentSide(side: NextAgentSide) {
  try {
    globalThis.localStorage?.setItem(KEY, side);
  } catch {
    // Storage unavailable: setting just won't persist.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useNextAgentSide(): NextAgentSide {
  return useSyncExternalStore(subscribe, readNextAgentSide, () => "opposite" as const);
}

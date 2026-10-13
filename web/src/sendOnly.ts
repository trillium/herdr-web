// Send-only page: show Herdr's focused pane and submit text through the
// bridge's existing /api/command allow-list. This module never opens a terminal.

import { apiErrorMessage, type BridgeHttpUrl } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { displayTabLabel } from "./state";
import { parseTheme, type Theme } from "./theme";
import type { Snapshot } from "./types";

export const SEND_ONLY_PATH = "/send";
export const PRESS_ENTER_STORAGE_KEY = "herdr-web.sendOnly.pressEnter";
export const DISPLAY_PREFS_STORAGE_KEY = "herdr.mobileWeb.displayPrefs.v2";
export const SEND_ONLY_POLL_MS = 2000;

const ENTER_KEY = "Enter";

export type FocusedPaneView = {
  paneId: string;
  workspaceId: string;
  workspaceLabel: string;
  tabId: string;
  tabLabel: string;
  agent: string;
  cwd: string;
};

export type FocusedSendRequest = {
  method: "pane.send_text" | "pane.send_input";
  params: Record<string, unknown>;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function isSendOnlyPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return path === SEND_ONLY_PATH;
}

/** The one pane Herdr reports as focused. Zero or several means there is no target. */
export function focusedPaneFromSnapshot(snapshot: Snapshot): FocusedPaneView | null {
  const focused = snapshot.panes.filter((pane) => pane.focused);
  if (focused.length !== 1) {
    return null;
  }
  const pane = focused[0];
  const workspace = snapshot.workspaces.find((item) => item.workspace_id === pane.workspace_id);
  const tab = snapshot.tabs.find((item) => item.tab_id === pane.tab_id);
  const agent = pane.display_agent || pane.agent || "shell";
  const cwd = pane.foreground_cwd || pane.cwd || "";
  return {
    paneId: pane.pane_id,
    workspaceId: pane.workspace_id,
    workspaceLabel: workspace?.label || pane.workspace_id,
    tabId: pane.tab_id,
    tabLabel: tab ? displayTabLabel(tab, snapshot.panes) : pane.tab_id,
    agent,
    cwd,
  };
}

/**
 * `pane.send_input` with a single Enter key is Herdr's "type this, then press
 * Enter" path. `pane.send_text` writes the bytes and stops.
 */
export function focusedSendRequest(
  paneId: string,
  text: string,
  pressEnter: boolean,
): FocusedSendRequest {
  if (pressEnter) {
    return {
      method: "pane.send_input",
      params: { pane_id: paneId, text, keys: [ENTER_KEY] },
    };
  }
  return {
    method: "pane.send_text",
    params: { pane_id: paneId, text },
  };
}

export async function postFocusedSend(
  httpUrl: BridgeHttpUrl,
  paneId: string,
  text: string,
  pressEnter: boolean,
): Promise<void> {
  const request = focusedSendRequest(paneId, text, pressEnter);
  const response = await fetchWithTimeout(httpUrl("/api/command"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const message = (await apiErrorMessage(response)) ?? `send failed (${response.status})`;
    throw new Error(message);
  }
}

export function readPressEnter(storage: StorageReader): boolean {
  return storage.getItem(PRESS_ENTER_STORAGE_KEY) !== "0";
}

export function writePressEnter(pressEnter: boolean, storage: StorageWriter): void {
  storage.setItem(PRESS_ENTER_STORAGE_KEY, pressEnter ? "1" : "0");
}

export function readStoredTheme(storage: StorageReader): Theme {
  try {
    const raw = storage.getItem(DISPLAY_PREFS_STORAGE_KEY);
    if (!raw) {
      return "dark";
    }
    const parsed = JSON.parse(raw) as { theme?: unknown };
    return parseTheme(parsed.theme);
  } catch {
    return "dark";
  }
}

export type SnapshotEventSocket = {
  addEventListener(type: "message" | "open" | "close", listener: () => void): void;
  close(): void;
};

/** Refresh trigger for `/ws/events`. Reconnects until `close`. Never a terminal socket. */
export function openSnapshotEvents(
  url: string,
  onEvent: () => void,
  connect: (url: string) => SnapshotEventSocket,
  schedule: (delayMs: number, retry: () => void) => number = (delayMs, retry) =>
    window.setTimeout(retry, delayMs),
  cancel: (timer: number) => void = (timer) => window.clearTimeout(timer),
): { close: () => void } {
  let closed = false;
  let socket: SnapshotEventSocket | null = null;
  let timer: number | null = null;
  let attempts = 0;

  const connectNow = () => {
    if (closed) {
      return;
    }
    const next = connect(url);
    socket = next;
    next.addEventListener("message", () => {
      if (!closed && socket === next) {
        onEvent();
      }
    });
    next.addEventListener("open", () => {
      attempts = 0;
    });
    next.addEventListener("close", () => {
      if (closed || socket !== next || timer !== null) {
        return;
      }
      const delay = Math.min(500 * 2 ** attempts, 5000);
      attempts += 1;
      timer = schedule(delay, () => {
        timer = null;
        connectNow();
      });
    });
  };

  connectNow();
  return {
    close() {
      closed = true;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      socket?.close();
    },
  };
}

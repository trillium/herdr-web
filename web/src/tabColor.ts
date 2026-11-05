import type { PaneInfo, Snapshot, TabInfo, WorkspaceInfo } from "./types";

// Every herdr tab gets one stable colour so the chrome around the terminal says which tab
// you are in at a glance. The hue is picked from a curated, evenly spread palette by a hash
// of the tab's identity, so a tab keeps its colour across reloads, devices and reorders.
// Saturation and lightness live in styles.css (`--tab-color`, one setting per theme) and the
// terminal canvas is never tinted: the colour only frames the content.
export const TAB_HUES = [2, 24, 42, 76, 128, 160, 184, 206, 232, 262, 292, 326] as const;

function hashString(value: string): number {
  // FNV-1a, 32 bit.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * What a tab's colour is derived from: its name once someone has named it (renaming a tab
 * to the same name on another machine gives the same colour), otherwise its id. Never the
 * pane title shown for unnamed tabs, which changes as programs start and stop.
 */
export function tabColorKey(tab: Pick<TabInfo, "tab_id" | "label">): string {
  const label = tab.label.trim();
  return label && !/^\d+$/u.test(label) ? `name:${label.toLowerCase()}` : `id:${tab.tab_id}`;
}

export function tabHue(tab: Pick<TabInfo, "tab_id" | "label">): number {
  return TAB_HUES[hashString(tabColorKey(tab)) % TAB_HUES.length];
}

/** The tab the stage is showing: the selected pane's tab, else the workspace's active tab. */
export function activeTabId(
  activeSpace: Pick<WorkspaceInfo, "workspace_id" | "active_tab_id">,
  selectedPane: Pick<PaneInfo, "workspace_id" | "tab_id"> | null,
): string {
  return selectedPane && selectedPane.workspace_id === activeSpace.workspace_id
    ? selectedPane.tab_id
    : activeSpace.active_tab_id;
}

export function activeTab(
  snapshot: Pick<Snapshot, "tabs"> | null,
  activeSpace: Pick<WorkspaceInfo, "workspace_id" | "active_tab_id"> | null,
  selectedPane: Pick<PaneInfo, "workspace_id" | "tab_id"> | null,
): TabInfo | null {
  if (!snapshot || !activeSpace) {
    return null;
  }
  const tabId = activeTabId(activeSpace, selectedPane);
  return snapshot.tabs.find((tab) => tab.tab_id === tabId) ?? null;
}

const SAFE_COLOR = /^#[0-9a-f]{3,8}$/iu;

/**
 * CSS custom properties for the stage. `--tab-h` drives the tab colour and `--machine-color`
 * (the bridge's own colour) is blended in, so the same tab on two machines still differs.
 */
export function tabColorVars(
  tab: Pick<TabInfo, "tab_id" | "label"> | null,
  machineColor?: string | null,
): Record<string, string> {
  if (!tab) {
    return {};
  }
  const vars: Record<string, string> = { "--tab-h": String(tabHue(tab)) };
  if (machineColor && SAFE_COLOR.test(machineColor)) {
    vars["--machine-color"] = machineColor;
  }
  return vars;
}

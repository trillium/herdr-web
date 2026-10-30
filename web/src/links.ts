// Links & notes page: what agents hand off through `herdr-web-bridge link` / POST /api/links.
// Pure helpers and bridge calls only; LinksPage.tsx owns the rendering.

import { apiErrorMessage } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";

export const LINKS_PATH = "/links";
export const LINKS_POLL_MS = 3000;

export type LinkKind = "link" | "note";

export type LinkEntry = {
  id: string;
  kind: LinkKind;
  title: string;
  url?: string;
  body?: string;
  source?: string;
  pane_id?: string;
  created_at: string;
  updated_at: string;
  count: number;
  opened_at?: string;
  dismissed_at?: string;
};

export type LinkAction = "open" | "dismiss" | "restore";

export function isLinksPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return path === LINKS_PATH;
}

/**
 * Entries become clickable anchors, so only plain http(s) URLs may be linked. The bridge enforces
 * the same rule on write; this is the render-side belt for anything already in the store.
 */
export function safeHttpUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

export function linkHost(url: string | undefined): string {
  const safe = safeHttpUrl(url);
  if (!safe) {
    return "";
  }
  return new URL(safe).host;
}

export function isNewEntry(entry: LinkEntry): boolean {
  return !entry.opened_at && !entry.dismissed_at;
}

export function countNewEntries(entries: LinkEntry[]): number {
  return entries.filter(isNewEntry).length;
}

/** Short "5m ago" label from a bridge millisecond-epoch string. Empty when unparseable. */
export function relativeTime(epochMs: string, nowMs: number): string {
  const then = Number(epochMs);
  if (!Number.isFinite(then) || then <= 0) {
    return "";
  }
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export async function fetchLinks(includeDismissed: boolean): Promise<LinkEntry[]> {
  const query = includeDismissed ? "?include_dismissed=true" : "";
  const response = await fetchWithTimeout(`/api/links${query}`);
  if (!response.ok) {
    throw new Error((await apiErrorMessage(response)) ?? `links failed (${response.status})`);
  }
  const parsed = (await response.json()) as { entries?: unknown };
  return Array.isArray(parsed.entries) ? (parsed.entries as LinkEntry[]) : [];
}

export async function postLinkAction(id: string, action: LinkAction): Promise<void> {
  const response = await fetchWithTimeout(`/api/links/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error((await apiErrorMessage(response)) ?? `${action} failed (${response.status})`);
  }
}

export function linksButtonLabel(newCount: number): string {
  return newCount > 0 ? `Open links (${newCount} new)` : "Open links";
}

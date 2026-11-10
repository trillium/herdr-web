// Text-only capture of URLs printed in a terminal pane, so they land on the /links page instead of
// scrolling away. Pure helpers plus the bridge call; terminalRenderer.ts owns reading the buffer.
// OSC 8 link targets are deliberately not recovered: ghostty-web 0.4.0 cannot expose them, so a
// link whose visible text is a label rather than the URL does not surface here (named follow-up).

import { apiErrorMessage, type BridgeHttpUrl } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";
import { openableHttpUrl, trimUrlPunctuation } from "./terminalSelection";

export const PANE_LINKS_SOURCE = "terminal";
/** Rows above the viewport that each scan also reads, so URLs scrolled off between scans are kept. */
export const PANE_LINKS_SCROLLBACK_ROWS = 200;
export const PANE_LINKS_SCAN_DEBOUNCE_MS = 750;
export const PANE_LINKS_MAX_INGEST_BYTES = 48 * 1024;
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>`]+/giu;

export type PaneLinkRow = {
  text: string;
  /**
   * True when this row continues the previous one (ghostty-web `IBufferLine.isWrapped`). The
   * flag's polarity is the dependency's, not ours: a row that exactly fills the width is reported
   * as NOT wrapped, so it never joins by accident. Pinned by a test; re-check on a ghostty-web bump.
   */
  continuation: boolean;
};

/** Joins soft-wrapped rows back into the logical lines the program printed. */
export function logicalLines(rows: readonly PaneLinkRow[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (row.continuation && lines.length > 0) {
      lines[lines.length - 1] = lines[lines.length - 1].trimEnd() + row.text;
    } else {
      lines.push(row.text);
    }
  }
  return lines;
}

/** Normalised, de-duplicated http(s) URLs in the order first seen. */
export function urlsInRows(rows: readonly PaneLinkRow[]): string[] {
  const found = new Set<string>();
  for (const line of logicalLines(rows)) {
    for (const match of line.matchAll(URL_PATTERN)) {
      const url = openableHttpUrl(trimUrlPunctuation(match[0]));
      if (url) {
        found.add(url);
      }
    }
  }
  return [...found];
}

/** Remembers what was already sent so each URL is posted once per page load. */
export class PaneLinkDeduper {
  readonly #sent = new Set<string>();

  fresh(urls: readonly string[]): string[] {
    return urls.filter((url) => !this.#sent.has(url));
  }

  markSent(urls: readonly string[]) {
    for (const url of urls) {
      this.#sent.add(url);
    }
  }

}

export function paneLinkIngestBody(paneId: string, urls: readonly string[]) {
  return JSON.stringify({
    links: urls.map((url) => ({ url, source: PANE_LINKS_SOURCE, pane_id: paneId })),
  });
}

export function nextPaneLinkIngestBatch(paneId: string, urls: readonly string[]) {
  const batch: string[] = [];
  for (const url of urls) {
    const candidate = [...batch, url];
    if (
      new TextEncoder().encode(paneLinkIngestBody(paneId, candidate)).byteLength >
      PANE_LINKS_MAX_INGEST_BYTES
    ) {
      break;
    }
    batch.push(url);
  }
  return batch;
}

/** Returns false when the bridge has no such route (older bridge, remote proxy): stop capturing. */
export async function ingestPaneLinks(
  httpUrl: BridgeHttpUrl,
  paneId: string,
  urls: readonly string[],
): Promise<boolean> {
  const response = await fetchWithTimeout(httpUrl("/api/links/ingest"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: paneLinkIngestBody(paneId, urls),
  });
  if (response.ok) {
    return true;
  }
  if (response.status === 404 || response.status === 403) {
    return false;
  }
  throw new Error((await apiErrorMessage(response)) ?? `link ingest failed (${response.status})`);
}

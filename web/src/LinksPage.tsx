import { useCallback, useEffect, useState } from "react";
import { buildWsUrl } from "./bridge";
import {
  LINKS_POLL_MS,
  countNewEntries,
  fetchLinks,
  isNewEntry,
  linkHost,
  postLinkAction,
  relativeTime,
  safeHttpUrl,
  type LinkAction,
  type LinkEntry,
} from "./links";
import { openSnapshotEvents, readStoredTheme } from "./sendOnly";
import { applyTheme } from "./theme";

export function LinksPage() {
  const [entries, setEntries] = useState<LinkEntry[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      setEntries(await fetchLinks(showDismissed));
      setLoad("ready");
      setError(null);
      setNow(Date.now());
    } catch (err) {
      setLoad("error");
      setError(err instanceof Error ? err.message : "links failed");
    }
  }, [showDismissed]);

  useEffect(() => {
    applyTheme(document, readStoredTheme(window.localStorage));
  }, []);

  useEffect(() => {
    const newCount = countNewEntries(entries);
    document.title = newCount > 0 ? `(${newCount}) Links · herdr-web` : "Links · herdr-web";
  }, [entries]);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) {
        void refresh();
      }
    };
    tick();
    // The `link` CLI writes the store directly and cannot broadcast, so polling is the baseline;
    // the ui-events socket only makes HTTP-published entries show up sooner.
    const interval = window.setInterval(tick, LINKS_POLL_MS);
    const events = openSnapshotEvents(
      buildWsUrl(null, "/ws/ui-events"),
      tick,
      (url) => new WebSocket(url),
    );
    return () => {
      stopped = true;
      window.clearInterval(interval);
      events.close();
    };
  }, [refresh]);

  async function act(entry: LinkEntry, action: LinkAction) {
    try {
      await postLinkAction(entry.id, action);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${action} failed`);
    }
    void refresh();
  }

  const newCount = countNewEntries(entries);

  return (
    <main className="links-page">
      <header className="links-header">
        <p className="links-kicker">Links &amp; notes</p>
        <h1>Handed off to you</h1>
        <a className="links-terminal-link" href="/">
          Open terminal
        </a>
      </header>

      <div className="links-toolbar">
        <span className="links-count" role="status" aria-live="polite">
          {newCount > 0 ? `${newCount} new` : "Nothing new"}
        </span>
        <label className="links-toggle">
          <input
            type="checkbox"
            checked={showDismissed}
            onChange={(event) => setShowDismissed(event.target.checked)}
          />
          Show dismissed
        </label>
      </div>

      {error ? (
        <p className="links-empty" role="alert">
          {load === "error" ? `Bridge unavailable. ${error}` : error}
        </p>
      ) : null}

      {load === "loading" ? <p className="links-empty">Loading…</p> : null}
      {load === "ready" && entries.length === 0 ? (
        <p className="links-empty">
          Nothing here yet. Agents add items with{" "}
          <code>herdr-web-bridge link https://example.com</code>.
        </p>
      ) : null}

      <ul className="links-list">
        {entries.map((entry) => (
          <LinkRow key={entry.id} entry={entry} now={now} onAction={act} />
        ))}
      </ul>
    </main>
  );
}

function LinkRow({
  entry,
  now,
  onAction,
}: {
  entry: LinkEntry;
  now: number;
  onAction: (entry: LinkEntry, action: LinkAction) => void;
}) {
  const href = safeHttpUrl(entry.url);
  const dismissed = Boolean(entry.dismissed_at);
  const meta = [
    entry.source,
    entry.pane_id ? `pane ${entry.pane_id}` : null,
    relativeTime(entry.updated_at, now),
    entry.count > 1 ? `sent ${entry.count}×` : null,
  ].filter(Boolean);

  return (
    <li
      className="links-item"
      data-kind={entry.kind}
      data-new={isNewEntry(entry) ? "true" : "false"}
      data-dismissed={dismissed ? "true" : "false"}
    >
      <div className="links-item-main">
        {isNewEntry(entry) ? <span className="links-badge">New</span> : null}
        {href ? (
          <a
            className="links-item-title"
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => onAction(entry, "open")}
          >
            {entry.title}
          </a>
        ) : (
          <span className="links-item-title">{entry.title}</span>
        )}
        {href ? <span className="links-item-host mono">{linkHost(href)}</span> : null}
        {entry.body ? <p className="links-item-body">{entry.body}</p> : null}
        <p className="links-item-meta">{meta.join(" · ")}</p>
      </div>
      <div className="links-item-actions">
        {dismissed ? (
          <button type="button" className="btn" onClick={() => onAction(entry, "restore")}>
            Restore
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => onAction(entry, "dismiss")}>
            Dismiss
          </button>
        )}
      </div>
    </li>
  );
}

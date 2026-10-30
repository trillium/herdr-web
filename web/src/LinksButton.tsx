import { Link2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { LINKS_PATH, LINKS_POLL_MS, countNewEntries, fetchLinks, linksButtonLabel } from "./links";

// One poll shared by every mounted button (sidebar header and stage bar can both be on screen).
let sharedCount = 0;
const subscribers = new Set<() => void>();
let pollTimer: number | undefined;

function pollOnce() {
  fetchLinks(false)
    .then((entries) => {
      const next = countNewEntries(entries);
      if (next !== sharedCount) {
        sharedCount = next;
        subscribers.forEach((notify) => notify());
      }
    })
    .catch(() => {
      // Keep the last known count; the next poll retries.
    });
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  if (subscribers.size === 1) {
    pollOnce();
    pollTimer = window.setInterval(pollOnce, LINKS_POLL_MS);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0) {
      window.clearInterval(pollTimer);
      sharedCount = 0;
    }
  };
}

/** Always-visible entry point to /links with the unopened count; polls no faster than the page. */
export function LinksButton() {
  const newCount = useSyncExternalStore(subscribe, () => sharedCount);

  return (
    <a
      className="icon-btn links-open-btn"
      href={LINKS_PATH}
      aria-label={linksButtonLabel(newCount)}
      title={linksButtonLabel(newCount)}
    >
      <Link2 size={18} />
      {newCount > 0 ? (
        <span className="links-open-count" data-testid="links-open-count">
          {newCount > 99 ? "99+" : newCount}
        </span>
      ) : null}
    </a>
  );
}

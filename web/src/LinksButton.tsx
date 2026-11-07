import { Link2 } from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LINKS_POLL_MS, countNewEntries, fetchLinks, linksButtonLabel } from "./links";

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

const LinksPage = lazy(() => import("./LinksPage").then((m) => ({ default: m.LinksPage })));

/** Always-visible entry point to /links with the unopened count; polls no faster than the page. */
export function LinksButton() {
  const newCount = useSyncExternalStore(subscribe, () => sharedCount);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    sheetRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      button?.focus();
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn links-open-btn"
        aria-label={linksButtonLabel(newCount)}
        title={linksButtonLabel(newCount)}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Link2 size={18} />
        {newCount > 0 ? (
          <span className="links-open-count" data-testid="links-open-count">
            {newCount > 99 ? "99+" : newCount}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="links-modal-backdrop"
          data-testid="links-modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div className="links-modal" ref={sheetRef} tabIndex={-1}>
            <Suspense fallback={<p className="links-empty">Loading…</p>}>
              <LinksPage onClose={() => setOpen(false)} />
            </Suspense>
          </div>
        </div>
      ) : null}
    </>
  );
}

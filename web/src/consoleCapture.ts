// Console capture (task-gu0ka signal 7): the phone voice loop can die in
// ways no voice beacon covers (a render throw, a rejected eval promise), so
// beam `window.onerror` + `unhandledrejection` to the client-log pipeline as
// `console-error` events. Sampled (at most MAX_PER_MINUTE per rolling
// minute), size-capped (one truncated message line each), and scrubbed to
// printable ASCII with URLs and token-shaped query/fragment values stripped —
// no PII beyond the user's own box text, which may appear inside an error
// message and is truncated to a short preview.

export type ConsoleCaptureSampler = (kind: string, detail: string) => void;

const MAX_PER_MINUTE = 8;
const MAX_MESSAGE_CHARS = 80;

/** Per-minute budget; injectable clock/counter for tests. */
export class ConsoleCaptureBudget {
  private windowStart = 0;
  private used = 0;

  constructor(private now: () => number = () => Date.now()) {}

  /** True when this error may beam (and consumes one budget slot). */
  take(): boolean {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.used = 0;
    }
    if (this.used >= MAX_PER_MINUTE) {
      return false;
    }
    this.used += 1;
    return true;
  }
}

/**
 * Scrub a raw error message for the log: single line, printable ASCII,
 * URLs reduced to their host (paths/queries may carry tokens), capped.
 */
export function scrubConsoleMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw ?? "");
  const singleLine = text.replace(/[\s]+/g, " ").trim();
  const deUrl = singleLine.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/]+)[^\s]*/g,
    "$1$2",
  );
  const printable = deUrl.replace(/[^ -~]/g, "");
  const capped = printable.slice(0, MAX_MESSAGE_CHARS).trim();
  return capped || "unknown-error";
}

/** `src=onerror msg="..."` — sized for the 120-char client log cap. */
export function formatConsoleErrorDetail(
  source: "onerror" | "unhandledrejection",
  message: unknown,
): string {
  const scrubbed = scrubConsoleMessage(message).replace(/"/g, "'");
  return `src=${source} msg="${scrubbed}"`;
}

function messageFromEvent(event: ErrorEvent): string {
  if (typeof event.message === "string" && event.message) {
    return event.message;
  }
  const err = event.error;
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "unknown-error";
}

function messageFromRejection(reason: unknown): unknown {
  if (reason instanceof Error && reason.message) {
    return reason.message;
  }
  return reason;
}

/**
 * Install the page-global console capture. Returns a teardown. The sampler
 * defaults to the shared client-log beacon; logging never throws back into
 * the page. Safe to call once per page load (main.tsx).
 */
export function installConsoleCapture(
  sampler: ConsoleCaptureSampler,
  budget: ConsoleCaptureBudget = new ConsoleCaptureBudget(),
): () => void {
  const onError = (event: ErrorEvent) => {
    try {
      if (budget.take()) {
        sampler("console-error", formatConsoleErrorDetail("onerror", messageFromEvent(event)));
      }
    } catch {
      // Capture must never break the page it observes.
    }
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    try {
      if (budget.take()) {
        sampler(
          "console-error",
          formatConsoleErrorDetail("unhandledrejection", messageFromRejection(event.reason)),
        );
      }
    } catch {
      // Capture must never break the page it observes.
    }
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

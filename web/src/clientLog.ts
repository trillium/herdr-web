// Client log pipeline: the phone is a black box. Page-side voice-loop
// flight-recorder events are beamed to POST /api/client-log, where the
// bridge appends them to its file log (`herdr-web.log`). Seven signals:
// (1) page-load / voice-toggle carry the bundle hash + voice toggle state;
// (2) sse-open / sse-drop carry a stream autopsy (readyState, time-to-drop,
// error class, messages received between drops); (3) eval-ok / eval-fail
// carry status, latency, and answered verb per round trip; (4) ender-match
// traces the ender tail, matched phrase, stripped remainder, and re-verify
// verdict; (5) submit-fired / submit-dropped / submit-ack trace the submit
// attempt (guard verdict on every drop, bridge answer on every post);
// (6) fallback-engaged / fallback-standdown bracket the local fallback with
// causes; (7) console-error beams window.onerror + unhandledrejection.
//
// Small and sampled: eval-ok is sampled, everything else fires on transition
// only, identical lines coalesce, and the queue is bounded. Ender-match
// tails and console messages are truncated previews of the user's own box —
// statuses, guard reasons, and counters everywhere else; never URLs, never
// tokens.
//
// `ender-result` carries the harden-step detail vocabulary (fixed strings
// only, never buffer text):
//   armed / armed-require-tail / cancelled ......... advisory timer verbs
//   submitnow-tail-ok ............................. server tail verified
//   submitnow-applied ............................. text submitNow, no tail
//   submitnow-only-ender .......................... buffer was just the tail
//   submitnow-tail-stale .......................... buffer moved past the tail
//   <verb>-rejected-stale ......................... stale envelope dropped
//   resync / rejected-protocol .................... envelope-level outcomes
//   fallback-no-tail .............................. local re-verify missed
//   fallback-stood-down ........................... stream recovered first

export type ClientLogKind =
  | "eval-ok"
  | "eval-fail"
  | "sse-open"
  | "sse-drop"
  | "fallback-engaged"
  | "fallback-standdown"
  | "submit-fired"
  | "submit-dropped"
  | "submit-ack"
  | "ender-match"
  | "ender-result"
  | "page-load"
  | "voice-toggle"
  | "console-error";

const CLIENT_LOG_KINDS: readonly string[] = [
  "eval-ok",
  "eval-fail",
  "sse-open",
  "sse-drop",
  "fallback-engaged",
  "fallback-standdown",
  "submit-fired",
  "submit-dropped",
  "submit-ack",
  "ender-match",
  "ender-result",
  "page-load",
  "voice-toggle",
  "console-error",
];

export type ClientLogEvent = {
  t: number;
  kind: ClientLogKind;
  detail?: string;
};

const MAX_QUEUED_EVENTS = 32;
const MAX_DETAIL_CHARS = 120;
/** eval-ok is chatty (one per settled keystroke burst); sample it down. */
const EVAL_OK_SAMPLE_EVERY = 20;
const COALESCE_WINDOW_MS = 10_000;

type FetchFn = (input: string, init?: Record<string, unknown>) => Promise<unknown>;

function sanitizeDetail(detail: unknown): string | undefined {
  if (typeof detail !== "string") {
    return undefined;
  }
  // Statuses and guard reasons only: printable ASCII, truncated.
  const cleaned = detail.replace(/[^ -~]/g, "").slice(0, MAX_DETAIL_CHARS);
  return cleaned ? cleaned : undefined;
}

/**
 * Best-effort beacon for input-loop events. Failures are swallowed: logging
 * must never break the box it observes.
 */
export class ClientLogBeacon {
  private queue: ClientLogEvent[] = [];
  private evalOkCount = 0;
  private lastFlushAt = 0;
  private lastLineByKey = new Map<string, number>();

  constructor(
    private fetchImpl: FetchFn = (...args) => fetch(...args),
    private now: () => number = () => Date.now(),
  ) {}

  log(kind: ClientLogKind, detail?: string): void {
    if (!CLIENT_LOG_KINDS.includes(kind)) {
      return;
    }
    if (kind === "eval-ok") {
      this.evalOkCount += 1;
      if (this.evalOkCount % EVAL_OK_SAMPLE_EVERY !== 0) {
        return;
      }
    }
    const event: ClientLogEvent = { t: this.now(), kind };
    const clean = sanitizeDetail(detail);
    if (clean !== undefined) {
      event.detail = clean;
    }
    // Coalesce identical lines (e.g. reconnect storms) within a short window.
    const key = `${kind}\n${event.detail ?? ""}`;
    const last = this.lastLineByKey.get(key) ?? -Infinity;
    if (event.t - last < COALESCE_WINDOW_MS) {
      return;
    }
    this.lastLineByKey.set(key, event.t);
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      this.queue.shift();
    }
    this.queue.push(event);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) {
      return;
    }
    const events = this.queue;
    this.queue = [];
    this.lastFlushAt = this.now();
    try {
      await this.fetchImpl("/api/client-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        keepalive: true,
      });
    } catch {
      // Best-effort: a logging beacon never retries and never throws.
    }
  }

  /** Test seam: how long ago the last flush attempt ran. */
  lastFlushAgoMs(): number {
    return this.now() - this.lastFlushAt;
  }
}

/** Shared page beacon. Prefer this over constructing beacons per box. */
export const clientLog = new ClientLogBeacon();

export function logClientEvent(kind: ClientLogKind, detail?: string): void {
  clientLog.log(kind, detail);
}

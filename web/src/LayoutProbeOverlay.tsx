import { useCallback, useEffect, useRef, useState } from "react";
import { logClientEvent } from "./clientLog";
import {
  LAYOUT_PROBE_CHANGE_EVENT,
  captureLayoutProbe,
  formatProbeChunks,
  formatProbeLine,
  formatProbeLines,
  gapToViewportBottom,
  readLayoutProbeFlag,
  setLayoutProbeFlag,
} from "./layoutProbe";
import type { LayoutProbeSnapshot } from "./layoutProbe";

const REMEASURE_DEBOUNCE_MS = 400;
const POLL_MS = 2000;

/** Mounts the overlay only while the probe is on, so it costs nothing otherwise. */
export function LayoutProbeHost() {
  const [enabled, setEnabled] = useState(readLayoutProbeFlag);
  useEffect(() => {
    const onChange = (event: Event) => setEnabled((event as CustomEvent<boolean>).detail === true);
    window.addEventListener(LAYOUT_PROBE_CHANGE_EVENT, onChange);
    return () => window.removeEventListener(LAYOUT_PROBE_CHANGE_EVENT, onChange);
  }, []);
  return enabled ? <LayoutProbe /> : null;
}

/**
 * Corner overlay with the measured layout numbers. It outlines the input row, marks the bottom of
 * the layout viewport, and beams the same numbers to the bridge log so they can be read without a
 * screenshot. The overlay ignores pointer events everywhere except its own two buttons.
 */
export function LayoutProbe() {
  const [snap, setSnap] = useState<LayoutProbeSnapshot | null>(null);
  const [sent, setSent] = useState(0);
  const seq = useRef(0);
  const lastLine = useRef("");

  const measure = useCallback(() => {
    const next = captureLayoutProbe();
    setSnap(next);
    return next;
  }, []);

  const send = useCallback((next: LayoutProbeSnapshot) => {
    seq.current += 1;
    // Rides the existing `page-load` kind so an already-deployed bridge accepts it without a
    // rebuild; the sequence number keeps a deliberate re-send from being coalesced.
    for (const chunk of formatProbeChunks(next, seq.current)) {
      logClientEvent("page-load", chunk);
    }
    setSent(seq.current);
  }, []);

  useEffect(() => {
    let timer: number | undefined;
    const settle = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const next = measure();
        const line = formatProbeLine(next);
        // Auto-beam only when the numbers moved; a still page logs once.
        if (line !== lastLine.current) {
          lastLine.current = line;
          send(next);
        }
      }, REMEASURE_DEBOUNCE_MS);
    };
    settle();
    const poll = window.setInterval(settle, POLL_MS);
    window.addEventListener("resize", settle);
    window.addEventListener("orientationchange", settle);
    window.visualViewport?.addEventListener("resize", settle);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      window.removeEventListener("resize", settle);
      window.removeEventListener("orientationchange", settle);
      window.visualViewport?.removeEventListener("resize", settle);
    };
  }, [measure, send]);

  const row = snap?.row ?? null;
  const gap = snap ? gapToViewportBottom(row, snap.innerH) : null;
  return (
    <div className="layout-probe" data-testid="layout-probe">
      {row ? (
        <div
          className="layout-probe-row-outline"
          style={{ top: row.top, height: row.height }}
          aria-hidden="true"
        />
      ) : null}
      {snap && row && gap !== null && gap > 0 ? (
        <div
          className="layout-probe-gap-outline"
          style={{ top: row.bottom, height: gap }}
          aria-hidden="true"
        />
      ) : null}
      <div className="layout-probe-panel">
        <pre className="layout-probe-text">
          {snap ? formatProbeLines(snap).join("\n") : "measuring..."}
        </pre>
        <div className="layout-probe-actions">
          <button
            type="button"
            onClick={() => {
              const next = measure();
              lastLine.current = formatProbeLine(next);
              send(next);
            }}
          >
            Send{sent > 0 ? ` (${sent})` : ""}
          </button>
          <button type="button" onClick={() => setLayoutProbeFlag(false)}>
            Off
          </button>
        </div>
      </div>
    </div>
  );
}

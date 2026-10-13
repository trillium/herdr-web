import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { buildWsUrl } from "./bridge";
import { fetchWithTimeout } from "./fetchWithTimeout";
import {
  SEND_ONLY_POLL_MS,
  focusedPaneFromSnapshot,
  openSnapshotEvents,
  postFocusedSend,
  readPressEnter,
  readStoredTheme,
  writePressEnter,
  type FocusedPaneView,
} from "./sendOnly";
import { applyTheme } from "./theme";
import type { Snapshot } from "./types";

const sameOrigin = (path: string) => path;

export function SendOnlyPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pressEnter, setPressEnter] = useState(() => readPressEnter(window.localStorage));
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [targetChanged, setTargetChanged] = useState(false);
  const seenPaneId = useRef<string | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchWithTimeout("/api/snapshot");
      if (!response.ok) {
        throw new Error(`snapshot failed: ${response.status}`);
      }
      const next = (await response.json()) as Snapshot;
      setSnapshot(next);
      setLoad("ready");
      setBridgeError(null);
    } catch (err) {
      setLoad("error");
      setBridgeError(err instanceof Error ? err.message : "snapshot failed");
    }
  }, []);

  useEffect(() => {
    applyTheme(document, readStoredTheme(window.localStorage));
    document.title = "Send · herdr-web";
  }, []);

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (!stopped) {
        void refresh();
      }
    };
    tick();
    const interval = window.setInterval(tick, SEND_ONLY_POLL_MS);
    const events = openSnapshotEvents(buildWsUrl(null, "/ws/events"), tick, (url) => new WebSocket(url));
    return () => {
      stopped = true;
      window.clearInterval(interval);
      events.close();
    };
  }, [refresh]);

  const target = snapshot ? focusedPaneFromSnapshot(snapshot) : null;
  const targetPaneId = target?.paneId ?? null;

  useEffect(() => {
    if (load !== "ready") {
      return;
    }
    if (seenPaneId.current === undefined) {
      seenPaneId.current = targetPaneId;
      return;
    }
    if (seenPaneId.current !== targetPaneId) {
      seenPaneId.current = targetPaneId;
      setTargetChanged(true);
    }
  }, [load, targetPaneId]);

  const canSend = load === "ready" && target !== null && text.length > 0 && !sending;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!target || !canSend) {
      return;
    }
    const paneId = target.paneId;
    setSending(true);
    setStatus(null);
    try {
      await postFocusedSend(sameOrigin, paneId, text, pressEnter);
      setText("");
      setTargetChanged(false);
      setStatus("Sent");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "send failed");
    } finally {
      setSending(false);
    }
  }

  function onPressEnterChange(next: boolean) {
    setPressEnter(next);
    writePressEnter(next, window.localStorage);
  }

  return (
    <main className="send-only">
      <header className="send-only-header">
        <p className="send-only-kicker">Send only</p>
        <h1>Focused pane</h1>
        <a className="send-only-terminal-link" href="/">
          Open terminal
        </a>
      </header>

      <FocusedPaneCard
        load={load}
        bridgeError={bridgeError}
        target={target}
        targetChanged={targetChanged}
        onDismissChange={() => setTargetChanged(false)}
      />

      <form className="send-only-form" onSubmit={(event) => void onSubmit(event)}>
        <label className="send-only-label" htmlFor="send-only-text">
          Text
        </label>
        <textarea
          id="send-only-text"
          className="send-only-text"
          value={text}
          rows={6}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="send"
          placeholder="Text to insert into the focused pane"
          onChange={(event) => {
            setText(event.target.value);
            setStatus(null);
          }}
        />
        <label className="send-only-enter">
          <input
            type="checkbox"
            checked={pressEnter}
            onChange={(event) => onPressEnterChange(event.target.checked)}
          />
          Press Enter after the text
        </label>
        <button className="btn btn-primary send-only-submit" type="submit" disabled={!canSend}>
          {sending ? "Sending…" : "Send"}
        </button>
        <p className="send-only-status" role="status" aria-live="polite">
          {status}
        </p>
      </form>
    </main>
  );
}

function FocusedPaneCard({
  load,
  bridgeError,
  target,
  targetChanged,
  onDismissChange,
}: {
  load: "loading" | "ready" | "error";
  bridgeError: string | null;
  target: FocusedPaneView | null;
  targetChanged: boolean;
  onDismissChange: () => void;
}) {
  if (load === "loading" && !target) {
    return <p className="send-only-empty">Looking up the focused pane…</p>;
  }
  if (!target) {
    return (
      <p className="send-only-empty" role="status">
        {load === "error" ? `Bridge unavailable. ${bridgeError ?? ""}`.trim() : "No pane is focused."}
      </p>
    );
  }
  return (
    <section
      className="send-only-target"
      data-changed={targetChanged ? "true" : "false"}
      aria-live="polite"
    >
      {targetChanged ? (
        <p className="send-only-changed">
          Focused pane changed. Check the target before sending.
          <button type="button" className="btn" onClick={onDismissChange}>
            Dismiss
          </button>
        </p>
      ) : null}
      <dl>
        <div>
          <dt>Workspace</dt>
          <dd>{target.workspaceLabel}</dd>
        </div>
        <div>
          <dt>Tab</dt>
          <dd>{target.tabLabel}</dd>
        </div>
        <div>
          <dt>Pane</dt>
          <dd className="mono">{target.paneId}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{target.agent}</dd>
        </div>
        <div>
          <dt>Directory</dt>
          <dd className="mono">{target.cwd || "unknown"}</dd>
        </div>
      </dl>
      {load === "error" ? <p className="send-only-empty">{bridgeError}</p> : null}
    </section>
  );
}

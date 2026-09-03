import { useEffect, useState } from "react";
import type { BridgeHttpUrl } from "./bridgeApi";
import { getConnectionsForTerminal, type TerminalConnection } from "./connectionManager";

const VIEWERS_POLL_INTERVAL_MS = 2000;

interface Props {
  terminalId: string;
  httpUrl?: BridgeHttpUrl;
  onConnectionsChange?: (connections: TerminalConnection[]) => void;
}

/**
 * Label for a terminal that several clients are watching.
 *
 * Exported for tests; the singular/zero cases never reach the DOM because the
 * indicator renders nothing below two viewers.
 */
export function terminalViewersLabel(count: number) {
  return count === 1 ? "1 device viewing" : `${count} devices viewing`;
}

/**
 * Names the devices watching a terminal, keeping the list short enough to sit
 * over the terminal without covering it.
 */
export function terminalViewersDetail(connections: TerminalConnection[], limit = 3) {
  const names = connections.map((connection) => connection.nickname).filter(Boolean);
  if (names.length === 0) {
    return "";
  }
  if (names.length <= limit) {
    return names.join(", ");
  }
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
}

/**
 * Passive indicator of how many clients are watching this terminal.
 *
 * The bridge multiplexes one daemon attach out to every connected websocket
 * client, so a second viewer is normal rather than a conflict: output is
 * broadcast to all of them and the pty is sized to the smallest. This replaces
 * a card that presented a priority table and a "⚠ Multiple Connections"
 * warning, implying the extra clients were locked out — nothing in the
 * websocket path ever enforced that, and the phone that rendered the warning
 * was in fact attached the whole time.
 *
 * The nickname and priority endpoints in `connectionManager` stay in place for
 * other clients of the bridge API; this view simply does not drive them.
 */
export default function TerminalViewersCard({
  terminalId,
  httpUrl,
  onConnectionsChange,
}: Props) {
  const [connections, setConnections] = useState<TerminalConnection[]>([]);

  useEffect(() => {
    if (!httpUrl) {
      return;
    }
    let disposed = false;

    async function loadConnections() {
      if (!httpUrl) {
        return;
      }
      try {
        const next = await getConnectionsForTerminal(httpUrl, terminalId);
        if (disposed) {
          return;
        }
        setConnections(next);
        onConnectionsChange?.(next);
      } catch (error) {
        console.debug("Failed to load terminal viewers:", error);
      }
    }

    void loadConnections();
    const interval = setInterval(() => void loadConnections(), VIEWERS_POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
    // Deliberately keyed on the terminal and bridge only: onConnectionsChange
    // is a parent callback, and depending on it would restart polling on every
    // parent render.
  }, [terminalId, httpUrl]);

  // A single viewer is the ordinary case and needs no chrome over the terminal.
  if (connections.length < 2) {
    return null;
  }

  const detail = terminalViewersDetail(connections);
  return (
    <div className="terminal-viewers" role="status" aria-live="polite">
      <span className="terminal-viewers-count">{terminalViewersLabel(connections.length)}</span>
      {detail ? <span className="terminal-viewers-names">{detail}</span> : null}
    </div>
  );
}

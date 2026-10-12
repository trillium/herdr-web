import { apiErrorMessage } from './bridgeApi';
import type { BridgeHttpUrl } from './bridgeApi';
import { fetchWithTimeout } from './fetchWithTimeout';

export interface TerminalConnection {
  client_id: string;
  nickname: string;
  priority: number;
  connected_at: number;
}

export interface TerminalConnectionsResponse {
  connections: Record<string, TerminalConnection[]>;
}

export interface SetPriorityRequest {
  client_id: string;
  priority: number;
}

export interface SetNicknameRequest {
  client_id: string;
  nickname: string;
}

export async function getTerminalConnections(
  httpUrl: BridgeHttpUrl,
): Promise<TerminalConnectionsResponse> {
  const response = await fetchWithTimeout(httpUrl('/api/terminal-connections'));
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response) ?? `Failed to fetch connections`);
  }
  return response.json();
}

export async function getConnectionsForTerminal(
  httpUrl: BridgeHttpUrl,
  terminalId: string,
): Promise<TerminalConnection[]> {
  const response = await fetchWithTimeout(
    httpUrl(`/api/terminal-connections/${encodeURIComponent(terminalId)}`),
  );
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response) ?? `Failed to fetch connections`);
  }
  return response.json();
}

export async function setConnectionPriority(
  httpUrl: BridgeHttpUrl,
  terminalId: string,
  clientId: string,
  priority: number,
): Promise<void> {
  const response = await fetchWithTimeout(
    httpUrl(`/api/terminal-connections/${encodeURIComponent(terminalId)}/priority`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, priority }),
    },
  );
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response) ?? `Failed to set priority`);
  }
}

export async function setConnectionNickname(
  httpUrl: BridgeHttpUrl,
  terminalId: string,
  clientId: string,
  nickname: string,
): Promise<void> {
  const response = await fetchWithTimeout(
    httpUrl(`/api/terminal-connections/${encodeURIComponent(terminalId)}/nickname`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, nickname }),
    },
  );
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response) ?? `Failed to set nickname`);
  }
}

/**
 * Force-disconnects one connected device. Reconnecting stays allowed; with
 * `clearState` the device is also told to drop its saved pane/navigation state
 * (only the device can, since that state lives in its own storage).
 */
export async function kickConnection(
  httpUrl: BridgeHttpUrl,
  clientId: string,
  clearState: boolean,
): Promise<boolean> {
  const response = await fetchWithTimeout(httpUrl('/api/terminal-connections/kick'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, clear_state: clearState }),
  });
  if (!response.ok) {
    throw new Error(await apiErrorMessage(response) ?? `Failed to kick device`);
  }
  const body = (await response.json()) as { kicked?: unknown };
  return body.kicked === true;
}

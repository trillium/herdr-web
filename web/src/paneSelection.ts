/**
 * A pane tap that has been published to the bridge as the shared selection but
 * not yet echoed back in a snapshot.
 */
export type PendingSharedPaneSelection = {
  paneId: string;
  connectionKey: string;
  timeoutId: number;
  /** The shared selection the bridge held at tap time (what the tap replaced). */
  supersededPaneId: string | null;
  /**
   * The echo window closed, or publishing failed, without the bridge confirming
   * the tap. The tap still wins until the bridge's selection moves off
   * `supersededPaneId`, so a stale snapshot cannot send the view back.
   */
  unconfirmed: boolean;
};

/**
 * Shared navigation is a bridge-local feature: it needs `POST /api/selection`
 * and `tab.focus`, neither of which the hub proxies to remote bridges. A remote
 * bridge's `selected_pane_id` therefore never follows taps and must not drive
 * the view.
 */
export function runtimeSharesNavigation(
  navigationShared: boolean,
  runtime: { proxied: boolean } | null | undefined,
) {
  return navigationShared && Boolean(runtime) && !runtime?.proxied;
}

/** Whether the user's tap should still win over the snapshot's selected pane. */
export function pendingSelectionHolds(
  pending: PendingSharedPaneSelection | null | undefined,
  serverSelectedPaneId: string | null | undefined,
) {
  if (!pending) {
    return false;
  }
  if (!pending.unconfirmed) {
    return true;
  }
  const serverPaneId = serverSelectedPaneId ?? null;
  return serverPaneId === pending.supersededPaneId && serverPaneId !== pending.paneId;
}

/**
 * How `chooseSelectedPane*` should treat the bridge's shared `selected_pane_id`
 * for one runtime: whether it is consulted at all, and whether it outranks the
 * pane this client remembers.
 */
export function sharedSelectionPolicy(
  navigationShared: boolean,
  runtime: { proxied: boolean } | null | undefined,
  pending: PendingSharedPaneSelection | null | undefined,
  serverSelectedPaneId: string | null | undefined,
) {
  const useShared = runtimeSharesNavigation(navigationShared, runtime);
  return {
    useShared,
    preferShared: useShared && !pendingSelectionHolds(pending, serverSelectedPaneId),
  };
}

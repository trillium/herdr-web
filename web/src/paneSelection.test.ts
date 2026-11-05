import { describe, expect, it } from "vitest";
import { buildVisibleAgentPaneEntries, buildVisibleScopedWorkspaces } from "./App";
import type { BridgeConnectionView } from "./App";
import type { BridgeRuntime } from "./bridge";
import {
  pendingSelectionHolds,
  runtimeSharesNavigation,
  sharedSelectionPolicy,
  type PendingSharedPaneSelection,
} from "./paneSelection";
import { chooseSelectedPane } from "./state";
import type { PaneInfo, Snapshot } from "./types";

const pending = (
  paneId: string,
  supersededPaneId: string | null,
  unconfirmed = false,
): PendingSharedPaneSelection => ({
  paneId,
  connectionKey: "local",
  timeoutId: 0,
  supersededPaneId,
  unconfirmed,
});

describe("runtimeSharesNavigation", () => {
  it("never shares navigation with a proxied remote bridge", () => {
    expect(runtimeSharesNavigation(true, { proxied: false })).toBe(true);
    expect(runtimeSharesNavigation(true, { proxied: true })).toBe(false);
    expect(runtimeSharesNavigation(false, { proxied: false })).toBe(false);
    expect(runtimeSharesNavigation(true, null)).toBe(false);
  });
});

describe("pendingSelectionHolds", () => {
  it("holds a tap while the bridge's echo is still awaited", () => {
    expect(pendingSelectionHolds(pending("porter", "zephyr"), "zephyr")).toBe(true);
    expect(pendingSelectionHolds(pending("porter", "zephyr"), "someone-else")).toBe(true);
  });

  it("keeps holding an unconfirmed tap while the bridge still reports the pane it replaced", () => {
    expect(pendingSelectionHolds(pending("porter", "zephyr", true), "zephyr")).toBe(true);
    expect(pendingSelectionHolds(pending("porter", null, true), null)).toBe(true);
    expect(pendingSelectionHolds(pending("porter", null, true), undefined)).toBe(true);
  });

  it("releases an unconfirmed tap once the bridge confirms it or another client moves it", () => {
    expect(pendingSelectionHolds(pending("porter", "zephyr", true), "porter")).toBe(false);
    expect(pendingSelectionHolds(pending("porter", "zephyr", true), "yonder")).toBe(false);
  });

  it("holds nothing without a pending tap", () => {
    expect(pendingSelectionHolds(undefined, "zephyr")).toBe(false);
  });

  it("does not hold a re-tap of the pane the bridge already reports", () => {
    expect(pendingSelectionHolds(pending("zephyr", "zephyr", true), "zephyr")).toBe(false);
  });
});

describe("sharedSelectionPolicy", () => {
  it("ignores a remote bridge's selected pane entirely", () => {
    expect(sharedSelectionPolicy(true, { proxied: true }, undefined, "yonder")).toEqual({
      useShared: false,
      preferShared: false,
    });
  });

  it("lets a local bridge's selected pane win only when no tap is held", () => {
    expect(sharedSelectionPolicy(true, { proxied: false }, undefined, "zephyr")).toEqual({
      useShared: true,
      preferShared: true,
    });
    expect(
      sharedSelectionPolicy(true, { proxied: false }, pending("porter", "zephyr", true), "zephyr"),
    ).toEqual({ useShared: true, preferShared: false });
  });
});

// A page kept open while panes are created, closed, pinned and reordered. Both
// bridges contain panes that look alike: same titles, same directory basename
// ("mini0-ops"), and pane ids that are only unique per machine.
describe("tapping a pane in the list lands on exactly that pane", () => {
  const LOCAL = "mini0";
  const REMOTE = "mini1";

  const paneInfo = (
    paneId: string,
    workspaceId: string,
    tabId: string,
    cwd: string,
    overrides: Partial<PaneInfo> = {},
  ): PaneInfo => ({
    pane_id: paneId,
    terminal_id: `term-${LOCAL}-${paneId}`,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused: false,
    cwd,
    agent: "claude",
    agent_status: "done",
    terminal_title_stripped: "Firstmate operational inbox message",
    revision: 1,
    ...overrides,
  });

  const snapshotOf = (panes: PaneInfo[], selected: string | null): Snapshot => {
    const workspaceIds = [...new Set(panes.map((item) => item.workspace_id))];
    const tabIds = [...new Set(panes.map((item) => item.tab_id))];
    return {
      workspaces: workspaceIds.map((workspaceId, index) => ({
        workspace_id: workspaceId,
        number: index + 1,
        label: `2ndmate-${workspaceId}`,
        focused: false,
        pane_count: panes.filter((item) => item.workspace_id === workspaceId).length,
        tab_count: 1,
        active_tab_id: panes.find((item) => item.workspace_id === workspaceId)?.tab_id ?? "",
        agent_status: "done",
      })),
      tabs: tabIds.map((tabId, index) => ({
        tab_id: tabId,
        workspace_id: panes.find((item) => item.tab_id === tabId)?.workspace_id ?? "",
        number: index + 1,
        label: tabId,
        focused: false,
        pane_count: 1,
        agent_status: "done",
      })),
      panes,
      layouts: [],
      selected_pane_id: selected ?? undefined,
    };
  };

  const runtime = (id: string, proxied: boolean): BridgeRuntime => ({
    id,
    mode: "configured",
    proxied,
    label: id,
    color: "#89b4fa",
    backend: null,
    connectionKey: id,
    resumeToken: 0,
    capabilities: null,
    capabilityState: "ready",
    capabilityError: null,
    canConnect: true,
    httpUrl: (path) => `http://${id}${path}`,
    wsUrl: (path) => `ws://${id}${path}`,
  });

  type World = { local: PaneInfo[]; remote: PaneInfo[]; localSelected: string; remoteFocused: string };

  const initialWorld = (): World => ({
    local: [
      // Zephyr: the always-focused second mate; Porter: pinned, same directory basename.
      paneInfo("wK:pBM", "wK", "wK:tBD", "/Users/mini0/fm_home/mini0-ops", { focused: true }),
      paneInfo("wQ:p2", "wQ", "wQ:t2", "/Users/mini0/.treehouse/mini0-ops-0bf32a/1/mini0-ops"),
      paneInfo("wQ:p9", "wQ", "wQ:t9", "/Users/mini0/.treehouse/mini0-ops-0bf32a/1/mini0-ops/projects/portage-forward-frontend"),
    ],
    remote: [
      // Same id and same directory basename as local Zephyr, on another machine.
      paneInfo("wK:pBM", "wK", "wK:tBD", "/Users/mini1/fm_home/mini0-ops", { focused: true }),
      paneInfo("w1F:p3", "w1F", "w1F:t3", "/Users/mini1/.treehouse/coder-e797b1/3/coder"),
      paneInfo("w1F:p4", "w1F", "w1F:t4", "/Users/mini1/.treehouse/coder-e797b1/1/coder"),
    ],
    localSelected: "wK:pBM",
    remoteFocused: "wK:pBM",
  });

  const views = (world: World): BridgeConnectionView[] => [
    {
      runtime: runtime(LOCAL, false),
      snapshot: snapshotOf(world.local, world.localSelected),
      loadState: "ready",
    },
    {
      runtime: runtime(REMOTE, true),
      // A proxied bridge never accepts a selection, so this never follows taps.
      snapshot: snapshotOf(world.remote, world.remoteFocused),
      loadState: "ready",
    },
  ];

  const listEntries = (world: World, pinned: ReadonlySet<string>) => {
    const bridgeViews = views(world);
    const scoped = buildVisibleScopedWorkspaces(bridgeViews, LOCAL, "all", "all", null, {});
    return buildVisibleAgentPaneEntries(
      scoped,
      bridgeViews,
      "all",
      "none",
      "attention",
      pinned,
    );
  };

  /** What the detail view shows after tapping `entry`, as App.tsx resolves it. */
  const tap = (
    world: World,
    entry: { bridgeId: string; pane: PaneInfo },
    held: PendingSharedPaneSelection | undefined,
  ) => {
    const view = views(world).find((candidate) => candidate.runtime.id === entry.bridgeId);
    const policy = sharedSelectionPolicy(
      true,
      view?.runtime,
      view?.runtime.proxied ? undefined : held,
      view?.snapshot?.selected_pane_id,
    );
    return {
      bridgeId: entry.bridgeId,
      paneId: chooseSelectedPane(
        view?.snapshot ?? null,
        entry.pane.pane_id,
        policy.useShared,
        policy.preferShared,
      ),
    };
  };

  const expectEveryTapLandsOnItself = (
    world: World,
    pinned: ReadonlySet<string>,
    held: (entry: { bridgeId: string; pane: PaneInfo }) => PendingSharedPaneSelection | undefined,
  ) => {
    const entries = listEntries(world, pinned);
    expect(entries.length).toBe(world.local.length + world.remote.length);
    for (const entry of entries) {
      expect(tap(world, entry, held(entry))).toEqual({
        bridgeId: entry.bridgeId,
        paneId: entry.pane.pane_id,
      });
    }
  };

  const confirmedTap = (entry: { pane: PaneInfo }, world: World) =>
    // The bridge echoed the tap, so the shared selection is the tapped pane.
    ({ ...world, localSelected: entry.pane.pane_id });

  it("control: the old resolution sends a remote tap to the remote's focused pane", () => {
    const world = initialWorld();
    const remote = views(world)[1];
    const tapped = "w1F:p3";
    expect(chooseSelectedPane(remote.snapshot, tapped, true, true)).toBe("wK:pBM");
  });

  it("lands on the tapped pane for every pane on both bridges, through a live-page sequence", () => {
    let world = initialWorld();
    let pinned: ReadonlySet<string> = new Set();

    // 1. Page opens; the local bridge still reports Zephyr (the herdr-focused pane) as selected.
    expectEveryTapLandsOnItself(world, pinned, (entry) =>
      entry.bridgeId === LOCAL ? pending(entry.pane.pane_id, world.localSelected) : undefined,
    );

    // 2. A pane is created while the page stays open (on each bridge).
    world = {
      ...world,
      local: [
        ...world.local,
        paneInfo("wQ:p15", "wQ", "wQ:t14", "/Users/mini0/.treehouse/mini0-ops-0bf32a/1/mini0-ops"),
      ],
      remote: [
        ...world.remote,
        paneInfo("w1F:p5", "w1F", "w1F:t5", "/Users/mini1/fm_home/mini0-ops"),
      ],
    };
    expectEveryTapLandsOnItself(world, pinned, (entry) =>
      entry.bridgeId === LOCAL ? pending(entry.pane.pane_id, world.localSelected) : undefined,
    );

    // 3. Porter is pinned: the list reorders (pinned first) under the open page.
    pinned = new Set([`${LOCAL}:wQ:p2`]);
    const reordered = listEntries(world, pinned).map((entry) => `${entry.bridgeId}:${entry.pane.pane_id}`);
    expect(reordered.indexOf(`${LOCAL}:wQ:p2`)).toBeLessThan(reordered.indexOf(`${LOCAL}:wK:pBM`));
    expectEveryTapLandsOnItself(world, pinned, (entry) =>
      entry.bridgeId === LOCAL ? pending(entry.pane.pane_id, world.localSelected) : undefined,
    );

    // 4. Zephyr's pane closes; the selected pane the bridge reports vanishes with it.
    world = {
      ...world,
      local: world.local.filter((item) => item.pane_id !== "wK:pBM"),
      localSelected: "wQ:p9",
    };
    expectEveryTapLandsOnItself(world, pinned, (entry) =>
      entry.bridgeId === LOCAL ? pending(entry.pane.pane_id, world.localSelected) : undefined,
    );

    // 5. Unpin and tap through again with the bridge having confirmed each tap.
    pinned = new Set();
    for (const entry of listEntries(world, pinned).filter((item) => item.bridgeId === LOCAL)) {
      world = confirmedTap(entry, world);
      expect(tap(world, entry, undefined).paneId).toBe(entry.pane.pane_id);
    }
  });

  it("keeps a local tap when publishing it failed and the bridge still reports the old pane", () => {
    const world = initialWorld();
    const porter = listEntries(world, new Set()).find(
      (entry) => entry.bridgeId === LOCAL && entry.pane.pane_id === "wQ:p2",
    );
    expect(porter).toBeDefined();
    const unconfirmed = pending("wQ:p2", "wK:pBM", true);
    // The bridge's selection is still Zephyr (the pane the tap replaced): Porter stays.
    expect(tap(world, porter!, unconfirmed).paneId).toBe("wQ:p2");
    // Another client then picks a third pane: that newer pick releases the held tap.
    const moved = { ...world, localSelected: "wQ:p9" };
    expect(pendingSelectionHolds(unconfirmed, "wQ:p9")).toBe(false);
    expect(tap(moved, porter!, undefined).paneId).toBe("wQ:p9");
  });
});

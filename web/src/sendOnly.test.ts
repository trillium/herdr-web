import { afterEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "./types";
import {
  focusedPaneFromSnapshot,
  focusedSendRequest,
  focusedSendSizeNotice,
  isSendOnlyPath,
  openSnapshotEvents,
  postFocusedSend,
  readPressEnter,
  readStoredTheme,
  writePressEnter,
  type SnapshotEventSocket,
} from "./sendOnly";

function pane(overrides: Partial<Snapshot["panes"][number]> = {}): Snapshot["panes"][number] {
  return {
    pane_id: "pane-1",
    terminal_id: "term-1",
    workspace_id: "workspace-1",
    tab_id: "tab-1",
    focused: false,
    cwd: "/tmp/repo",
    agent_status: "idle",
    revision: 1,
    ...overrides,
  };
}

function snapshot(panes: Snapshot["panes"]): Snapshot {
  return {
    workspaces: [
      {
        workspace_id: "workspace-1",
        number: 1,
        label: "scratch",
        focused: true,
        pane_count: panes.length,
        tab_count: 1,
        active_tab_id: "tab-1",
        agent_status: "idle",
      },
    ],
    tabs: [
      {
        tab_id: "tab-1",
        workspace_id: "workspace-1",
        number: 1,
        label: "notes",
        focused: true,
        pane_count: panes.length,
        agent_status: "idle",
      },
    ],
    panes,
    layouts: [],
  };
}

describe("send-only path", () => {
  it("matches /send with or without a trailing slash", () => {
    expect(isSendOnlyPath("/send")).toBe(true);
    expect(isSendOnlyPath("/send/")).toBe(true);
    expect(isSendOnlyPath("/")).toBe(false);
    expect(isSendOnlyPath("/send/extra")).toBe(false);
  });
});

describe("focused pane", () => {
  it("reads the single focused pane", () => {
    const view = focusedPaneFromSnapshot(
      snapshot([
        pane(),
        pane({
          pane_id: "pane-2",
          focused: true,
          agent: "claude",
          display_agent: "Claude",
          cwd: "/tmp/scratch",
          foreground_cwd: "/tmp/scratch/web",
        }),
      ]),
    );

    expect(view).toEqual({
      paneId: "pane-2",
      workspaceId: "workspace-1",
      workspaceLabel: "scratch",
      tabId: "tab-1",
      tabLabel: "notes",
      agent: "Claude",
      cwd: "/tmp/scratch/web",
    });
  });

  it("returns null when no pane or more than one pane is focused", () => {
    expect(focusedPaneFromSnapshot(snapshot([pane()]))).toBeNull();
    expect(
      focusedPaneFromSnapshot(snapshot([pane({ focused: true }), pane({ pane_id: "pane-2", focused: true })])),
    ).toBeNull();
  });

  it("labels a pane with no agent as a shell", () => {
    expect(focusedPaneFromSnapshot(snapshot([pane({ focused: true })]))?.agent).toBe("shell");
  });
});

describe("focused send request", () => {
  it("sends text and Enter through pane.send_input", () => {
    expect(focusedSendRequest("pane-2", "echo ok", true)).toEqual({
      method: "pane.send_input",
      params: { pane_id: "pane-2", text: "echo ok", keys: ["Enter"] },
    });
  });

  it("sends raw text through pane.send_text when Enter is off", () => {
    expect(focusedSendRequest("pane-2", "echo ok", false)).toEqual({
      method: "pane.send_text",
      params: { pane_id: "pane-2", text: "echo ok" },
    });
  });

  it("splits an enormous send into ordered requests with Enter only on the last", async () => {
    const text = "line 日本語 🚀\n".repeat(1_000_000);
    const bodies: { method: string; params: { text: string; keys?: string[] } }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)));
      return new Response("{}", { status: 200 });
    });

    await postFocusedSend((path) => path, "pane-2", text, true);

    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies.slice(0, -1).every((body) => body.method === "pane.send_text")).toBe(true);
    expect(bodies.at(-1)?.method).toBe("pane.send_input");
    expect(bodies.at(-1)?.params.keys).toEqual(["Enter"]);
    expect(bodies.map((body) => body.params.text).join("") === text).toBe(true);
  });

  it("names how many pieces were already delivered when a later piece fails", async () => {
    const text = "x".repeat(700_000);
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      return calls === 1
        ? new Response("{}", { status: 200 })
        : new Response(JSON.stringify({ error: "boom" }), { status: 502 });
    });
    await expect(postFocusedSend((path) => path, "pane-2", text, true)).rejects.toThrow(
      /boom \(1 of 3 pieces were already delivered\)/,
    );
  });

  it("posts the command to /api/command and surfaces bridge errors", async () => {
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "send target is not the focused pane" }), { status: 400 }),
    );

    await expect(postFocusedSend((path) => path, "pane-2", "echo ok", true)).rejects.toThrow(
      "send target is not the focused pane",
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/command",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          method: "pane.send_input",
          params: { pane_id: "pane-2", text: "echo ok", keys: ["Enter"] },
        }),
      }),
    );
  });
});

describe("send-only preferences", () => {
  it("presses Enter by default and stores the off switch", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };

    expect(readPressEnter(storage)).toBe(true);
    writePressEnter(false, storage);
    expect(readPressEnter(storage)).toBe(false);
  });

  it("reads the stored theme and falls back to dark", () => {
    expect(readStoredTheme({ getItem: () => null })).toBe("dark");
    expect(
      readStoredTheme({
        getItem: () => JSON.stringify({ theme: "light" }),
      }),
    ).toBe("light");
    expect(readStoredTheme({ getItem: () => "{" })).toBe("dark");
  });
});

describe("snapshot events", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listens on the events socket and reconnects without opening a terminal", () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<() => void> = [];
    const onEvent = vi.fn();
    const connection = openSnapshotEvents(
      "ws://bridge.test/ws/events",
      onEvent,
      (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      (_delay, retry) => {
        timers.push(retry);
        return timers.length;
      },
    );

    expect(sockets.map((socket) => socket.url)).toEqual(["ws://bridge.test/ws/events"]);
    expect(sockets[0].url).not.toContain("/ws/terminal");
    sockets[0].emit("message");
    expect(onEvent).toHaveBeenCalledOnce();
    sockets[0].emit("close");
    expect(sockets).toHaveLength(1);
    timers[0]();
    expect(sockets).toHaveLength(2);
    expect(sockets[1].url).toBe("ws://bridge.test/ws/events");
    connection.close();
    expect(sockets[1].closed).toBe(true);
  });
});

describe("focusedSendSizeNotice", () => {
  it("is silent for ordinary text", () => {
    expect(focusedSendSizeNotice("echo ok")).toEqual({ blocked: false, message: null });
    expect(focusedSendSizeNotice("日本語".repeat(5000))).toEqual({ blocked: false, message: null });
    // Multi-byte text is measured in bytes, not characters.
    expect(focusedSendSizeNotice("日本語".repeat(10000)).message).toMatch(/88 KB/);
  });

  it("explains that a large send is split but still sent whole", () => {
    const notice = focusedSendSizeNotice("x".repeat(200 * 1024));
    expect(notice.blocked).toBe(false);
    expect(notice.message).toMatch(/200 KB.*several pieces, in order/);
  });

  it("never blocks a send by size", () => {
    const notice = focusedSendSizeNotice("x".repeat(20 * 1024 * 1024));
    expect(notice.blocked).toBe(false);
    expect(notice.message).toMatch(/several pieces, in order/);
  });
});

class FakeSocket implements SnapshotEventSocket {
  closed = false;
  private listeners = new Map<string, Array<() => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: "message" | "open" | "close", listener: () => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: "message" | "open" | "close") {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  close() {
    this.closed = true;
  }
}

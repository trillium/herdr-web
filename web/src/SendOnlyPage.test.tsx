/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendOnlyPage } from "./SendOnlyPage";
import type { Snapshot } from "./types";

const roots: Root[] = [];

class FakeSocket {
  static instances: FakeSocket[] = [];
  url: string;
  private listeners = new Map<string, Array<() => void>>();

  constructor(url: string) {
    this.url = url;
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  close() {}
}

function focusedSnapshot(paneId = "pane-9"): Snapshot {
  return {
    workspaces: [
      {
        workspace_id: "workspace-1",
        number: 1,
        label: "scratch",
        focused: true,
        pane_count: 1,
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
        label: "shell",
        focused: true,
        pane_count: 1,
        agent_status: "idle",
      },
    ],
    panes: [
      {
        pane_id: paneId,
        terminal_id: "term-1",
        workspace_id: "workspace-1",
        tab_id: "tab-1",
        focused: true,
        cwd: "/tmp/scratch",
        agent: "shell",
        agent_status: "idle",
        revision: 1,
      },
    ],
    layouts: [],
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  window.localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPage() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<SendOnlyPage />);
  });
  return container;
}

function submitButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector("button[type='submit']");
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error("missing send button");
  }
  return button;
}

function setText(container: HTMLElement, value: string) {
  const field = container.querySelector("textarea");
  if (!(field instanceof HTMLTextAreaElement)) {
    throw new Error("missing text box");
  }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SendOnlyPage", () => {
  it("shows the focused pane and does not open a terminal socket", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(focusedSnapshot()), { status: 200 }),
    );

    const container = await renderPage();

    expect(container.textContent).toContain("scratch");
    expect(container.textContent).toContain("shell");
    expect(container.textContent).toContain("pane-9");
    expect(container.textContent).toContain("/tmp/scratch");
    expect(FakeSocket.instances.map((socket) => socket.url).join(" ")).toContain("/ws/events");
    expect(FakeSocket.instances.map((socket) => socket.url).join(" ")).not.toContain("/ws/terminal");
    expect(submitButton(container).disabled).toBe(true);
  });

  it("disables Send when no pane is focused", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ...focusedSnapshot(), panes: [] }), { status: 200 }),
    );

    const container = await renderPage();

    expect(container.textContent).toContain("No pane is focused.");
    expect(submitButton(container).disabled).toBe(true);
  });

  it("sends the text with Enter by default and clears the box", async () => {
    const fetchImpl = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/snapshot")) {
        return new Response(JSON.stringify(focusedSnapshot()), { status: 200 });
      }
      return new Response(JSON.stringify({ type: "ok" }), { status: 200 });
    });

    const container = await renderPage();
    await act(async () => {
      setText(container, "echo herdr-web-send-only");
    });
    const button = submitButton(container);
    expect(button.disabled).toBe(false);

    await act(async () => {
      button.click();
    });

    const commandCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/api/command"));
    expect(commandCall?.[1]?.body).toBe(
      JSON.stringify({
        method: "pane.send_input",
        params: { pane_id: "pane-9", text: "echo herdr-web-send-only", keys: ["Enter"] },
      }),
    );
    expect(container.querySelector("textarea")?.value).toBe("");
    expect(container.textContent).toContain("Sent");
  });

  it("marks the target when the focused pane changes", async () => {
    let snapshot = focusedSnapshot("pane-9");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify(snapshot), { status: 200 });
    });

    const container = await renderPage();
    expect(container.textContent).not.toContain("Focused pane changed");

    snapshot = focusedSnapshot("pane-10");
    await act(async () => {
      FakeSocket.instances[0]?.emit("message");
    });

    expect(container.textContent).toContain("pane-10");
    expect(container.textContent).toContain("Focused pane changed");
  });
});

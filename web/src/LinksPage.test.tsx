/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinksPage } from "./LinksPage";
import type { LinkEntry } from "./links";

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

function entry(overrides: Partial<LinkEntry>): LinkEntry {
  return {
    id: "l1",
    kind: "link",
    title: "Review the PR",
    url: "https://github.com/trillium/herdr-web/pull/1",
    source: "agent-x",
    pane_id: "wY5:p11",
    created_at: String(Date.now()),
    updated_at: String(Date.now()),
    count: 1,
    ...overrides,
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
    root.render(<LinksPage />);
  });
  return container;
}

function mockEntries(entries: LinkEntry[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input).startsWith("/api/links/")) {
      return new Response(JSON.stringify(entries[0]), { status: 200 });
    }
    return new Response(JSON.stringify({ entries }), { status: 200 });
  });
}

describe("LinksPage", () => {
  it("lists a link as a safe new-tab anchor with its provenance", async () => {
    mockEntries([entry({})]);

    const container = await renderPage();

    const anchor = container.querySelector("a.links-item-title");
    expect(anchor?.getAttribute("href")).toBe("https://github.com/trillium/herdr-web/pull/1");
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.textContent).toContain("github.com");
    expect(container.textContent).toContain("agent-x");
    expect(container.textContent).toContain("pane wY5:p11");
    expect(container.textContent).toContain("1 new");
    expect(document.title).toBe("(1) Links · herdr-web");
  });

  it("never renders a non-http url as an anchor", async () => {
    mockEntries([entry({ url: "javascript:alert(1)", title: "evil" })]);

    const container = await renderPage();

    expect(container.querySelector("a.links-item-title")).toBeNull();
    expect(container.querySelector("a[href^='javascript']")).toBeNull();
    expect(container.textContent).toContain("evil");
  });

  it("renders a note body without a link", async () => {
    mockEntries([entry({ kind: "note", url: undefined, title: "Heads up", body: "line1\nline2" })]);

    const container = await renderPage();

    expect(container.querySelector("a.links-item-title")).toBeNull();
    expect(container.querySelector(".links-item-body")?.textContent).toBe("line1\nline2");
  });

  it("shows the empty state with the CLI hint", async () => {
    mockEntries([]);

    const container = await renderPage();

    expect(container.textContent).toContain("Nothing here yet");
    expect(container.textContent).toContain("herdr-web-bridge link");
    expect(document.title).toBe("Links · herdr-web");
  });

  it("marks a link opened when it is clicked", async () => {
    const fetchImpl = mockEntries([entry({})]);
    const container = await renderPage();
    const anchor = container.querySelector("a.links-item-title") as HTMLAnchorElement;
    anchor.addEventListener("click", (event) => event.preventDefault());

    await act(async () => {
      anchor.click();
    });

    const call = fetchImpl.mock.calls.find(([url]) => String(url) === "/api/links/l1/open");
    expect(call?.[1]?.method).toBe("POST");
  });

  it("dismisses an entry through the bridge", async () => {
    const fetchImpl = mockEntries([entry({})]);
    const container = await renderPage();
    const dismiss = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Dismiss",
    );

    await act(async () => {
      dismiss?.click();
    });

    expect(fetchImpl.mock.calls.some(([url]) => String(url) === "/api/links/l1/dismiss")).toBe(
      true,
    );
  });

  it("refetches on a ui event and never opens a terminal socket", async () => {
    const fetchImpl = mockEntries([entry({})]);
    await renderPage();
    const before = fetchImpl.mock.calls.length;

    await act(async () => {
      FakeSocket.instances[0]?.emit("message");
    });

    expect(fetchImpl.mock.calls.length).toBeGreaterThan(before);
    const urls = FakeSocket.instances.map((socket) => socket.url).join(" ");
    expect(urls).toContain("/ws/ui-events");
    expect(urls).not.toContain("/ws/terminal");
  });

  it("reports an unreachable bridge", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    const container = await renderPage();

    expect(container.textContent).toContain("Bridge unavailable. network down");
  });
});

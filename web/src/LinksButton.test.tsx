/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinksButton } from "./LinksButton";
import { linksButtonLabel } from "./links";

const roots: Root[] = [];

function mount(entries: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ entries }), { status: 200 })),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  return { host, root };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("LinksButton", () => {
  it("links to /links and shows only unopened, undismissed entries", async () => {
    const { host, root } = mount([
      { id: "a", kind: "link", title: "A", created_at: "1", updated_at: "1", count: 1 },
      { id: "b", kind: "link", title: "B", created_at: "1", updated_at: "1", count: 1 },
      { id: "c", kind: "link", title: "C", created_at: "1", updated_at: "1", count: 1, opened_at: "2" },
    ]);
    await act(async () => root.render(<LinksButton />));
    const anchor = host.querySelector("a")!;
    expect(anchor.getAttribute("href")).toBe("/links");
    expect(host.querySelector("[data-testid=links-open-count]")?.textContent).toBe("2");
    expect(anchor.getAttribute("aria-label")).toBe("Open links (2 new)");
  });

  it("hides the count when nothing is unread", async () => {
    const { host, root } = mount([]);
    await act(async () => root.render(<LinksButton />));
    expect(host.querySelector("[data-testid=links-open-count]")).toBeNull();
    expect(host.querySelector("a")!.getAttribute("aria-label")).toBe(linksButtonLabel(0));
  });
});

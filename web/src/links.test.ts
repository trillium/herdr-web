import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countNewEntries,
  fetchLinks,
  isLinksPath,
  linkHost,
  postLinkAction,
  relativeTime,
  safeHttpUrl,
  type LinkEntry,
} from "./links";

function entry(overrides: Partial<LinkEntry> = {}): LinkEntry {
  return {
    id: "l1",
    kind: "link",
    title: "t",
    url: "https://example.com/a",
    created_at: "1000",
    updated_at: "1000",
    count: 1,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isLinksPath", () => {
  it("matches /links with or without a trailing slash only", () => {
    expect(isLinksPath("/links")).toBe(true);
    expect(isLinksPath("/links/")).toBe(true);
    expect(isLinksPath("/")).toBe(false);
    expect(isLinksPath("/links/extra")).toBe(false);
    expect(isLinksPath("/send")).toBe(false);
  });
});

describe("safeHttpUrl", () => {
  it("accepts http and https only", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHttpUrl("http://100.1.2.3:8787/")).toBe("http://100.1.2.3:8787/");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,hi")).toBeNull();
    expect(safeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });

  it("extracts a host and returns empty for unsafe urls", () => {
    expect(linkHost("https://example.com:8443/x")).toBe("example.com:8443");
    expect(linkHost("javascript:alert(1)")).toBe("");
  });
});

describe("relativeTime", () => {
  const now = 10_000_000_000;
  it("buckets by minute, hour and day", () => {
    expect(relativeTime(String(now - 5_000), now)).toBe("just now");
    expect(relativeTime(String(now - 5 * 60_000), now)).toBe("5m ago");
    expect(relativeTime(String(now - 3 * 3_600_000), now)).toBe("3h ago");
    expect(relativeTime(String(now - 2 * 86_400_000), now)).toBe("2d ago");
  });

  it("is empty for unparseable input", () => {
    expect(relativeTime("abc", now)).toBe("");
    expect(relativeTime("0", now)).toBe("");
  });
});

describe("countNewEntries", () => {
  it("counts entries neither opened nor dismissed", () => {
    expect(
      countNewEntries([
        entry({ id: "a" }),
        entry({ id: "b", opened_at: "2000" }),
        entry({ id: "c", dismissed_at: "2000" }),
      ]),
    ).toBe(1);
  });
});

describe("bridge calls", () => {
  it("asks for dismissed entries only when requested", async () => {
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify({ entries: [entry()] }), { status: 200 }),
      );

    expect(await fetchLinks(false)).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe("/api/links");
    await fetchLinks(true);
    expect(String(fetchImpl.mock.calls[1][0])).toBe("/api/links?include_dismissed=true");
  });

  it("surfaces the bridge error message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "link not found: l9" }), { status: 404 }),
    );
    await expect(postLinkAction("l9", "dismiss")).rejects.toThrow("link not found: l9");
  });

  it("posts the action to the entry path", async () => {
    const fetchImpl = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(entry()), { status: 200 }));
    await postLinkAction("l1", "open");
    expect(String(fetchImpl.mock.calls[0][0])).toBe("/api/links/l1/open");
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("POST");
  });
});

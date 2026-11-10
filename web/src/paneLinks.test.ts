import { describe, expect, it, vi } from "vitest";
import {
  ingestPaneLinks,
  logicalLines,
  PANE_LINKS_SOURCE,
  PaneLinkDeduper,
  urlsInRows,
} from "./paneLinks";
import type { PaneLinkRow } from "./paneLinks";

const row = (text: string, continuation = false): PaneLinkRow => ({ text, continuation });

describe("logicalLines", () => {
  // ghostty-web 0.4.0 polarity: isWrapped === true marks a row that continues the previous one.
  it("joins continuation rows and keeps unwrapped rows separate", () => {
    expect(
      logicalLines([row("see https://example.com/a/very/"), row("long/path", true), row("next")]),
    ).toEqual(["see https://example.com/a/very/long/path", "next"]);
  });

  it("never joins a row that is not flagged as a continuation", () => {
    expect(logicalLines([row("https://example.com/full"), row("width-row")])).toEqual([
      "https://example.com/full",
      "width-row",
    ]);
  });

  it("treats a leading continuation as its own line", () => {
    expect(logicalLines([row("tail", true)])).toEqual(["tail"]);
  });
});

describe("urlsInRows", () => {
  it("finds a URL wrapped across rows", () => {
    expect(
      urlsInRows([row("open https://example.com/a/very/lo"), row("ng/path?q=1 now", true)]),
    ).toEqual(["https://example.com/a/very/long/path?q=1"]);
  });

  it("trims trailing punctuation and balances closers", () => {
    expect(
      urlsInRows([
        row("(see https://example.com/x), and https://example.com/y."),
        row("wiki https://en.wikipedia.org/wiki/Foo_(bar)"),
      ]),
    ).toEqual([
      "https://example.com/x",
      "https://example.com/y",
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("de-duplicates and keeps first-seen order", () => {
    expect(
      urlsInRows([row("https://b.example/1 https://a.example/2"), row("https://b.example/1")]),
    ).toEqual(["https://b.example/1", "https://a.example/2"]);
  });

  it("ignores non-http schemes", () => {
    expect(
      urlsInRows([row("javascript:alert(1) file:///etc/passwd ftp://example.com/x")]),
    ).toEqual([]);
  });

  it("drops absurdly long URLs and caps how many a scan returns", () => {
    expect(urlsInRows([row(`https://example.com/${"a".repeat(3000)}`)])).toEqual([]);
    const many = Array.from({ length: 150 }, (_, index) => row(`https://example.com/${index}`));
    expect(urlsInRows(many)).toHaveLength(100);
  });
});

describe("PaneLinkDeduper", () => {
  it("returns only unsent URLs and can forget failed ones", () => {
    const deduper = new PaneLinkDeduper();
    expect(deduper.fresh(["https://a.example", "https://b.example"])).toHaveLength(2);
    deduper.markSent(["https://a.example", "https://b.example"]);
    expect(deduper.fresh(["https://a.example", "https://c.example"])).toEqual([
      "https://c.example",
    ]);
    deduper.forget(["https://a.example"]);
    expect(deduper.fresh(["https://a.example"])).toEqual(["https://a.example"]);
  });
});

describe("ingestPaneLinks", () => {
  const httpUrl = (path: string) => path;

  it("posts the URLs tagged with the terminal source and pane", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(ingestPaneLinks(httpUrl, "w1:p2", ["https://example.com"])).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/links/ingest");
    expect(JSON.parse(String(init.body))).toEqual({
      links: [{ url: "https://example.com", source: PANE_LINKS_SOURCE, pane_id: "w1:p2" }],
    });
    vi.unstubAllGlobals();
  });

  it("reports an unsupported bridge as false and other failures as errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(ingestPaneLinks(httpUrl, "p", ["https://example.com"])).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 500 })));
    await expect(ingestPaneLinks(httpUrl, "p", ["https://example.com"])).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

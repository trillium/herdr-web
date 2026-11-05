/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import TerminalViewersCard, {
  VIEWERS_AUTO_COLLAPSE_MS,
  terminalViewersDetail,
  terminalViewersLabel,
} from "./TerminalViewersCard";
import type { TerminalConnection } from "./connectionManager";

const roots: Root[] = [];

function connection(clientId: string, nickname: string): TerminalConnection {
  return { client_id: clientId, nickname, priority: 5, connected_at: 0 };
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function render(connections: TerminalConnection[]) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(connections), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <TerminalViewersCard terminalId="term-1" httpUrl={(path) => `http://bridge${path}`} />,
    );
  });
  return container;
}

describe("terminalViewersLabel", () => {
  it("pluralises the viewer count", () => {
    expect(terminalViewersLabel(1)).toBe("1 device viewing");
    expect(terminalViewersLabel(2)).toBe("2 devices viewing");
    expect(terminalViewersLabel(5)).toBe("5 devices viewing");
  });
});

describe("terminalViewersDetail", () => {
  it("lists every nickname when the list is short", () => {
    expect(
      terminalViewersDetail([connection("a", "mac-desktop"), connection("b", "iphone-mobile")]),
    ).toBe("mac-desktop, iphone-mobile");
  });

  it("truncates a long list so it stays on one line", () => {
    expect(
      terminalViewersDetail([
        connection("a", "one"),
        connection("b", "two"),
        connection("c", "three"),
        connection("d", "four"),
        connection("e", "five"),
      ]),
    ).toBe("one, two, three +2 more");
  });

  it("is empty when no nickname is known", () => {
    expect(terminalViewersDetail([])).toBe("");
  });
});

describe("TerminalViewersCard", () => {
  it("renders nothing for a single viewer", async () => {
    const container = await render([connection("a", "mac-desktop")]);
    expect(container.textContent).toBe("");
  });

  it("reports the count and the device names when several clients view", async () => {
    const container = await render([
      connection("a", "mac-desktop"),
      connection("b", "iphone-mobile"),
    ]);
    expect(container.textContent).toContain("2 devices viewing");
    expect(container.textContent).toContain("mac-desktop, iphone-mobile");
  });

  it("does not present the extra viewers as a conflict or offer a takeover", async () => {
    // The bridge broadcasts output to every attached client, so this view must
    // never imply that one of them is locked out.
    const container = await render([
      connection("a", "mac-desktop"),
      connection("b", "iphone-mobile"),
    ]);
    expect(container.textContent).not.toMatch(/conflict|priority|active/i);
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("kicks a device from the expanded list, optionally resetting its saved panes", async () => {
    const container = await render([
      connection("a", "mac-desktop"),
      connection("b", "iphone-mobile"),
    ]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".terminal-viewers-toggle")!.click();
    });
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "ok", kicked: true })));
    const resetButtons = [...container.querySelectorAll("button")].filter(
      (button) => button.textContent === "Kick + reset",
    );
    await act(async () => {
      resetButtons[1].click();
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("http://bridge/api/terminal-connections/kick");
    expect(JSON.parse(String(init?.body))).toEqual({ client_id: "b", clear_state: true });
    expect(container.textContent).not.toContain("iphone-mobile");
  });
});

describe("TerminalViewersCard on a phone", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width: 820px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the pill, then shrinks to a corner chip, and the chip reopens it", async () => {
    const container = await render([
      connection("a", "mac-desktop"),
      connection("b", "iphone-mobile"),
    ]);
    expect(container.textContent).toContain("2 devices viewing");
    expect(container.querySelector(".terminal-viewers-chip")).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(VIEWERS_AUTO_COLLAPSE_MS + 50);
    });
    expect(container.textContent).not.toContain("devices viewing");
    const chip = container.querySelector<HTMLButtonElement>(".terminal-viewers-chip");
    expect(chip?.textContent).toBe("2");
    expect(chip?.getAttribute("aria-label")).toContain("2 devices viewing");

    await act(async () => {
      chip!.click();
    });
    expect(container.textContent).toContain("2 devices viewing");
  });

  it("stays up while the device list is being managed", async () => {
    const container = await render([
      connection("a", "mac-desktop"),
      connection("b", "iphone-mobile"),
    ]);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(".terminal-viewers-toggle")!.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(VIEWERS_AUTO_COLLAPSE_MS * 3);
    });
    expect(container.querySelector(".terminal-viewers-list")).not.toBeNull();
    expect(container.querySelector(".terminal-viewers-chip")).toBeNull();
  });
});

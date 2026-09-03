import { describe, expect, it, vi } from "vitest";
import {
  fetchBridgeBuildInfo,
  formatBridgeBuildInfo,
  formatWebBuildStamp,
  parseBridgeBuildInfo,
  WEB_BUILD_STAMP,
} from "./buildStamp";

const VALID = {
  bridge_version: "0.1.0",
  git_sha: "66c5eb6d",
  build_time: "2026-09-03T08:20:55Z",
  protocol_version: 20,
};

describe("parseBridgeBuildInfo", () => {
  it("accepts a complete payload", () => {
    expect(parseBridgeBuildInfo(VALID)).toEqual(VALID);
  });

  it("rejects payloads missing or mistyping any field", () => {
    expect(parseBridgeBuildInfo(null)).toBeNull();
    expect(parseBridgeBuildInfo("0.1.0")).toBeNull();
    expect(parseBridgeBuildInfo({ ...VALID, git_sha: undefined })).toBeNull();
    expect(parseBridgeBuildInfo({ ...VALID, protocol_version: "20" })).toBeNull();
  });
});

describe("formatting", () => {
  it("renders the bridge stamp as one readable line", () => {
    expect(formatBridgeBuildInfo(VALID)).toBe(
      "v0.1.0 · 66c5eb6d · 2026-09-03T08:20:55Z · protocol 20",
    );
  });

  it("renders the web stamp as sha and build time", () => {
    expect(formatWebBuildStamp({ sha: "abc1234", time: "2026-09-03T08:20:55Z" })).toBe(
      "abc1234 · 2026-09-03T08:20:55Z",
    );
  });

  it("always has a non-empty web build stamp baked in", () => {
    expect(WEB_BUILD_STAMP.sha.trim()).not.toBe("");
    expect(WEB_BUILD_STAMP.time.trim()).not.toBe("");
  });
});

describe("fetchBridgeBuildInfo", () => {
  it("returns the parsed stamp on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => VALID,
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(fetchBridgeBuildInfo()).resolves.toEqual(VALID);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/version");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns null when the bridge rejects or is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    try {
      await expect(fetchBridgeBuildInfo()).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    try {
      await expect(fetchBridgeBuildInfo()).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

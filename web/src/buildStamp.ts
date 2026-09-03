import { fetchWithTimeout } from "./fetchWithTimeout";

/** Shape of `GET /api/version` on the bridge (see bridge/src/web_bridge.rs `BuildInfo`). */
export type BridgeBuildInfo = {
  bridge_version: string;
  git_sha: string;
  build_time: string;
  protocol_version: number;
};

/**
 * Build stamp of THIS web bundle, injected by `define` in vite.config.ts. The web app and the
 * bridge are deployed independently (`web/dist` is rsynced separately from the binary), so a
 * phone needs both stamps to answer "did my redeploy land?".
 */
export const WEB_BUILD_STAMP: { sha: string; time: string } = {
  sha: typeof __WEB_BUILD_SHA__ === "string" ? __WEB_BUILD_SHA__ : "unknown",
  time: typeof __WEB_BUILD_TIME__ === "string" ? __WEB_BUILD_TIME__ : "unknown",
};

export function parseBridgeBuildInfo(value: unknown): BridgeBuildInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const bridgeVersion = record.bridge_version;
  const gitSha = record.git_sha;
  const buildTime = record.build_time;
  const protocolVersion = record.protocol_version;
  if (
    typeof bridgeVersion !== "string" ||
    typeof gitSha !== "string" ||
    typeof buildTime !== "string" ||
    typeof protocolVersion !== "number"
  ) {
    return null;
  }
  return {
    bridge_version: bridgeVersion,
    git_sha: gitSha,
    build_time: buildTime,
    protocol_version: protocolVersion,
  };
}

/** One line a phone can read or screenshot: `v0.1.0 · 66c5eb6d · 2026-09-03T08:20:55Z · protocol 20`. */
export function formatBridgeBuildInfo(info: BridgeBuildInfo): string {
  return [
    `v${info.bridge_version}`,
    info.git_sha,
    info.build_time,
    `protocol ${info.protocol_version}`,
  ].join(" · ");
}

export function formatWebBuildStamp(
  stamp: { sha: string; time: string } = WEB_BUILD_STAMP,
): string {
  return `${stamp.sha} · ${stamp.time}`;
}

/** Fetches the same-origin bridge build stamp. Returns null on any failure; this is diagnostics. */
export async function fetchBridgeBuildInfo(
  url = "/api/version",
  init?: RequestInit,
): Promise<BridgeBuildInfo | null> {
  try {
    const response = await fetchWithTimeout(url, init);
    if (!response.ok) {
      return null;
    }
    return parseBridgeBuildInfo(await response.json());
  } catch {
    return null;
  }
}

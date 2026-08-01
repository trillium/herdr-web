import type { BridgeCapabilities } from "./bridge";
import type { BridgeHttpUrl } from "./bridgeApi";
import { fetchWithTimeout } from "./fetchWithTimeout";

export type LauncherPresetOption = {
  id: string;
  label: string;
  agent_hint: string | null;
  built_in: boolean;
};

export type LauncherPresetsResponse = {
  version: 1;
  presets: LauncherPresetOption[];
  warnings: string[];
};

export type LegacyLaunchKind = "shell" | "codex" | "claude" | "pi" | "grok" | "opencode";

export const FALLBACK_LAUNCHER_PRESETS: LauncherPresetOption[] = [
  {
    id: "builtin:shell",
    label: "Shell",
    agent_hint: null,
    built_in: true,
  },
  {
    id: "builtin:codex",
    label: "Codex",
    agent_hint: "codex",
    built_in: true,
  },
  {
    id: "builtin:claude",
    label: "Claude",
    agent_hint: "claude",
    built_in: true,
  },
  {
    id: "builtin:pi",
    label: "pi",
    agent_hint: "pi",
    built_in: true,
  },
  {
    id: "builtin:grok",
    label: "Grok",
    agent_hint: "grok",
    built_in: true,
  },
  {
    id: "builtin:opencode",
    label: "OpenCode",
    agent_hint: "opencode",
    built_in: true,
  },
];

export function supportsLauncherPresets(capabilities: BridgeCapabilities | null | undefined) {
  return capabilities?.launcher_presets?.version === 1;
}

export async function fetchLauncherPresets(
  httpUrl: BridgeHttpUrl,
): Promise<LauncherPresetsResponse> {
  const response = await fetchWithTimeout(httpUrl("/api/launcher-presets"));
  if (!response.ok) {
    throw new Error(`launcher presets failed: ${response.status}`);
  }
  return parseLauncherPresetsResponse(await response.json());
}

export function parseLauncherPresetsResponse(value: unknown): LauncherPresetsResponse {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.presets)) {
    return { version: 1, presets: FALLBACK_LAUNCHER_PRESETS, warnings: [] };
  }
  // Preserve an intentionally empty list (e.g. builtins: [] with no customs).
  // Only fall back when the response shape itself is unusable.
  const presets = value.presets
    .map(parseLauncherPreset)
    .filter((preset): preset is LauncherPresetOption => Boolean(preset));
  return {
    version: 1,
    presets,
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

export function legacyKindForPresetId(id: string): LegacyLaunchKind | null {
  if (id === "builtin:shell") return "shell";
  if (id === "builtin:codex") return "codex";
  if (id === "builtin:claude") return "claude";
  if (id === "builtin:pi") return "pi";
  if (id === "builtin:grok") return "grok";
  if (id === "builtin:opencode") return "opencode";
  return null;
}

function parseLauncherPreset(value: unknown): LauncherPresetOption | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") {
    return null;
  }
  return {
    id: value.id,
    label: value.label,
    agent_hint: typeof value.agent_hint === "string" ? value.agent_hint : null,
    built_in: value.built_in === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

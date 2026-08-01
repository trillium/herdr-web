// Agents report their own account usage via the existing pane.report_metadata
// state_labels bag (see PaneReportMetadataParams in vendor/herdr-compat), setting
// usage_hourly_pct / usage_weekly_pct to a "0".."100" string. There is no bridge or
// protocol support specific to usage — this just knows which two keys to read.
const HOURLY_KEY = "usage_hourly_pct";
const WEEKLY_KEY = "usage_weekly_pct";

export type TerminalUsageLevel = "normal" | "warn" | "critical";

export type TerminalUsage = {
  hourlyPct?: number;
  weeklyPct?: number;
};

function parseUsagePercent(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(100, Math.max(0, value));
}

export function readTerminalUsage(stateLabels: Record<string, string> | undefined): TerminalUsage {
  return {
    hourlyPct: parseUsagePercent(stateLabels?.[HOURLY_KEY]),
    weeklyPct: parseUsagePercent(stateLabels?.[WEEKLY_KEY]),
  };
}

export function terminalUsageLevel(pct: number): TerminalUsageLevel {
  if (pct >= 90) {
    return "critical";
  }
  if (pct >= 70) {
    return "warn";
  }
  return "normal";
}

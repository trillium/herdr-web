import { useEffect, useState } from "react";
import {
  fetchBridgeBuildInfo,
  formatBridgeBuildInfo,
  formatWebBuildStamp,
} from "./buildStamp";
import type { BridgeBuildInfo } from "./buildStamp";

/**
 * Build stamp panel in the settings dialog's Bridge tab (the tab settings opens on), so a phone
 * can report which web bundle and which bridge build it is running after a redeploy. Plain text
 * inside the dialog — no hover affordance and no keyboard shortcut, so it is reachable by touch.
 */
export function BuildStampSection() {
  const [bridgeBuild, setBridgeBuild] = useState<BridgeBuildInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetchBridgeBuildInfo("/api/version", { signal: controller.signal }).then((info) => {
      if (!active) {
        return;
      }
      setBridgeBuild(info);
      setLoaded(true);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return (
    <div className="settings-section settings-section-flat">
      <div className="settings-label">Build</div>
      <div className="settings-row">
        <span>Web app</span>
        <span className="settings-build-value">{formatWebBuildStamp()}</span>
      </div>
      <div className="settings-row">
        <span>Bridge</span>
        <span className="settings-build-value">
          {bridgeBuild
            ? formatBridgeBuildInfo(bridgeBuild)
            : loaded
              ? "unavailable"
              : "checking…"}
        </span>
      </div>
    </div>
  );
}

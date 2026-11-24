/**
 * What `GET`/`POST /api/mobile-mode` says about the "hide the Claude Code statusline" flag.
 *
 * The flag lives on the host running a herdr-web bridge. A herdr saved machine (`--remote-machine`)
 * has no bridge of its own, so the hub answers `supported: false` for it and the toggle is hidden
 * rather than left as a button that does nothing.
 */
export interface MobileModeStatus {
  /** `null` when the response did not say (older bridge, error body). */
  active: boolean | null;
  supported: boolean;
}

/** Reads a mobile-mode response body. Anything that does not say otherwise counts as supported. */
export function parseMobileModeStatus(payload: unknown): MobileModeStatus {
  if (typeof payload !== "object" || payload === null) {
    return { active: null, supported: true };
  }
  const { active, supported } = payload as { active?: unknown; supported?: unknown };
  return {
    active: typeof active === "boolean" ? active : null,
    supported: supported !== false,
  };
}

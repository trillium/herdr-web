// Per-machine favicon tint, chosen from the first label of the page hostname so
// several herdr-web tabs (one per machine) are distinguishable. Unlisted hosts
// (e.g. the macbook) keep the standard icon.
const HOST_TINTS: Record<string, string> = {
  mini0: "#7bd88f",
  mini1: "#7fb2ff",
};

const STANDARD_FILL = 'fill="#d9dad8"';

export function resolveFaviconTint(hostname: string, search: string): string | null {
  const override = new URLSearchParams(search).get("tint")?.replace(/["<>]/g, "").trim();
  if (override) {
    return override;
  }
  const label = hostname.split(".")[0]?.toLowerCase() ?? "";
  return Object.hasOwn(HOST_TINTS, label) ? HOST_TINTS[label] : null;
}

export function tintLogoSvg(svg: string, tint: string): string {
  return svg.replace(STANDARD_FILL, `fill="${tint}"`);
}

/** Best-effort: any failure leaves the standard icon in place. */
export async function applyFaviconTint(): Promise<void> {
  try {
    const tint = resolveFaviconTint(window.location.hostname, window.location.search);
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!tint || !link) {
      return;
    }
    const response = await fetch(link.getAttribute("href") ?? "/herdr-logo.svg");
    if (!response.ok) {
      return;
    }
    const svg = tintLogoSvg(await response.text(), tint);
    link.href = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  } catch {
    // keep the standard icon
  }
}

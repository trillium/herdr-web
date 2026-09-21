// Post-build guard: fail loudly if the parlay-input voice line-ender did not
// make it into the production bundle. Without the wrapper, ParlayInput.tsx
// silently degrades to a plain input and no ender phrase can ever match —
// that silent fallback must never ship to prod again.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "..", "dist", "assets");
const MARKER = "api/chat/events";

let entries;
try {
  entries = readdirSync(distDir);
} catch (error) {
  console.error(
    `[check-parlay-bundle] FAIL: could not read ${distDir}: ${(error instanceof Error ? error.message : error)}`,
  );
  process.exit(1);
}

const jsFiles = entries.filter((name) => name.endsWith(".js"));
const hit = jsFiles.find((name) =>
  readFileSync(join(distDir, name), "utf8").includes(MARKER),
);

if (!hit) {
  console.error(
    `[check-parlay-bundle] FAIL: marker "${MARKER}" not found in any of ${jsFiles.length} dist asset(s). ` +
      "parlay-input is missing from the production bundle — voice line-ender would be dead. " +
      "Check that web/vendor/parlay-input is present and web/package.json still depends on it.",
  );
  process.exit(1);
}

console.log(`[check-parlay-bundle] OK: marker "${MARKER}" found in ${hit}.`);

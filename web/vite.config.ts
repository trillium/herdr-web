import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const bridgeTarget = process.env.HERDR_WEB_BRIDGE ?? "http://127.0.0.1:8787";

export function parseAllowedHosts(value: string | undefined): string[] | true | undefined {
  if (!value || value.trim() === "") return undefined;
  if (value.trim() === "*") return true;
  const hosts = value.split(",").map((h) => h.trim()).filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

const allowedHosts = parseAllowedHosts(process.env.HERDR_WEB_ALLOWED_HOSTS);

// `@parlay/client` is an intentionally OPTIONAL, LOCAL-ONLY, NEVER-PUBLISHED
// dependency. It resolves only when its gitignored symlink
// (`web/local-deps/parlay-client`) is present, and is deliberately absent from
// package.json/package-lock.json so `npm ci` never fetches it from a registry.
//
// `parlay-input` is NOT optional: it is a real `file:./vendor/parlay-input`
// dependency (vendored prebuilt copy, see web/vendor/parlay-input/VENDOR.md),
// so it resolves through node_modules on every checkout and is always bundled
// into production. Externalizing it (unconditionally, or conditionally on a
// symlink) was the bug behind voice-submit never firing in production: the
// build emitted a 0-byte `__vite-browser-external` stub for the specifier
// with nothing serving it at runtime (the bridge serves a static dir, no
// module server), so the runtime import always failed and every deployed
// build silently shipped the plain input. Do not externalize `parlay-input`.
// The post-build `scripts/check-parlay-bundle.mjs` guard fails the build if
// its marker ever goes missing from the bundle again.

// Resolve to the package's built entry, not the bare directory. Vite's dev/build resolver would
// infer the entry from package.json, but Vitest's module runner does not resolve a directory id,
// so returning the directory left `@parlay/client` unresolvable under test — ParlayInput then
// silently took its plain-input fallback and the parlay voice-submit path went untested.
// Pointing at the entry file fixes dev, test, and (when bundled) production alike.
//
// The entry is derived from the symlinked package's own `exports`/`module`/`main` rather than a
// hardcoded path, so a parlay-client release that moves or renames its build output (e.g.
// `dist/index.mjs`) does not silently drop us back to the plain input. `dist/index.js` stays as
// the last-resort candidate for a package.json that declares no usable entry.
const PARLAY_FALLBACK_ENTRY = "dist/index.js";
const PARLAY_EXPORT_CONDITIONS = ["browser", "import", "module", "default", "require"];

function collectExportTargets(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    if (node.startsWith("./")) out.push(node.slice(2));
    return;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const record = node as Record<string, unknown>;
  for (const condition of PARLAY_EXPORT_CONDITIONS) {
    if (condition in record) collectExportTargets(record[condition], out);
  }
}

// `main`/`module` are ordinary package-relative paths, not `exports` targets: the `./` prefix that
// `exports` requires is optional here, and `"main": "dist/index.mjs"` is the common form. Only
// absolute paths and parent-directory escapes are rejected.
function collectLegacyEntry(value: unknown, out: string[]): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(trimmed)) return;
  const normalized = trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
  if (normalized === "" || normalized.startsWith("../")) return;
  out.push(normalized);
}

/**
 * Ordered list of entry subpaths to try for a local `@parlay/client` checkout, most specific
 * first, always ending in the legacy `dist/index.js` fallback. Pure so it can be unit tested.
 */
export function parlayEntryCandidates(pkg: unknown): string[] {
  const candidates: string[] = [];
  if (pkg && typeof pkg === "object" && !Array.isArray(pkg)) {
    const record = pkg as Record<string, unknown>;
    const exportsField = record.exports;
    if (typeof exportsField === "string") {
      collectExportTargets(exportsField, candidates);
    } else if (exportsField && typeof exportsField === "object" && !Array.isArray(exportsField)) {
      const rootExport = (exportsField as Record<string, unknown>)["."];
      collectExportTargets(rootExport === undefined ? exportsField : rootExport, candidates);
    }
    collectLegacyEntry(record.module, candidates);
    collectLegacyEntry(record.main, candidates);
  }
  candidates.push(PARLAY_FALLBACK_ENTRY);
  return candidates.filter((entry, index) => entry.length > 0 && candidates.indexOf(entry) === index);
}

function readPackageJson(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function resolveParlayEntry(): string | undefined {
  return resolveLocalEntry("local-deps/parlay-client", "@parlay/client");
}

function resolveLocalEntry(dirName: string, specifier: string): string | undefined {
  const packageDir = resolve(__dirname, dirName);
  if (!existsSync(packageDir)) return undefined;
  const candidates = parlayEntryCandidates(readPackageJson(packageDir));
  for (const candidate of candidates) {
    const entry = resolve(packageDir, candidate);
    if (existsSync(entry)) return entry;
  }
  console.warn(
    `[parlay-client-resolver] ${packageDir} exists but no built entry was found ` +
      `(tried: ${candidates.join(", ")}). Build the parlay checkout behind ${specifier}, or parlay ` +
      `voice-submit will fall back to a plain input.`,
  );
  return undefined;
}

// Build stamp baked into the bundle so a phone can report which web build it is running
// (the bridge reports its own stamp at /api/version; the two are deployed independently).
// Neither value may fail the build: a source tarball has no `.git` and CI images may lack git.
function gitStdout(args: string[]): string | undefined {
  try {
    const value = execFileSync("git", ["-C", __dirname, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

const webBuildSha = (() => {
  const sha = gitStdout(["rev-parse", "--short", "HEAD"]);
  if (!sha) return "unknown";
  return gitStdout(["status", "--porcelain"]) ? `${sha}-dirty` : sha;
})();
const webBuildTime = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const parlayEntry = resolveParlayEntry();
const hasLocalParlay = parlayEntry !== undefined;
// Externalize the optional dep only when its symlink is absent: with the
// symlink present the resolver above points the specifier at its built entry
// and rolldown bundles it. Without it, externalize so the build still
// succeeds. (`parlay-input` is never externalized — it is a vendored
// dependency and always bundles.)
const optionalExternals = hasLocalParlay ? [] : ["@parlay/client"];

// Under Vitest there is no equivalent of `build.rolldownOptions.external`, so with a
// symlink absent every module that even mentions the specifier failed to TRANSFORM
// ("Failed to resolve import"), taking unrelated test files down with it. That is a
// resolution error at build time, which the guarded `try { await import(...) }` in
// ParlayInput.tsx cannot catch -- the tests were already written to tolerate a missing
// package, they just never got the chance.
//
// Resolving to a virtual module whose evaluation throws restores the intended shape:
// the specifier resolves, so transform succeeds, and the dynamic import then REJECTS
// exactly as an externalized specifier does in a production build. This is deliberately
// scoped to Vitest so `vite build` keeps using `external` and the built output is
// byte-for-byte unchanged.
const PARLAY_MISSING_ID = "\0parlay-client-missing";
const stubParlayForVitest = !hasLocalParlay && Boolean(process.env.VITEST);

function parlayClientResolver(): Plugin {
  return {
    name: "parlay-client-resolver",
    resolveId(id) {
      if (id !== "@parlay/client") return;
      if (parlayEntry) return parlayEntry;
      if (stubParlayForVitest) return PARLAY_MISSING_ID;
    },
    load(id) {
      if (id !== PARLAY_MISSING_ID) return;
      return `throw new Error("@parlay/client is not installed (optional local-only dependency)");`;
    },
  };
}

export default defineConfig({
  plugins: [react(), parlayClientResolver()],
  define: {
    __WEB_BUILD_SHA__: JSON.stringify(webBuildSha),
    __WEB_BUILD_TIME__: JSON.stringify(webBuildTime),
  },
  test: {
    exclude: [...configDefaults.exclude, "local-deps/**", "tests/**"],
    setupFiles: ["./src/testSetup.ts"],
  },
  server: {
    port: 5173,
    ...(allowedHosts !== undefined ? { allowedHosts } : {}),
    proxy: {
      "/api": bridgeTarget,
      "/ws": {
        target: bridgeTarget,
        ws: true,
      },
    },
  },
  build: {
    rolldownOptions: {
      // Only externalize `@parlay/client` when its local symlink is absent.
      // `parlay-input` is a vendored dependency and must always bundle — never
      // externalize it (see header comment).
      external: optionalExternals,
      onwarn(warning: { message?: string }) {
        // Suppress warnings for the unresolved optional parlay dep — it's optional.
        if (warning.message?.includes("@parlay/client")) {
          return;
        }
      },
    },
  },
});

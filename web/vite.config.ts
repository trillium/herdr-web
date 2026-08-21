import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";
import type { Plugin } from "vite";
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

// `@parlay/client` is an intentionally OPTIONAL, LOCAL-ONLY, NEVER-PUBLISHED dependency.
// It resolves only when the gitignored symlink `web/local-deps/parlay-client` is present,
// which enables the parlay voice-submit path in `vite dev`/tests. It is deliberately absent
// from package.json/package-lock.json so `npm ci` never fetches it from a registry.
//
// In production (`vite build`) the specifier is externalized (see build.rolldownOptions.external
// below), so parlay is never bundled; ParlayInput's guarded `try { await import(...) }`
// then falls back to a plain input when the module cannot be resolved at runtime. This resolver
// only serves the symlink-present dev/test path — do not add a registry version.
function parlayClientResolver(): Plugin {
  const parlayDir = resolve(process.cwd(), "local-deps/parlay-client");
  let parlayEntry: string | null = null;
  if (existsSync(parlayDir)) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(parlayDir, "package.json"), "utf-8")) as {
        main?: string;
      };
      const main = pkg.main ?? "index.js";
      const entry = resolve(parlayDir, main);
      if (existsSync(entry)) {
        parlayEntry = entry;
      }
    } catch {
      // parlay-client package.json unreadable; leave parlayEntry null
    }
  }

  return {
    name: "parlay-client-resolver",
    resolveId(id) {
      if (id === "@parlay/client" && parlayEntry) {
        return parlayEntry;
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), parlayClientResolver()],
  test: {
    exclude: [...configDefaults.exclude, "local-deps/**"],
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
      external: ["@parlay/client"],
      onwarn(warning: { message?: string }) {
        // Suppress warning for unresolved @parlay/client — it's optional.
        if (warning.message?.includes("@parlay/client")) {
          return;
        }
      },
    },
  },
});

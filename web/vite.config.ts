import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const bridgeTarget = process.env.HERDR_WEB_BRIDGE ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": bridgeTarget,
      "/ws": {
        target: bridgeTarget,
        ws: true,
      },
    },
  },
  test: {
    setupFiles: ["./src/testSetup.ts"],
  },
});

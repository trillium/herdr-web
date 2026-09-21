import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "*.tsbuildinfo",
      "tests/**",
      "playwright.config.ts",
      // Vendored prebuilt third-party bundle — lint the source upstream, not the copy.
      "vendor/**",
    ],
  },
  js.configs.recommended,
  // Node runtime script (post-build bundle guard), not browser code.
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
    },
  },
];

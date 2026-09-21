# Vendored `parlay-input`

Prebuilt copy of the `parlay-input` voice line-ender wrapper from the
[parlay repo](https://github.com/trillium/parlay.git) (`packages/input`),
version **0.2.0**.

## Why vendored

`parlay-input` is required in the production bundle: without it
`ParlayInput.tsx` silently degrades to a plain input and no voice ender phrase
can ever match. The npm `parlay-input@0.1.0` is only an alias stub for the
unpublished `@parlay/input`, so it cannot be installed from a registry, and the
old gitignored-symlink route (`web/local-deps/parlay-input`) is absent in clean
checkouts — which is how the wrapper went missing from prod builds. Vendoring
the prebuilt output makes `web/package.json`'s
`"parlay-input": "file:./vendor/parlay-input"` resolve on every checkout and
in CI; if this directory is missing, `npm ci` fails loudly instead of shipping
a voiceless bundle.

The wrapper is zero-dependency, so only `dist/` + `LICENSE` are vendored (no
`node_modules`, no build step).

## Refreshing

From a parlay checkout, rebuild and re-copy:

```bash
cd /path/to/parlay/packages/input && bun install && bun run build
cp dist/index.js dist/index.d.ts <this-repo>/web/vendor/parlay-input/dist/
cp LICENSE <this-repo>/web/vendor/parlay-input/
```

Then bump `version` in `package.json` above to the upstream version,
reinstall (`npm install --prefix web`), and rebuild to confirm the bundle
marker check (`npm run build:web`) still passes.

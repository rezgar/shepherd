# Vendored from askdiff (personal fork)

Source: https://github.com/rezgar/askdiff, branch `live-working-tree-refresh`, commit `d8267babdee89d55412c35e36abd0535f478b144`.

Not the public `askdiff` npm package — this fork adds live auto-refresh for
working-tree diffs (a chokidar-based watcher that recomputes and re-pushes
the diff on every filesystem change), which is the entire reason this is
embedded here instead of just shelling out to `npx askdiff`.

## What's here

- `protocol/` — `@askdiff/protocol` source verbatim (message schemas/types).
- `server/` — `@askdiff/server` source (`startServer`, the `claude --resume`
  Q&A bridge, diff parsing/staleness/working-tree-capture/watch utilities).
  Relative imports rewritten from the `@askdiff/protocol` package specifier
  to plain relative paths, and given `.js` extensions to match this repo's
  own import convention. One further deliberate change: `util/working-tree-diff.ts`'s
  untracked-file diffing fanned every untracked file out via a single
  unbounded `Promise.all`, spawning one `git` subprocess per file
  simultaneously with no cap. Fine for a one-shot CLI diff, but this runs on
  every filesystem-event refresh of a live (`volatile`) working-tree
  session — confirmed live to run Shepherd's daemon to 1M+ handles and
  10+ GB RSS within seconds, once a project had any real number of
  untracked files plus ambient file churn. Capped to a small (8) worker
  pool instead of the unbounded fan-out.
- `ui-dist/` — the **pre-built** static UI bundle (`pnpm run build` output
  from the fork's `packages/ui-browser`), not source. Rebuilding it here
  would mean pulling React 19/Vite/Tailwind v4/react-diff-view/etc. into
  this repo's toolchain just to serve static files; vendoring the built
  output avoids that entirely.
- `static-server.ts` (in `server/vendor/askdiff/`, alongside this file) —
  adapted from the fork's `packages/cli/src/server-bundle.ts`, with two
  deliberate changes:
  1. The original sets `X-Frame-Options: DENY` and a `connect-src`-only CSP,
     both written for standalone browser-tab use. Shepherd embeds this UI in
     an `<iframe>` from its own origin (a different port on the same host),
     so this version drops `X-Frame-Options` and adds
     `frame-ancestors http://localhost:5173 file:` to the CSP instead —
     scoped to Shepherd's two actual parent origins (the Vite dev server's
     fixed port, and the packaged app's `file://` load via `win.loadFile`),
     not a `localhost:*` wildcard, which would let any localhost-bound page
     or process iframe a live diff server.
  2. The original's `const __dirname = dirname(fileURLToPath(import.meta.url))`
     crashes at require-time in the packaged desktop app: esbuild strips
     `import.meta` to `{}` when bundling this to CJS
     (`desktop/scripts/bundle-daemon.mjs`), so `import.meta.url` is
     `undefined`. Replaced with `resolveHere()`, which prefers the CJS
     `__dirname` global esbuild shims in and only falls back to
     `fileURLToPath(import.meta.url)` under a real ESM run (`tsx` dev) —
     same fix as `server/src/rawParsePool.ts`'s `resolveHere()`.

## Re-syncing after fork changes

There's no automated sync. To pull in a later fork commit: diff this
directory against the fork's `packages/protocol/src`, `packages/server/src`,
and a fresh `packages/cli/dist/ui` build, re-apply the import-path and
security-header adjustments above, and update the commit SHA in this file.

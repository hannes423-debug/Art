# Contributing to Art

Thanks for helping! Art aims to stay **small, fast, free and focused** on
raster and sprite work. Before adding something big, please open an issue to
discuss it.

## Ground rules

- **No ads, tracking, analytics, accounts, paywalls or cloud requirements.**
  Contributions that add any of these will not be accepted.
- **No dead UI.** If a button is shown, it must work.
- **Don't break the core workflow:** new image → draw → erase → layers → colors
  → undo/redo → save → export transparent PNG, on desktop *and* mobile.
- **Keep it dependency-free at runtime.** Dev tooling is fine; runtime
  libraries need a strong reason.
- **Pixels are sacred.** Never round-trip pixel data through a canvas
  (premultiplied alpha changes semi-transparent colors). Use the RGBA buffers
  in `Surface` and the codecs in `src/io/png.ts`.

## Setup

```sh
npm install
npm run dev          # http://localhost:5173
```

Requires Node.js 20 or newer.

## Checks

```sh
npm run typecheck    # TypeScript (app + tests)
npm test             # unit tests (Vitest, Node)
npm run test:e2e     # browser tests (Playwright, builds the app first)
npm run build        # production build in dist/
```

For end-to-end tests, install a browser once with
`npx playwright install chromium` (or point `PW_CHROMIUM` at an existing
Chromium binary). Please run all checks before opening a pull request, and add
tests for new behavior — unit tests for core logic, Playwright tests for
anything users interact with (including touch where relevant).

## Code style

- TypeScript, strict mode, no `any` in app code.
- Plain DOM for UI (see `src/ui/dom.ts`); components subscribe to editor and
  document events and update only what changed.
- Keep inner pixel loops simple and allocation-free.
- Prefer clear names and short doc comments explaining *why*.

## Where things live

See the *Architecture* section of the [README](README.md). The project file
format is specified in [docs/file-format.md](docs/file-format.md); any change
to it must update that document (and bump the version for incompatible changes).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).

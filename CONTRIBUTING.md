# Contributing to PrintPilot

Thanks for helping people with dead printer panels. This doc covers dev
setup, tests, the house rules, and how to add a printer adapter.

## Dev setup

Requires Node.js 22+ and npm.

```sh
npm install
npm run dev          # launch the app in dev mode (Electron + HMR)
npm run typecheck    # strict TypeScript, must stay clean
npm test             # unit tests (Vitest)
npm run test:e2e     # Playwright Electron tests (builds first)
npm run package      # electron-builder --dir smoke build
```

Reproducible Linux build via Docker:

```sh
docker build -t printpilot-build .
docker run --rm -v "$PWD":/app -w /app printpilot-build
```

## House rules (from AGENTS.md)

- **Automated tests travel with every feature.** No manual testing as a
  verification strategy.
- **No physical printer in tests, ever.** Unit and e2e tests run against
  recorded HTML fixtures served by a local fixture server
  (`tests/fixtures/server.ts`). Record new fixtures from a real device with
  the fixture recorder (below).
- Minimal diffs; match surrounding conventions; no speculative abstractions.
- `PROGRESS.md` tracks the roadmap — read it first, work top to bottom.

## Testing layout

- `tests/*.test.ts` — Vitest unit tests, node environment. Pure logic lives
  in injectable modules (stores, nav layer, logger, security policy) so tests
  never touch Electron, sockets, or the filesystem outside temp dirs.
- `e2e/*.spec.ts` — Playwright drives the real built app. Determinism hooks:
  `PRINTPILOT_FAKE_DISCOVERY=1` (no-network discovery stub),
  `PRINTPILOT_FAKE_PRINTER_HOST/PORT` (point the control view at the fixture
  server), `PRINTPILOT_CONFIG_DIR` / `PRINTPILOT_LOG_DIR` (throwaway state),
  `PRINTPILOT_SIMULATE_CRASH=1` (crash-recovery notice).

## Recording fixtures from a real printer

```sh
node scripts/record-fixtures.mjs 192.168.1.50        # your printer's IP
```

The recorder fetches the Remote UI top page, the login page, and every
same-host page linked from the top page (depth-1, same-host only), saves them
under `tests/fixtures/canon/` with an `index.json`, and prints a checklist —
follow it: **no credentials, PINs, or session cookies may end up in a
fixture**, and anonymize serial numbers before committing.

## Adding a printer adapter

Per-model support is data, not code: add `adapters/<vendor>-<model>.json`.

Fields (see `adapters/canon-mf750.json`):

- `id` — unique adapter id.
- `vendor`, `models` — matched (case-insensitive) against discovery results
  to pick the adapter.
- `remoteUiMarkers` — substrings identifying this vendor's web UI on the
  root page; discovery uses them to classify unknown hosts.
- `login.urlPatterns`, `login.formSelector`, `login.passwordSelector` — how
  the nav layer recognizes the login page and watches the PIN form.
- `knownPages` — named pages with URL patterns (top, status, menu…).
- `focusSkip` — CSS selectors the focus ring must skip on this firmware.

Resolution falls back to a built-in **generic** adapter when nothing matches:
a plain focus ring over all interactive elements. An unknown printer stays
usable — the app shows an "unknown layout" notice instead of failing.

Add unit tests against recorded fixtures for anything the adapter assumes
(login selectors, page structure).

## Code style notes

- Strict TypeScript everywhere; `npm run typecheck` must pass.
- Node/Electron APIs stay in `src/main/`; anything the renderer or guest
  bundles must be free of node builtins (see the `settings.ts` /
  `settings-schema.ts` split for the pattern).
- Secrets never cross process boundaries in plaintext and never reach the
  log — the logger redacts, but don't log secrets in the first place.
- No new runtime dependencies without a discussion; node stdlib first.

## PR expectations

- Tests for every behavior change; `npm test`, `npm run test:e2e`, and
  `npm run typecheck` all green.
- Small, reviewable diffs — no drive-by refactors.
- Docs updated when behavior changes (README, this file, `docs/`).
- Security-sensitive changes (IPC surface, webview policy, credentials) call
  out the threat-model impact in the PR description; see
  `docs/security-audit-2026-08-17.md` for the current baseline.

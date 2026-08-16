# PrintPilot

![CI](https://github.com/printpilot/printpilot/actions/workflows/ci.yml/badge.svg)

PrintPilot is an open source desktop app (Windows + Linux) for operating a
network printer's menu when its control panel is unusable — born from a Canon
imageCLASS MF750 with a dead touchscreen. It wraps the printer's built-in web
"Remote UI" and adds full keyboard and gamepad navigation, so every panel
task stays reachable without touching the panel.

LAN-only. No accounts, no sync, no telemetry.

## Status

Early scaffold (Phase 1). The app shell, config layer, and input abstraction
exist; discovery and the control view land in Phase 2. Not usable yet.

## Quick start

Requires Node.js 22+ and npm.

```sh
npm install
npm run dev        # launch the app in dev mode
npm test           # unit tests (Vitest)
npm run test:e2e   # Playwright Electron smoke test (builds first)
npm run typecheck
```

Reproducible Linux build via Docker:

```sh
docker build -t printpilot-build .
docker run --rm -v "$PWD":/app -w /app printpilot-build
```

## Supported printers

| Vendor | Series | Status |
| ------ | ------ | ------ |
| Canon  | imageCLASS MF750 | Planned (dev device) |

Per-model support ships as data (adapter manifests), so contributors can add
models without touching core code.

## Contributing

See `AGENTS.md` for the house rules: automated tests travel with every
feature, no physical printer required for tests (recorded fixtures), minimal
diffs. Roadmap and current progress live in `PROGRESS.md`; the validated
design is in `docs/plans/2026-08-16-printpilot-design.md`.

## License

[GPLv3](LICENSE).

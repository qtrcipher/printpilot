# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-17

First public release — born from a Canon imageCLASS MF750 with a dead
touchscreen. Functional against mock Canon fixtures; real-device fixture
recordings are the next milestone.

### Added

- **Discovery** — finds printers on the LAN via mDNS + SNMP probes; manual
  add-by-IP with a reachability pre-check when discovery finds nothing.
- **Control view** — embeds the printer's Remote UI with a status strip,
  error recovery (never a raw error page), and an open-in-browser fallback.
- **Navigation layer** — full keyboard control (arrows/Tab, Enter, Esc,
  `Ctrl+``) and gamepad control (D-pad/stick, A/B) with press-to-assign
  remapping in Settings.
- **Profiles** — multiple printers saved locally; Remote UI PINs stored in
  the OS keychain (Electron `safeStorage`), never in plain files.
- **Adapters** — per-model support as data (`adapters/canon-mf750.json`
  first), with a generic fallback adapter so unknown printers stay usable.
- **Onboarding** — connect-first-printer flow; accessibility pass (screen-
  reader labels, aria-live announcements, reduced motion).
- **Logging** — structured local logs with secret redaction; local crash
  capture. No remote reporting (see `docs/decisions/no-telemetry.md`).
- **Fixture recorder** (`scripts/record-fixtures.mjs`) — records Remote UI
  pages from a real device so tests never need a physical printer.
- CI matrix (Windows + Linux) packaging NSIS + portable and AppImage + deb;
  reproducible Linux build via Docker.

### Security

- Hardened by default: the embedded page can only navigate within the
  printer, all Chromium permissions are denied, crash capture and logs stay
  on the device. Audit: `docs/security-audit-2026-08-17.md` (13 fixed,
  4 accepted).

[Unreleased]: https://github.com/qtrcipher/printpilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qtrcipher/printpilot/releases/tag/v0.1.0

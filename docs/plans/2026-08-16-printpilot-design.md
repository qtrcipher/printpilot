# PrintPilot — Design (Phase 0 output)

Date: 2026-08-16 · Status: validated with user (sections 1–4 approved)

## 1. Product brief

**PrintPilot** (working name) is an open source Windows/Linux desktop app for
operating a network printer when its control panel is unusable (origin case:
Canon MF750 with a dead touchscreen). v1 targets Canon imageCLASS.

Core loop: discover printers on the LAN (mDNS + manual IP) → connect, which
opens the printer's Remote UI inside the app → navigate it with mouse, full
keyboard control, or a USB/Bluetooth gamepad. Multiple printer profiles saved
locally; credentials in the OS keychain.

Success metric: a user with a dead touchscreen can perform the top 5 panel
tasks (check status/toner, change network settings, run cleaning, copy/scan
settings, firmware info) without touching the panel.

Non-goals for v1: printing/scanning drivers, non-Canon vendors, USB-attached
printers (no menu-control channel exists over USB).

## 2. Existing solutions (market check, 2026-08-16)

- Canon Remote UI (built-in web UI on imageCLASS) already exposes the full
  menu in a browser — the tool wraps and extends it rather than replacing it.
- Canon "Remote Operation" (VNC, port 5900) confirmed on newer models
  (LBP1871); **MF750 support unverified** — candidate for a later adapter,
  needs on-device verification.
- No open source tool exists for office-printer panel recovery. Remote-screen
  tooling exists only in the 3D-printer world (Klipper/Mainsail/Fluidd,
  Snapmaker, helixscreen) — different protocol stack, not reusable.
- Conclusion: niche is real and empty. Recovery-console scope (not universal
  controller) validated.

## 3. Architecture — Approach A (chosen)

Embedded Remote UI + injected navigation layer. Alternatives considered:
VNC panel mirroring (B — later adapter if MF750 supports Remote Operation),
scrape-and-re-render (C — rejected, brittle against firmware updates).

Electron (user-chosen) on Windows + Linux. Three layers:

- **Main process** — windows, discovery (mDNS `_ipp._tcp`/`_http._tcp`/
  `_pdl-datastream._tcp` + SNMP sysDescr probes, manual IP always available),
  profile store, keychain via `safeStorage`.
- **Renderer (shell UI)** — printer list/onboarding, profile manager,
  settings, control view hosting the webview. TypeScript.
- **Webview + preload (control core)** — `WebContentsView` loads
  `http://<printer-ip>/`; preload injects the navigation layer: roving-focus
  ring, arrow/tab movement, Enter = click, Esc = back, gamepad loop
  (Chromium Gamepad API) D-pad/stick → focus, A → activate, B → back,
  visible focus outline + on-screen hint bar.
- **Adapter manifests** — per-model JSON (Canon MF750 first): login
  selectors, known page URLs, focus-order skips. Data, not code, so
  contributors add models without touching core.

Data flow: `discovery (main) → renderer picks printer → webview loads
Remote UI → preload injects nav layer → keyboard/gamepad events drive
focus/clicks in-page`. All printer traffic stays on the LAN.

## 4. Local data model

- `profiles.json` (config dir): versioned; printers[] = { id, nickname,
  host, vendor, model, adapter, credentialId, lastConnected }. No secrets —
  `credentialId` references an OS keychain entry (`safeStorage` fallback).
- `settings.json`: gamepad mappings (remappable), keyboard scheme, window
  state, discovery prefs. Versioned + tiny migration runner on startup.
- Adapter manifests shipped read-only in the bundle; user adapters override
  from config dir. No database, no sync, no telemetry.

## 5. Error handling

- Discovery finds nothing → guided manual-IP flow with reachability pre-check.
- Printer unreachable → profile marked offline + retry.
- Remote UI login fails → inline re-prompt, never a raw webview error page.
- Adapter mismatch (unknown firmware layout) → degrade to generic focus ring
  over all interactive elements; app stays usable.
- Rotating local log + "copy diagnostics" button.

## 6. Testing (house rule: no physical printer in CI)

- Recorded fixtures: HTML snapshots of real MF750 Remote UI pages served by
  a local fixture server.
- Unit tests (Vitest) for nav layer and adapters against fixtures.
- E2E (Playwright) for the Electron shell against the same fixtures.
- Gamepad behind an `InputSource` interface; tests inject synthetic events.
- CI matrix: Windows + Linux. Docker for reproducible local builds.

## 7. UX flows (ux-design-patterns, four-state rule)

Screens: **Home/discovery**, **manual add**, **control view**, **settings**
(+ one skippable first-run welcome: what the app does + "LAN-only, no
telemetry" note).

- **Connect flow:** pick printer → connecting splash → Remote UI loads (its
  own login page if a PIN is set; app offers keychain save after a successful
  login) → control view.
- **Home states:** loading = scan-in-progress skeleton; empty = no printers →
  guided "Add by IP" with reachability pre-check (no route / not a printer /
  Remote UI disabled — each with a specific fix hint) + rescan; error =
  network down; success = printer list (saved profiles pinned, live status
  dot).
- **Control view states:** loading = splash with printer name; success =
  webview + persistent context-sensitive input-hint bar (key caps, or gamepad
  glyphs when a pad is active) + status strip (name, IP, live connection
  dot); error = offline banner with "Retry" and "open in browser" fallback,
  webview never shows a raw error page. Gamepad disconnect = non-blocking
  notice.
- **Settings:** gamepad remap via press-to-assign, keyboard scheme display,
  theme (dark default / light), discovery prefs, "copy diagnostics" button;
  debug menu in dev builds only.
- **Accessibility rules (hard requirements):** visible focus ring on every
  interactive element; tab order = visual order; audited focus boundary
  between shell and embedded webview (no keyboard traps); every error has a
  recovery action; buttons disable during async commands (gamepad repeat
  safe).

## 8. Design direction (ui-ux-pro-max)

- **Style:** dark-mode-first utility (OLED-friendly), light theme secondary.
- **Palette (dark):** bg `#0F172A`, surface `#1B2336`, muted `#272F42`,
  border `#475569`, text `#F8FAFC`, muted text `#94A3B8`, primary `#1E293B`,
  success `#22C55E`, error `#EF4444`, warning `#F59E0B`, focus ring `#60A5FA`.
- **Palette (light):** bg `#F8FAFC`, surface `#FFFFFF`, muted `#E8ECF1`,
  border `#E2E8F0`, text `#020617`, muted text `#64748B`, primary `#0F172A`,
  accent `#0369A1`, success `#16A34A`, error `#DC2626`, warning `#B45309`,
  focus ring `#0369A1`.
- **Typography:** Inter (bundled, OFL) — 700 headings / 400 body 16px /
  500 uppercase +1.2 tracking for hint-bar chips. Stack: `"Inter", system-ui,
  "Segoe UI", Roboto, "Noto Sans", "Ubuntu", sans-serif`. Mono for IPs/serials:
  `"JetBrains Mono", ui-monospace, "Cascadia Mono", monospace`.
- **Icons:** Phosphor, regular/outline weight, 20px, single library.

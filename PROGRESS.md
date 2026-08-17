# Desktop App Roadmap — PrintPilot (working name)

> THE todo list. Paste into any session (or keep as the app's `PROGRESS.md`).
> Checkboxes = where I am. Tag convention: bare `` `name` `` = skill; `` `name` `` agent = subagent;
> a tag on a phase HEADER applies to every item in that phase.
> House rules (session start/end routine, no manual testing) load from AGENTS.md —
> deliberately not duplicated here. Work top to bottom; phases are in order.
> AI: read this first — if a task is checked, confirm before redoing it;
> update this file and commit at session end.
>
> Origin: scaffolded from the `ios-ship-gate` template (references/progress-template.md),
> adapted from iOS to a Windows/Linux open source desktop tool. iOS-only items
> (Xcode, ASC, StoreKit, Firebase) were replaced with desktop equivalents.

## Phase 0 — Plan (GATE: no implementation code until every item below is checked)
- [x] Problem, users, MVP scope, success metrics — `product-frameworks` · `brainstorming` → design doc §1
- [x] Existing-solutions check: Canon Remote UI, vendor tools, OSS competitors, demand — `app-market-research` (adapted: web research, no App Store) → design doc §2
- [x] ~~(Optional, max ONCE) Deep research~~ — SKIPPED: single-engine research settled the direction (Remote UI wrap + nav layer)
- [x] Screens, flows, all four UI states per screen — `ux-design-patterns` → design doc §7
- [x] Design direction: style, palette, typography — `ui-ux-pro-max` · `design-tokens` → design doc §8
- [x] Architecture + module plan (discovery, protocol layer, UI, input mapping) → design doc §3 (Approach A, Electron)
- [x] Local data model: printer profiles, settings, key/joystick mappings storage → design doc §4

## Phase 1 — Foundation
- [x] Public GitHub repo (github.com/qtrcipher/printpilot); GPLv3 LICENSE; `.gitignore` covers secrets BEFORE first commit
- [x] Tech stack scaffold: Electron + TypeScript (electron-vite) + CI matrix Windows & Linux — `release-automation`
- [x] App icon + branding (printer + D-pad glyph, palette accents) — `icon-design-guide`
- [x] Docker build environment for reproducible builds (verified: clean-checkout npm ci + typecheck + 23 tests green in container)
- [x] Scaffold this file into the repo as `PROGRESS.md` — `ios-ship-gate` (template in its references/)

## Phase 2 — Features
- [x] Core features (from design doc §1/§3): LAN printer discovery (mDNS + SNMP sysDescr, manual IP fallback),
      multi-printer profiles (keychain credentials), control view (embedded Remote UI + status strip + hint bar),
      keyboard/gamepad navigation layer, per-model adapter manifests (canon-mf750 first)
- [x] Onboarding + in-app guides (connect-first-printer flow)
- [x] Accessibility (keyboard navigation, screen-reader labels, aria-live announcements, reduced-motion)
- [x] Developer debug menu — debug builds only

## Phase 3 — Hardening
- [x] Structured logging + local crash capture (remote reporting rejected — see `docs/decisions/no-telemetry.md`) — `error-monitoring`
- [x] Security audit (13 fixed, 4 accepted — `docs/security-audit-2026-08-17.md`; npm audit clean) — `security-checklist`
- [x] Docs: README features, CONTRIBUTING, `docs/protocols/canon-remote-ui.md`, fixture recorder script

## Phase 4 — Packaging & Distribution
- [x] Windows installer (nsis setup + portable; MSIX deferred — store sideloading not needed for v1) — `release-automation`
- [x] Linux packages (AppImage + .deb; Flatpak deferred — add when a Flathub maintainer story is wanted)
- [x] GitHub Releases pipeline with checksums + changelog (`release.yml`: tag `v*` → tested builds → release w/ SHA256SUMS; dry-run dispatch verified end-to-end incl. artifacts)

## Phase 5 — Testing
- [ ] Tests written WITH each feature (not after)
- [ ] Every control × every state: disabled, loading, empty, error
- [ ] Protocol layer tested against recorded fixtures (no physical printer in CI)
- [ ] Suite green on Windows + Linux (CI matrix)
- [ ] Bugs found → root-cause first — `systematic-debugging`

## Phase 6 — Release
- [ ] README with screenshots, install instructions, supported-printer matrix
- [ ] Privacy note (local-only tool; state what leaves the machine — ideally nothing)
- [ ] v1.0.0 tag AFTER release artifacts are published — tags are for releases only

## Session log
Format, newest first, one line per session: `YYYY-MM-DD — what changed — next: <task>`
- 2026-08-17 — Offline recovery guide added (Ethernet / Direct Connection / Canon USB tool) in control-error banner, empty state, and offline-profile state. 226 unit + 15 e2e — next: real MF750 fixtures, then v0.1.0
- 2026-08-17 — On-screen D-pad added (third InputSource: pointer, arrows+OK+Back, hold repeat, settings toggle); release dry-run artifacts verified by download (real nsis/portable/AppImage/deb + valid SHA256SUMS). 199 unit + 13 e2e — next: real MF750 fixtures, then v0.1.0
- 2026-08-17 — Phase 4 COMPLETE: release.yml (tag→release w/ SHA256SUMS, dry-run verified), CHANGELOG, bump-version script, RELEASE.md. 182 unit + 12 e2e — next: Phase 5 gap = real MF750 fixtures; then v0.1.0 tag (needs user go-ahead)
- 2026-08-17 — Phase 3 COMPLETE: logging+redaction, local crash capture, security audit (13 fixed), docs + fixture recorder. 172 unit + 12 e2e green; CI matrix green after fixing a real settings-close clobber bug + Windows shebang issue — next: record real MF750 fixtures (needs the printer on LAN), then Phase 4 packaging
- 2026-08-17 — Phase 2 COMPLETE: discovery (mDNS/SNMP), profiles+safeStorage, control view + nav layer (keyboard/gamepad), adapters, settings+remap, onboarding, a11y, debug menu. 137 unit + 9 e2e green — next: record real MF750 fixtures (needs the printer on LAN), then Phase 3 hardening
- 2026-08-17 — CI matrix green (win+ubuntu) after two fixes: author email for deb, `--publish never` — Phase 1 COMPLETE — next: Phase 2 core features (discovery, control view, nav layer)
- 2026-08-16 — Phase 1 nearly done: Electron+TS scaffold (23 unit + e2e green), GPLv3, public repo github.com/qtrcipher/printpilot live, icon, CI matrix — next: verify Docker build, then Phase 2 core features
- 2026-08-16 — scaffolded roadmap; Phase 0 COMPLETE (gate passed): scope=recovery console, Canon-first, Electron; design doc `docs/plans/2026-08-16-printpilot-design.md` — next: Phase 1 repo + stack scaffold
- 2026-08-16 — scaffolded this roadmap (adapted from ios-ship-gate template) — next: Phase 0 scope

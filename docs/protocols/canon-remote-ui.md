# Canon imageCLASS Remote UI — protocol notes

Status: **partially mocked** — the structure below is modeled from hand-built
fixtures (`tests/fixtures/canon/`) that imitate an MF750. Sections marked
*[awaiting recording]* are unverified against real firmware; run
`scripts/record-fixtures.mjs <printer-ip>` on a real device and update this
document (and the fixtures) with what comes back.

## What the Remote UI is

Every imageCLASS printer runs a built-in web server on port 80 (HTTP only)
known as the "Remote UI". It exposes the full device menu — status, toner
levels, network settings, maintenance jobs — as plain HTML pages. PrintPilot
embeds these pages and adds keyboard/gamepad navigation; it does not re-implement
the protocol.

## Login flow

- With no system-manager PIN set, all pages are openly reachable on the LAN.
- With a PIN set, pages redirect to a login page containing a
  `<form>` with an `input[type="password"]`. Submitting the correct PIN
  establishes a session (cookie) and redirects to the top page.
  *[awaiting recording: exact login URL, form field names, redirect target]*
- PrintPilot detects the login page via the adapter's `login.urlPatterns` +
  `passwordSelector`, captures the submitted PIN in the guest preload, and
  offers to save it to the OS keychain only after navigation away from the
  login page (i.e. a successful login).

## Page structure (as modeled by the fixtures)

- `/` — top page: device name header, nav links (Status/Cancel, Menu,
  Log Out), device status table with toner percentages.
- `/menu.html` — the device menu as a link list.
- `/login.html` — password form (fixture posts to `/login`, 302 → `/top.html`).
- Hidden/disabled controls exist on real pages and must be skipped by the
  focus ring (the fixture includes examples).

## Adapter selectors (`adapters/canon-mf750.json`)

- `remoteUiMarkers`: strings identifying a Canon Remote UI root page
  (`canon`, `remote ui`, `/rui/`) — used by discovery to classify a host.
- `login.urlPatterns` / `formSelector` / `passwordSelector`: how the guest
  recognizes and watches the login form.
- `knownPages`: named pages with URL patterns (top, status, menu) — used for
  context-sensitive hints.
- `focusSkip`: selectors the focus ring must skip (empty for MF750 so far).
- Real Canon Remote UIs serve pages under `/rui/` on many models — the
  markers and URL patterns anticipate that, but it is *[awaiting recording]*.

## Contributing recordings

If you have a physical imageCLASS: `node scripts/record-fixtures.mjs <ip>`,
follow the printed checklist (no credentials in fixtures, anonymize serials),
and reconcile any selector differences into the adapter JSON.

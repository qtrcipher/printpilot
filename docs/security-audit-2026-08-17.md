# Security audit — 2026-08-17 (Phase 3)

Scope: Electron shell, main process, preload bridges, embedded Remote UI
webview, credential storage, logging/diagnostics, dependencies.
Method: security-checklist skill adapted to Electron/desktop; iOS-, Android-,
Firebase-, payment-, and account-related items skipped as not applicable (no
accounts, no backend, no payments, no database — see "Not applicable" below).

Threat model: the embedded Remote UI is a LAN device we do not fully trust —
compromised or hostile printer firmware must not be able to open arbitrary
pages inside the app, escape to the local filesystem, or exfiltrate the admin
PIN through PrintPilot itself. The printer's admin PIN is the only secret;
it lives in the OS keychain via Electron `safeStorage`.

## Findings

| # | Item | Verdict | Notes |
|---|------|---------|-------|
| 1 | `contextIsolation: true` (shell + webview guest) | FIXED (verified + enforced) | Shell `BrowserWindow` and guest `webpreferences` both set it explicitly. |
| 2 | `nodeIntegration: false` (shell + webview guest) | FIXED (verified + enforced) | Same; guest preload runs in the isolated world. |
| 3 | `webSecurity` on | FIXED | Was default-true; now explicit on both shell and guest so it can't regress silently. |
| 4 | Guest navigation limits | FIXED | New: `will-navigate` + `setWindowOpenHandler` on webview webContents (`src/main/security.ts`). Same-host http(s) = allow; other http(s) = routed to system browser; `file:`/`data:`/`javascript:` = denied. Unit tests `tests/security.test.ts`, e2e `e2e/hardening.spec.ts`. |
| 5 | Unconditional `shell.openExternal` on guest `new-window` | FIXED | Previously the renderer opened ANY URL (any scheme) in the system browser. Renderer listener removed; main-process handler decides per policy (#4). |
| 6 | Shell `window.open` accepted any scheme | FIXED | Now http(s)-only via the same decision function; others logged + denied. |
| 7 | Permission requests | FIXED | `setPermissionRequestHandler` + `setPermissionCheckHandler` deny everything (app needs no Chromium permissions; Gamepad API is not permission-gated). e2e asserts `notifications` query = denied. |
| 8 | Shell CSP | FIXED | Existing meta CSP (`default-src 'self'`, no remote sources) tightened with `object-src 'none'; base-uri 'none'`. |
| 9 | `style-src 'unsafe-inline'` in CSP | ACCEPTED | No inline scripts allowed (`script-src` falls back to `'self'`); inline styles are low-risk and Vite's style injection relies on them. `connect-src` not tightened beyond `'self'` because dev-mode HMR needs `ws:` — production build is unaffected. |
| 10 | Credential storage | FIXED (verified) | `safeStorage` guard exists (`CredentialUnavailableError` when no OS keychain backend); profiles persist only the base64 blob; blob never crosses into the renderer (`stripCredential`). |
| 11 | Secrets in logs/diagnostics | FIXED (verified + tested) | Diagnostics replaces `credentialEnc` with a boolean (existing test). New logger redacts credential-shaped keys, URL userinfo, and serialized `credentialEnc` blobs — unit-tested with malicious inputs (`tests/logger.test.ts`). Profile IPC logging uses ids/nicknames only. |
| 12 | `log:write` IPC abuse (log flooding / injection) | FIXED | Only `warn`/`error` accepted, message capped at 500 chars, 10 writes per 10s per sender; excess dropped. |
| 13 | Dependency vulnerabilities | FIXED (clean) | `npm audit` (2026-08-17): **0 vulnerabilities**. |
| 14 | Preloads run with `sandbox: false` | ACCEPTED | Required for the ESM preload bundles electron-vite emits (noted in code). `contextIsolation` stays on and the preload surface is a narrow typed bridge; no `remote` module. |
| 15 | `<webview>` tag enabled | ACCEPTED | Core of the design (embedded Remote UI). Mitigated by #1–#7 plus a dedicated guest preload. |
| 16 | Remote UI is plain HTTP | ACCEPTED | Printer firmware serves HTTP only; traffic never leaves the LAN. TLS interception of a device self-signed cert would add complexity without real gain on the threat model. |
| 17 | Crash capture | FIXED (by design) | Local-only: rotating log + next-launch recovery notice. No remote endpoint. See `docs/decisions/no-telemetry.md`. |

## Not applicable (checklist items skipped)

- Firebase/App Check, Firestore rules, Cloud Functions — no backend exists.
- Payments/PCI — no purchases.
- iOS Keychain/ATS, Android Keystore/`android:exported`, MSIX signing —
  desktop-only project (Windows/Linux); packaging signing is a Phase 4
  release concern.
- SQL/NoSQL injection — no database; config is versioned JSON files.
- MFA/session management/account lockout — no app accounts; the printer PIN
  is authenticated by the Remote UI itself, inside the embedded page.
- GDPR/consent flows — no data collection of any kind (see no-telemetry
  decision).

## Verification

- Unit: `tests/security.test.ts` (navigation + permission policy),
  `tests/logger.test.ts` (redaction), `tests/crash.test.ts` (crash entries).
- E2e: `e2e/hardening.spec.ts` (guest cannot leave the printer host;
  permission queries denied; crash-recovery notice).
- `npm audit`: 0 vulnerabilities.

# Decision: no telemetry, no remote crash reporting

Date: 2026-08-17 · Status: accepted

## Context

Phase 3 added local crash capture (`render-process-gone`, `child-process-gone`,
`unhandledRejection`, `uncaughtException`). The obvious industry default is to
upload crash reports to a hosted service (Sentry & co.).

## Decision

All diagnostics stay on the machine. Crashes are written to the rotating local
log (`app.getPath('logs')`) and surfaced to the user on next launch via a
recovery notice; the "Copy diagnostics" button in Settings is the only way
data leaves the device, and it is user-initiated, clipboard-only.

Rationale:

- PrintPilot is an open source LAN-only tool. Its core promise — stated on the
  welcome screen — is "LAN-only, no telemetry". Silent upload would break it.
- We run no server. Shipping crash data to a third party we don't control is
  not acceptable for a tool that handles printer admin PINs on a LAN.
- Printer hostnames/IPs are local-network identifiers; even "anonymous" crash
  reports would leak network topology.

## Revisiting

Opt-in crash upload can be reconsidered if a backend we control ever exists.
Requirements before that happens: explicit per-install opt-in (off by
default), redaction parity with the local logger (no credential material, no
URL userinfo, no `credentialEnc`), and a published data-retention policy.

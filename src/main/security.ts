/**
 * Security policy for embedded content (see docs/security-audit-2026-08-17.md).
 * Pure decision functions, wired into Electron handlers in index.ts so the
 * policy is unit-testable without a running app.
 *
 * Threat model: the embedded Remote UI is a LAN device we don't fully trust
 * (compromised or hostile firmware must not be able to open arbitrary pages
 * inside the app or escape to the local file system). The webview guest may
 * only navigate within the printer's own host; everything else is denied or
 * handed to the system browser.
 */

export type NavDecision =
  | { action: 'allow' }
  | { action: 'external'; url: string }
  | { action: 'deny'; reason: string };

/**
 * Where may the webview guest navigate?
 * - http(s) on the printer's own host[:port] → allow (Remote UI pages).
 * - other http(s) URLs → deny in-app, route to the system browser.
 * - anything else (file:, data:, javascript:, …) → deny outright.
 */
export function decideNavigation(targetUrl: string, printerHost: string | null): NavDecision {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return { action: 'deny', reason: 'unparseable URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { action: 'deny', reason: `protocol ${parsed.protocol} is not allowed` };
  }
  if (printerHost && parsed.host === printerHost) return { action: 'allow' };
  return { action: 'external', url: parsed.href };
}

/**
 * Permission policy: the app needs no Chromium permissions (no camera/mic/
 * geolocation/notifications/…), so every request and check is denied.
 * The Gamepad API is not permission-gated, so control input is unaffected.
 */
export function permissionDecision(_permission: string): boolean {
  return false;
}

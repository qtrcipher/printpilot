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

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443' };

/** url.port strips the scheme's default port — put it back for comparison. */
function effectivePort(url: URL): string {
  return url.port || DEFAULT_PORTS[url.protocol] || '';
}

/**
 * printerHost is stored as "host:port" by control:connect (a bare "host"
 * matches any port on that hostname). Compare hostname + effective port so
 * a printer on the default port matches both `http://h/` and `http://h:80/`
 * — `new URL().host` drops default ports, which used to break the allowlist
 * for the most common printer config (port 80).
 */
function printerHostMatches(url: URL, printerHost: string): boolean {
  const sep = printerHost.lastIndexOf(':');
  const host = sep === -1 ? printerHost : printerHost.slice(0, sep);
  const port = sep === -1 ? '' : printerHost.slice(sep + 1);
  if (url.hostname !== host) return false;
  return port === '' || effectivePort(url) === port;
}

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
  if (printerHost && printerHostMatches(parsed, printerHost)) return { action: 'allow' };
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

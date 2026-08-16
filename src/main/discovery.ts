/**
 * LAN printer discovery (design doc §3).
 *
 * This module holds the pure, network-free core: mDNS record normalization,
 * SNMP sysDescr parsing, Canon Remote UI HTML classification, IPv4/hostname
 * validation, and the dependency-injected DiscoveryService. The real
 * mDNS/SNMP/HTTP adapters live in discovery-net.ts (Electron main only) so
 * Vitest can exercise everything here with injected fakes — no sockets.
 */

export interface DiscoveredPrinter {
  host: string; // IPv4 address (or mDNS hostname when no A record arrived)
  port: number;
  hostname?: string;
  vendor?: string;
  model?: string;
  /** Which discovery channel found it. */
  via: 'mdns' | 'snmp' | 'manual';
}

/** Raw record as reported by an mDNS browser (shape matches bonjour-service). */
export interface MdnsRecord {
  name: string;
  host?: string;
  port: number;
  addresses?: string[];
}

/** mDNS browsing, injectable so tests never open a multicast socket. */
export interface MdnsBrowser {
  start(onUp: (record: MdnsRecord) => void, onError: (err: Error) => void): void;
  stop(): void;
}

/** SNMP sysDescr probing, injectable so tests never send UDP. */
export interface SnmpProber {
  getSysDescr(host: string, timeoutMs: number): Promise<string | null>;
}

/** HTTP reachability checks, injectable so tests never open TCP. */
export interface HttpFetcher {
  getRoot(host: string, timeoutMs: number): Promise<{ reachable: boolean; body: string }>;
}

export const SNMP_TIMEOUT_MS = 1500;
export const MANUAL_CHECK_TIMEOUT_MS = 3000;

export function isValidIpv4(ip: string): boolean {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n <= 255 && String(n) === part; // rejects leading zeros ("01")
  });
}

export function isValidHostname(host: string): boolean {
  const label = /[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?/i;
  return new RegExp(`^${label.source}(\\.${label.source})*\\.?$`, 'i').test(host.trim());
}

export interface DeviceIdentity {
  vendor?: string;
  model?: string;
}

/**
 * Heuristic vendor/model extraction from an SNMP sysDescr string
 * (OID 1.3.6.1.2.1.1.1.0). Canon first — v1 targets imageCLASS.
 */
const VENDOR_RULES: ReadonlyArray<{ vendor: string; match: RegExp; model?: RegExp }> = [
  {
    vendor: 'canon',
    match: /canon/i,
    model: /\b(MF\d{2,4}[A-Za-z]{0,4}|LBP\d{2,4}[A-Za-z]{0,4}|iR[- ]?ADV[ \w-]*|iR\d{3,4}[A-Za-z]*)\b/i,
  },
  { vendor: 'hp', match: /\b(hp|hewlett[ -]packard)\b/i, model: /\b(LaserJet|OfficeJet|DeskJet)[\w -]*/i },
  { vendor: 'brother', match: /brother/i, model: /\b(MFC|DCP|HL)-[\w-]+/i },
  { vendor: 'epson', match: /epson/i, model: /\b(WorkForce|EcoTank|Expression)[\w -]*/i },
  { vendor: 'kyocera', match: /kyocera/i, model: /\b(ECOSYS|TASKalfa)[\w -]*/i },
];

export function parseSysDescr(sysDescr: string): DeviceIdentity {
  const text = sysDescr.trim();
  if (!text) return {};
  for (const rule of VENDOR_RULES) {
    if (rule.match.test(text)) {
      const identity: DeviceIdentity = { vendor: rule.vendor };
      const model = rule.model?.exec(text);
      if (model) identity.model = model[0].trim().replace(/\s+/g, ' ');
      return identity;
    }
  }
  return {};
}

/**
 * Canon Remote UI detector (design doc §5 reachability pre-check). Canon
 * imageCLASS web pages carry "Canon" plus a Remote UI marker ("Remote UI"
 * title text or /rui/ asset paths).
 */
export function looksLikeCanonRemoteUi(html: string): boolean {
  const text = html.toLowerCase();
  if (!text) return false;
  return (
    text.includes('canon') && (text.includes('remote ui') || text.includes('/rui/'))
  );
}

/** Normalize one mDNS record into a DiscoveredPrinter; null when unusable. */
export function normalizeMdnsRecord(record: MdnsRecord): DiscoveredPrinter | null {
  const ipv4 = record.addresses?.find((addr) => isValidIpv4(addr));
  const host = ipv4 ?? record.host;
  if (!host || !record.port) return null;
  const printer: DiscoveredPrinter = { host, port: record.port, via: 'mdns' };
  if (record.host) printer.hostname = record.host.replace(/\.$/, '');
  return printer;
}

/**
 * Dedupe/merge by host: a new host is stored as-is; a repeat host only fills
 * in fields it doesn't have yet (e.g. SNMP enrichment arriving after mDNS).
 */
export function mergeFound(
  found: Map<string, DiscoveredPrinter>,
  next: DiscoveredPrinter,
): { printer: DiscoveredPrinter; changed: boolean } {
  const existing = found.get(next.host);
  if (!existing) {
    found.set(next.host, next);
    return { printer: next, changed: true };
  }
  const merged = { ...existing };
  let changed = false;
  for (const key of ['hostname', 'vendor', 'model'] as const) {
    if (!merged[key] && next[key]) {
      merged[key] = next[key];
      changed = true;
    }
  }
  if (changed) found.set(next.host, merged);
  return { printer: merged, changed };
}

export type ManualCheckStatus = 'printer' | 'reachable-unknown' | 'unreachable';

export interface ManualCheckResult {
  status: ManualCheckStatus;
  host: string;
  vendor?: string;
  model?: string;
}

export interface DiscoveryDeps {
  mdns: MdnsBrowser;
  snmp?: SnmpProber;
  http?: HttpFetcher;
}

export class DiscoveryService {
  private found = new Map<string, DiscoveredPrinter>();
  private foundListeners = new Set<(printer: DiscoveredPrinter) => void>();
  private errorListeners = new Set<(err: Error) => void>();
  private probing = new Set<string>();
  private running = false;

  constructor(private deps: DiscoveryDeps) {}

  /** Subscribe to live discoveries (initial hit and later enrichments). */
  onPrinterFound(cb: (printer: DiscoveredPrinter) => void): () => void {
    this.foundListeners.add(cb);
    return () => this.foundListeners.delete(cb);
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => this.errorListeners.delete(cb);
  }

  get printers(): DiscoveredPrinter[] {
    return [...this.found.values()];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.deps.mdns.start(
      (record) => {
        void this.handleRecord(record);
      },
      (err) => {
        for (const cb of this.errorListeners) cb(err);
      },
    );
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.deps.mdns.stop();
  }

  /** Drop accumulated results (renderer rescans start from a clean slate). */
  clear(): void {
    this.found.clear();
    this.probing.clear();
  }

  private emit(printer: DiscoveredPrinter): void {
    for (const cb of this.foundListeners) cb(printer);
  }

  private async handleRecord(record: MdnsRecord): Promise<void> {
    const normalized = normalizeMdnsRecord(record);
    if (!normalized) return;
    const { printer, changed } = mergeFound(this.found, normalized);
    if (changed) this.emit(printer);
    if (!this.deps.snmp || printer.vendor || this.probing.has(printer.host)) return;

    this.probing.add(printer.host);
    try {
      const sysDescr = await this.deps.snmp.getSysDescr(printer.host, SNMP_TIMEOUT_MS);
      if (!sysDescr) return;
      const identity = parseSysDescr(sysDescr);
      if (!identity.vendor && !identity.model) return;
      const enriched = mergeFound(this.found, { ...printer, ...identity });
      if (enriched.changed) this.emit(enriched.printer);
    } catch {
      // SNMP probe failures are non-fatal — the mDNS record still stands.
    } finally {
      this.probing.delete(printer.host);
    }
  }

  /**
   * Manual-IP reachability pre-check (design doc §5): HTTP GET the device
   * root, then classify — Canon Remote UI / reachable-unknown / unreachable.
   * Reachable printers also get an SNMP sysDescr probe for vendor/model.
   */
  async checkManualHost(ip: string): Promise<ManualCheckResult> {
    const host = ip.trim();
    if (!isValidIpv4(host)) throw new Error(`Invalid IPv4 address: ${ip}`);
    if (!this.deps.http) return { status: 'unreachable', host };

    const { reachable, body } = await this.deps.http.getRoot(host, MANUAL_CHECK_TIMEOUT_MS);
    if (!reachable) return { status: 'unreachable', host };
    if (!looksLikeCanonRemoteUi(body)) return { status: 'reachable-unknown', host };

    const result: ManualCheckResult = { status: 'printer', host };
    if (this.deps.snmp) {
      try {
        const sysDescr = await this.deps.snmp.getSysDescr(host, SNMP_TIMEOUT_MS);
        if (sysDescr) Object.assign(result, parseSysDescr(sysDescr));
      } catch {
        // Non-fatal: the Remote UI classification is answer enough.
      }
    }
    return result;
  }
}

/**
 * Deterministic no-network service for the Playwright e2e suite (CI has no
 * printers): never emits mDNS hits, manual checks always report unreachable.
 */
export function createOfflineDiscoveryService(): DiscoveryService {
  return new DiscoveryService({
    mdns: { start: () => undefined, stop: () => undefined },
    http: {
      getRoot: () => Promise.resolve({ reachable: false, body: '' }),
    },
  });
}

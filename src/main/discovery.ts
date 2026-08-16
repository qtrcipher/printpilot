/**
 * LAN printer discovery (design doc §3).
 *
 * Phase 1: typed stub only. Phase 2 implements:
 * - mDNS browsing for _ipp._tcp, _http._tcp, _pdl-datastream._tcp
 * - SNMP sysDescr probes for vendor/model identification
 * - manual-IP add with reachability pre-check (design doc §5)
 */

export interface DiscoveredPrinter {
  host: string; // IP or mDNS hostname
  port: number;
  vendor?: string;
  model?: string;
  /** Which discovery channel found it. */
  via: 'mdns' | 'snmp' | 'manual';
}

export interface DiscoveryService {
  /** Start a scan; resolves with whatever was found within the window. */
  scan(timeoutMs: number): Promise<DiscoveredPrinter[]>;
  stop(): void;
}

/** Stub that always reports an empty LAN until Phase 2 lands. */
export function createDiscoveryService(): DiscoveryService {
  return {
    // TODO(Phase 2): mDNS + SNMP probes.
    scan: () => Promise.resolve([]),
    stop: () => undefined,
  };
}

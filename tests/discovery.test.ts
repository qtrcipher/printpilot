import { describe, expect, it } from 'vitest';
import {
  DiscoveryService,
  isValidHostname,
  isValidIpv4,
  looksLikeCanonRemoteUi,
  mergeFound,
  normalizeMdnsRecord,
  parseSysDescr,
  type DiscoveredPrinter,
  type HttpFetcher,
  type MdnsRecord,
  type SnmpProber,
} from '../src/main/discovery';

describe('isValidIpv4', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidIpv4('192.168.1.50')).toBe(true);
    expect(isValidIpv4('0.0.0.0')).toBe(true);
    expect(isValidIpv4('255.255.255.255')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidIpv4('999.1.1.1')).toBe(false);
    expect(isValidIpv4('192.168.1')).toBe(false);
    expect(isValidIpv4('192.168.1.1.1')).toBe(false);
    expect(isValidIpv4('abc')).toBe(false);
    expect(isValidIpv4('')).toBe(false);
    expect(isValidIpv4('192.168.01.1')).toBe(false); // leading zero
  });
});

describe('isValidHostname', () => {
  it('accepts hostnames and mDNS names', () => {
    expect(isValidHostname('printer')).toBe(true);
    expect(isValidHostname('canon-mf750.local.')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidHostname('-bad-')).toBe(false);
    expect(isValidHostname('')).toBe(false);
    expect(isValidHostname('has space')).toBe(false);
  });
});

describe('parseSysDescr', () => {
  it('parses a Canon MF-series sysDescr', () => {
    expect(parseSysDescr('Canon MF753Cdw /PCL6')).toEqual({ vendor: 'canon', model: 'MF753Cdw' });
    expect(parseSysDescr('Canon Inc. iR-ADV C5535  UFRII')).toEqual({
      vendor: 'canon',
      model: 'iR-ADV C5535 UFRII',
    });
  });

  it('parses other common vendors', () => {
    expect(parseSysDescr('HP ETHERNET MULTI-ENVIRONMENT, LaserJet Pro M404dn')).toEqual({
      vendor: 'hp',
      model: 'LaserJet Pro M404dn',
    });
    expect(parseSysDescr('Brother MFC-L3770CDW series')).toEqual({
      vendor: 'brother',
      model: 'MFC-L3770CDW',
    });
  });

  it('returns vendor only when no model pattern matches', () => {
    expect(parseSysDescr('Canon network device')).toEqual({ vendor: 'canon' });
  });

  it('returns empty for generic or empty strings', () => {
    expect(parseSysDescr('Linux router 5.10.0 #1 SMP')).toEqual({});
    expect(parseSysDescr('')).toEqual({});
    expect(parseSysDescr('   ')).toEqual({});
  });
});

describe('looksLikeCanonRemoteUi', () => {
  it('detects Canon Remote UI pages', () => {
    expect(
      looksLikeCanonRemoteUi('<html><head><title>Remote UI</title></head><body>Canon</body></html>'),
    ).toBe(true);
    expect(
      looksLikeCanonRemoteUi('<html><body><script src="/rui/rui_framework.js"></script>canon</body></html>'),
    ).toBe(true);
  });

  it('rejects non-printer pages', () => {
    expect(looksLikeCanonRemoteUi('<html><head><title>Router admin</title></head></html>')).toBe(false);
    expect(looksLikeCanonRemoteUi('<html><body>Welcome to nginx!</body></html>')).toBe(false);
    // Canon name alone is not enough (e.g. a marketing page mirror).
    expect(looksLikeCanonRemoteUi('<html><body>Canon camera store</body></html>')).toBe(false);
    expect(looksLikeCanonRemoteUi('')).toBe(false);
  });
});

describe('normalizeMdnsRecord', () => {
  it('prefers an IPv4 address and strips the mDNS trailing dot', () => {
    expect(
      normalizeMdnsRecord({
        name: 'Canon MF750',
        host: 'CANON-ABC.local.',
        port: 80,
        addresses: ['fe80::1', '192.168.1.50'],
      }),
    ).toEqual({ host: '192.168.1.50', port: 80, hostname: 'CANON-ABC.local', via: 'mdns' });
  });

  it('falls back to the hostname when no IPv4 is present', () => {
    const printer = normalizeMdnsRecord({ name: 'x', host: 'printer.local.', port: 631 });
    expect(printer?.host).toBe('printer.local.');
  });

  it('returns null when there is no usable host', () => {
    expect(normalizeMdnsRecord({ name: 'x', port: 80 })).toBeNull();
    expect(normalizeMdnsRecord({ name: 'x', host: 'h', port: 0 })).toBeNull();
  });
});

describe('mergeFound', () => {
  const base: DiscoveredPrinter = { host: '192.168.1.50', port: 80, via: 'mdns' };

  it('stores a new host and reports changed', () => {
    const found = new Map<string, DiscoveredPrinter>();
    expect(mergeFound(found, base).changed).toBe(true);
    expect(found.get('192.168.1.50')).toEqual(base);
  });

  it('dedupes a repeat host with no new information', () => {
    const found = new Map([[base.host, base]]);
    expect(mergeFound(found, { ...base, name: 'other' } as DiscoveredPrinter).changed).toBe(false);
  });

  it('merges SNMP enrichment into the existing entry', () => {
    const found = new Map([[base.host, base]]);
    const { printer, changed } = mergeFound(found, { ...base, vendor: 'canon', model: 'MF753Cdw' });
    expect(changed).toBe(true);
    expect(printer).toEqual({ ...base, vendor: 'canon', model: 'MF753Cdw' });
    expect(found.get(base.host)).toEqual(printer);
  });
});

/** Fake mDNS browser that lets the test push records synchronously. */
function fakeMdns() {
  let onUp: ((record: MdnsRecord) => void) | undefined;
  return {
    browser: {
      start(cb: (record: MdnsRecord) => void) {
        onUp = cb;
      },
      stop() {
        onUp = undefined;
      },
    },
    emit(record: MdnsRecord) {
      onUp?.(record);
    },
  };
}

const idle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('DiscoveryService with injected fakes', () => {
  it('dedupes repeat mDNS records and emits only on change', async () => {
    const mdns = fakeMdns();
    const service = new DiscoveryService({ mdns: mdns.browser });
    const seen: DiscoveredPrinter[] = [];
    service.onPrinterFound((p) => seen.push(p));

    service.start();
    mdns.emit({ name: 'a', host: 'printer.local.', port: 80, addresses: ['192.168.1.50'] });
    mdns.emit({ name: 'b', port: 631, addresses: ['192.168.1.50'] }); // same host
    await idle();

    expect(seen).toHaveLength(1);
    expect(service.printers).toHaveLength(1);
    expect(service.printers[0]?.host).toBe('192.168.1.50');
  });

  it('enriches a hit with parsed SNMP sysDescr', async () => {
    const mdns = fakeMdns();
    const snmp: SnmpProber = { getSysDescr: () => Promise.resolve('Canon MF753Cdw /PCL6') };
    const service = new DiscoveryService({ mdns: mdns.browser, snmp });
    const seen: DiscoveredPrinter[] = [];
    service.onPrinterFound((p) => seen.push(p));

    service.start();
    mdns.emit({ name: 'a', port: 80, addresses: ['192.168.1.50'] });
    await idle();
    await idle();

    expect(seen).toHaveLength(2); // initial hit + enrichment
    expect(seen[1]).toMatchObject({ host: '192.168.1.50', vendor: 'canon', model: 'MF753Cdw' });
  });

  it('survives SNMP probe failures without losing the mDNS hit', async () => {
    const mdns = fakeMdns();
    const snmp: SnmpProber = { getSysDescr: () => Promise.reject(new Error('timeout')) };
    const service = new DiscoveryService({ mdns: mdns.browser, snmp });
    const seen: DiscoveredPrinter[] = [];
    service.onPrinterFound((p) => seen.push(p));

    service.start();
    mdns.emit({ name: 'a', port: 80, addresses: ['192.168.1.50'] });
    await idle();
    await idle();

    expect(seen).toHaveLength(1);
    expect(service.printers[0]?.vendor).toBeUndefined();
  });

  it('classifies manual-IP checks into the three outcomes', async () => {
    const mdns = fakeMdns();
    const canonHtml: HttpFetcher = {
      getRoot: () =>
        Promise.resolve({ reachable: true, body: '<title>Remote UI</title> Canon imageCLASS' }),
    };
    const otherHtml: HttpFetcher = {
      getRoot: () => Promise.resolve({ reachable: true, body: '<title>Router</title>' }),
    };
    const dead: HttpFetcher = {
      getRoot: () => Promise.resolve({ reachable: false, body: '' }),
    };
    const snmp: SnmpProber = { getSysDescr: () => Promise.resolve('Canon MF753Cdw /PCL6') };

    const printer = await new DiscoveryService({ mdns: mdns.browser, http: canonHtml, snmp }).checkManualHost('192.168.1.50');
    expect(printer).toEqual({ status: 'printer', host: '192.168.1.50', vendor: 'canon', model: 'MF753Cdw' });

    const unknown = await new DiscoveryService({ mdns: mdns.browser, http: otherHtml }).checkManualHost('192.168.1.1');
    expect(unknown).toEqual({ status: 'reachable-unknown', host: '192.168.1.1' });

    const unreachable = await new DiscoveryService({ mdns: mdns.browser, http: dead }).checkManualHost('192.168.1.99');
    expect(unreachable).toEqual({ status: 'unreachable', host: '192.168.1.99' });
  });

  it('rejects invalid manual-IP input before any network call', async () => {
    const service = new DiscoveryService({ mdns: fakeMdns().browser });
    await expect(service.checkManualHost('not-an-ip')).rejects.toThrow(/Invalid IPv4/);
  });
});

import { describe, expect, it } from 'vitest';
import type { Bonjour } from 'bonjour-service';
import type { MdnsRecord } from '../src/main/discovery';
import { createMdnsBrowser } from '../src/main/discovery-net';

/**
 * The real adapters are excluded from unit tests (house rule: no sockets in
 * CI) — except the mDNS lifecycle, exercised here through the injected
 * Bonjour factory (audit 2026-08-24: stop() destroyed the one Bonjour
 * instance forever, so every scan after the first found nothing).
 */

class FakeBrowser {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeBonjour {
  destroyed = false;
  browsers: FakeBrowser[] = [];
  private pending: Array<(service: MdnsRecord) => void> = [];

  find(_opts: { type: string }, onUp: (service: MdnsRecord) => void): FakeBrowser {
    const browser = new FakeBrowser();
    this.browsers.push(browser);
    this.pending.push(onUp);
    return browser;
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Push a record as if the network answered. */
  emit(record: MdnsRecord): void {
    for (const onUp of this.pending) onUp(record);
  }
}

describe('createMdnsBrowser lifecycle', () => {
  it('survives stop → start → stop: each start gets a fresh Bonjour', () => {
    const instances: FakeBonjour[] = [];
    const browser = createMdnsBrowser(() => {
      const instance = new FakeBonjour();
      instances.push(instance);
      return instance as unknown as Bonjour;
    });

    const seen: MdnsRecord[] = [];
    const onUp = (record: MdnsRecord): void => {
      seen.push(record);
    };
    const onError = (): void => undefined;
    const record: MdnsRecord = { name: 'MF750', host: 'p.local', port: 80, addresses: ['192.168.1.50'] };

    browser.start(onUp, onError);
    expect(instances).toHaveLength(1);
    instances[0]?.emit(record);

    browser.stop();
    expect(instances[0]?.destroyed).toBe(true);
    expect(instances[0]?.browsers.every((b) => b.stopped)).toBe(true);

    // The rescan must use a new, undestroyed instance — and still deliver.
    browser.start(onUp, onError);
    expect(instances).toHaveLength(2);
    expect(instances[1]?.destroyed).toBe(false);
    instances[1]?.emit(record);

    browser.stop();
    expect(instances[1]?.destroyed).toBe(true);
    // One emit per running instance × one browser per MDNS_TYPES entry.
    expect(seen).toHaveLength(2 * 3);
  });
});

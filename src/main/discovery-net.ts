/**
 * Real network adapters for DiscoveryService — Electron main process only.
 * Kept separate from discovery.ts so unit tests never touch a socket.
 */
import { Bonjour } from 'bonjour-service';
import snmp, { type Session } from 'net-snmp';
import {
  DiscoveryService,
  type HttpFetcher,
  type MdnsBrowser,
  type SnmpProber,
} from './discovery';

/** Design doc §3: browse IPP, generic HTTP, and AppSocket/JetDirect services. */
const MDNS_TYPES = ['ipp', 'http', 'pdl-datastream'] as const;

/** SNMP sysDescr — the standard "what are you" OID. */
const SYS_DESCR_OID = '1.3.6.1.2.1.1.1.0';

export function createMdnsBrowser(createBonjour: () => Bonjour = () => new Bonjour()): MdnsBrowser {
  // bonjour.destroy() kills the responder socket permanently, so a stopped
  // instance can never browse again — construct a fresh one per start()
  // (every discovery:start stops the previous scan first).
  let bonjour: Bonjour | null = null;
  let browsers: Bonjour.Browser[] = [];
  return {
    start(onUp, onError) {
      bonjour ??= createBonjour();
      for (const type of MDNS_TYPES) {
        try {
          const browser = bonjour.find({ type }, (service) => {
            onUp({
              name: service.name,
              host: service.host,
              port: service.port,
              addresses: service.addresses,
            });
          });
          browsers.push(browser);
        } catch (err) {
          // e.g. no usable network interface — surface to the renderer.
          onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
    stop() {
      for (const browser of browsers) browser.stop();
      browsers = [];
      bonjour?.destroy();
      bonjour = null;
    },
  };
}

export function createSnmpProber(): SnmpProber {
  return {
    getSysDescr(host, timeoutMs) {
      return new Promise((resolve) => {
        let session: Session;
        try {
          session = snmp.createSession(host, 'public', {
            version: snmp.Version2c,
            timeout: timeoutMs,
            retries: 0,
          });
        } catch {
          resolve(null);
          return;
        }
        const done = (value: string | null): void => {
          try {
            session.close();
          } catch {
            // already closed
          }
          resolve(value);
        };
        session.on('error', () => done(null));
        session.get([SYS_DESCR_OID], (error, varbinds) => {
          if (error || !varbinds || varbinds.length === 0) {
            done(null);
            return;
          }
          const value = varbinds[0]?.value;
          if (typeof value === 'string') done(value);
          else if (Buffer.isBuffer(value)) done(value.toString('utf8'));
          else done(null);
        });
      });
    },
  };
}

export function createHttpFetcher(): HttpFetcher {
  return {
    async getRoot(host, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`http://${host}/`, {
          signal: controller.signal,
          redirect: 'follow',
        });
        // Any HTTP response means the device is reachable; the body decides
        // whether it looks like a printer.
        return { reachable: true, body: await res.text() };
      } catch {
        return { reachable: false, body: '' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function createDiscoveryService(): DiscoveryService {
  return new DiscoveryService({
    mdns: createMdnsBrowser(),
    snmp: createSnmpProber(),
    http: createHttpFetcher(),
  });
}

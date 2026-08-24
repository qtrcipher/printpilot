import { describe, expect, it } from 'vitest';
import { decideNavigation, permissionDecision } from '../src/main/security';

describe('decideNavigation', () => {
  it('allows http(s) pages on the printer host (with port)', () => {
    expect(decideNavigation('http://192.168.1.50:8931/menu.html', '192.168.1.50:8931')).toEqual({
      action: 'allow',
    });
    expect(decideNavigation('https://printer.local/login', 'printer.local')).toEqual({
      action: 'allow',
    });
  });

  it('matches printers on default ports — new URL().host strips them', () => {
    // The stored allowlist entry is always host:port (control:connect), but
    // http://host/ has no explicit port — both sides must normalize.
    expect(decideNavigation('http://192.168.1.50/menu.html', '192.168.1.50:80')).toEqual({
      action: 'allow',
    });
    expect(decideNavigation('https://printer.local/login', 'printer.local:443')).toEqual({
      action: 'allow',
    });
    // …and an explicit default port in the URL still matches.
    expect(decideNavigation('http://192.168.1.50:80/menu.html', '192.168.1.50:80')).toEqual({
      action: 'allow',
    });
    expect(decideNavigation('https://printer.local:443/login', 'printer.local:443')).toEqual({
      action: 'allow',
    });
    // Default port on the wrong scheme is not the printer.
    expect(decideNavigation('http://192.168.1.50/x', '192.168.1.50:443').action).toBe('external');
  });

  it('routes other http(s) URLs to the system browser', () => {
    expect(decideNavigation('https://example.com/track', '192.168.1.50:8931')).toEqual({
      action: 'external',
      url: 'https://example.com/track',
    });
    // Same hostname, different port = a different host, not the printer.
    expect(decideNavigation('http://192.168.1.50:9999/x', '192.168.1.50:8931').action).toBe('external');
  });

  it('denies non-http(s) schemes outright (file:, data:, javascript:)', () => {
    for (const url of ['file:///etc/passwd', 'data:text/html,<script>x</script>', 'javascript:alert(1)']) {
      const decision = decideNavigation(url, '192.168.1.50:8931');
      expect(decision.action).toBe('deny');
    }
  });

  it('denies unparseable URLs', () => {
    expect(decideNavigation('not a url', '192.168.1.50').action).toBe('deny');
  });

  it('with no printer host known, every http(s) URL is external', () => {
    expect(decideNavigation('http://192.168.1.50/', null).action).toBe('external');
  });
});

describe('permissionDecision', () => {
  it('denies every permission by default', () => {
    for (const permission of ['media', 'geolocation', 'notifications', 'midi', 'openExternal', 'unknown']) {
      expect(permissionDecision(permission)).toBe(false);
    }
  });
});

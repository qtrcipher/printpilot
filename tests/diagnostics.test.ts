import { describe, expect, it } from 'vitest';
import { buildDiagnostics } from '../src/main/diagnostics';
import { defaultSettings, SETTINGS_VERSION } from '../src/main/settings';

function input(overrides: Partial<Parameters<typeof buildDiagnostics>[0]> = {}) {
  return {
    appVersion: '0.1.0',
    electronVersion: '43.4.0',
    chromeVersion: '142.0.0',
    platform: 'linux' as const,
    osRelease: '6.8.0-generic',
    arch: 'x64',
    adapterIds: ['canon-mf750', 'generic'],
    settings: { ...defaultSettings(), version: SETTINGS_VERSION },
    profiles: [],
    ...overrides,
  };
}

describe('buildDiagnostics', () => {
  it('includes versions, OS, adapters, and a settings summary', () => {
    const text = buildDiagnostics(input());
    expect(text).toContain('App: 0.1.0 (Electron 43.4.0, Chromium 142.0.0)');
    expect(text).toContain('OS: linux x64 6.8.0-generic');
    expect(text).toContain('Adapters: canon-mf750, generic');
    expect(text).toContain('theme: system');
    expect(text).toContain('scanWindowMs=5000');
    expect(text).toContain('Profiles (0)');
  });

  it('never leaks credential material — blobs become a boolean', () => {
    const text = buildDiagnostics(
      input({
        profiles: [
          {
            id: 'p1',
            nickname: 'Office',
            host: '192.168.1.50',
            vendor: 'canon',
            model: 'MF750',
            adapter: 'canon-mf750',
            credentialEnc: 'SECRET-BLOB-deadbeef',
          },
        ],
      }),
    );
    expect(text).toContain('Office (192.168.1.50)');
    expect(text).toContain('credential=saved');
    expect(text).not.toContain('SECRET-BLOB-deadbeef');
    expect(text).not.toContain('credentialEnc');
  });

  it('summarizes remapped gamepad actions without dumping raw bindings', () => {
    const settings = {
      ...defaultSettings(),
      gamepad: { activate: { kind: 'button', index: 7 } as const },
    };
    const text = buildDiagnostics(input({ settings: { ...settings, version: SETTINGS_VERSION } }));
    expect(text).toContain('remapped [activate]');
  });
});

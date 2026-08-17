// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANON_SUPPORT_URL,
  createRecoveryGuide,
  hasOfflineProfiles,
  RECOVERY_PATHS,
  wireRecoveryToggle,
} from '../src/renderer/recovery';

describe('recovery guide content model', () => {
  it('offers the three recovery paths in order: Ethernet, Direct Connection, USB tool', () => {
    expect(RECOVERY_PATHS.map((p) => p.id)).toEqual(['ethernet', 'direct-connection', 'usb-tool']);
  });

  it('keeps the honesty caveats in the wording', () => {
    const direct = RECOVERY_PATHS[1]!;
    expect(direct.lines.join(' ')).toContain('previously enabled');
    expect(direct.lines.join(' ')).toContain('192.168.22.1');

    const usb = RECOVERY_PATHS[2]!;
    expect(usb.lines.join(' ')).toContain("Canon's own");
    expect(usb.link?.url).toBe(CANON_SUPPORT_URL);
  });

  it('leads with Ethernet as the primary path', () => {
    const ethernet = RECOVERY_PATHS[0]!;
    expect(ethernet.lines.join(' ').toLowerCase()).toContain('cable');
    expect(ethernet.lines.join(' ')).toContain('Remote UI');
  });
});

describe('createRecoveryGuide', () => {
  it('renders an ordered checklist with every path and line', () => {
    const guide = createRecoveryGuide({ openExternal: vi.fn() });
    const items = guide.querySelectorAll('ol > li');
    expect(items).toHaveLength(3);
    expect(guide.textContent).toContain("Can't reach your printer?");
    expect(guide.textContent).toContain('Direct Connection');
    expect(guide.textContent).toContain('192.168.22.1');
  });

  it('routes the Canon support link through openExternal, not navigation', () => {
    const openExternal = vi.fn();
    const guide = createRecoveryGuide({ openExternal });
    const link = guide.querySelector<HTMLButtonElement>('.recovery-guide__link');
    expect(link).not.toBeNull();
    expect(link!.tagName).toBe('BUTTON');
    link!.click();
    expect(openExternal).toHaveBeenCalledWith(CANON_SUPPORT_URL);
  });
});

describe('wireRecoveryToggle', () => {
  let button: HTMLButtonElement;
  let guide: HTMLElement;

  beforeEach(() => {
    button = document.createElement('button');
    guide = document.createElement('div');
    guide.hidden = true;
  });

  it('toggles guide visibility and aria-expanded together', () => {
    wireRecoveryToggle(button, guide);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe(guide.id);

    button.click();
    expect(guide.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.click();
    expect(guide.hidden).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps multiple affordances for one guide in sync', () => {
    const second = document.createElement('button');
    wireRecoveryToggle(button, guide);
    wireRecoveryToggle(second, guide);

    button.click();
    expect(guide.hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(second.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('hasOfflineProfiles', () => {
  const profiles = [{ host: '192.168.1.50' }, { host: '192.168.1.60' }];

  it('is true only when a saved host is missing from the discovered set', () => {
    expect(hasOfflineProfiles(profiles, new Set(['192.168.1.50']))).toBe(true);
    expect(hasOfflineProfiles(profiles, new Set(['192.168.1.50', '192.168.1.60']))).toBe(false);
    expect(hasOfflineProfiles([], new Set())).toBe(false);
  });
});

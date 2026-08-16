// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERIC_ADAPTER, validateAdapterManifest } from '../src/main/adapters';
import type { PrintPilotBridge } from '../src/preload/index';
import { createControlView } from '../src/renderer/control';

/**
 * Component-level coverage of the credential-offer path (design doc §7:
 * "app offers keychain save after a successful login"). Deliberately not
 * e2e — driving a real login redirect inside a guest webview would be flaky.
 */

const CONTROL_MARKUP = `
  <section id="control-view" hidden>
    <button id="control-back"></button>
    <span id="control-dot" class="status-dot"></span>
    <span id="control-name"></span>
    <span id="control-host"></span>
    <span id="control-page"></span>
    <p id="control-adapter-notice" hidden></p>
    <div id="control-loading"><p id="control-loading-name"></p></div>
    <div id="control-error" hidden>
      <p id="control-error-message"></p>
      <button id="control-retry"></button>
      <button id="control-open-browser"></button>
    </div>
    <div id="control-webview-host" hidden></div>
    <div id="credential-offer" hidden>
      <span id="credential-offer-text"></span>
      <button id="credential-save"></button>
      <button id="credential-dismiss"></button>
    </div>
    <footer id="hint-bar"></footer>
    <span id="nav-focus-probe"></span>
  </section>`;

const CANON_ADAPTER = validateAdapterManifest({
  id: 'canon-mf750',
  vendor: 'canon',
  login: {
    urlPatterns: ['/login'],
    formSelector: 'form',
    passwordSelector: 'input[type="password"]',
  },
});

function fakeBridge() {
  return {
    connectPrinter: vi.fn(async () => ({
      url: 'http://192.168.1.50/',
      preloadUrl: 'file:///preload/webview.mjs',
      adapter: CANON_ADAPTER,
      adapterMatched: true,
    })),
    setProfileCredential: vi.fn(async () => undefined),
    openExternal: vi.fn(async () => undefined),
  } as unknown as PrintPilotBridge & {
    connectPrinter: ReturnType<typeof vi.fn>;
    setProfileCredential: ReturnType<typeof vi.fn>;
  };
}

function guestEvent(target: Element, type: string, props: Record<string, unknown>): void {
  const event = new Event(type);
  Object.assign(event, props);
  target.dispatchEvent(event);
}

function el<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

describe('control view credential offer', () => {
  beforeEach(() => {
    document.body.innerHTML = CONTROL_MARKUP;
  });

  it('offers to save the PIN after login succeeds, and saves on confirm', async () => {
    const bridge = fakeBridge();
    const showToast = vi.fn();
    const view = createControlView({ getBridge: () => bridge, showToast, onExit: vi.fn() });

    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50', profileId: 'p1' });
    const guest = document.querySelector('webview')!;
    expect(guest.getAttribute('src')).toBe('http://192.168.1.50/');
    expect(guest.getAttribute('preload')).toBe('file:///preload/webview.mjs');

    // Guest reports the PIN, then navigation leaves the login page → success.
    guestEvent(guest, 'ipc-message', {
      channel: 'nav:login-submitted',
      args: [{ pin: '7654321' }],
    });
    guestEvent(guest, 'did-navigate', { url: 'http://192.168.1.50/top.html' });

    const offer = el('#credential-offer');
    expect(offer.hidden).toBe(false);
    expect(el('#credential-offer-text').textContent).toContain('Office MF750');

    el<HTMLButtonElement>('#credential-save').click();
    await Promise.resolve();
    expect(bridge.setProfileCredential).toHaveBeenCalledWith('p1', '7654321');
    expect(offer.hidden).toBe(true);
    expect(showToast).toHaveBeenCalledWith('PIN saved to this profile.');
  });

  it('does not offer while navigation stays on the login page (failed login)', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50', profileId: 'p1' });
    const guest = document.querySelector('webview')!;
    guestEvent(guest, 'ipc-message', {
      channel: 'nav:login-submitted',
      args: [{ pin: 'wrong' }],
    });
    guestEvent(guest, 'did-navigate', { url: 'http://192.168.1.50/login?error=1' });
    expect(el('#credential-offer').hidden).toBe(true);
  });

  it('never offers without a saved profile to attach the PIN to', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Discovered', host: '192.168.1.60' });
    const guest = document.querySelector('webview')!;
    guestEvent(guest, 'ipc-message', {
      channel: 'nav:login-submitted',
      args: [{ pin: '7654321' }],
    });
    guestEvent(guest, 'did-navigate', { url: 'http://192.168.1.60/top.html' });
    expect(el('#credential-offer').hidden).toBe(true);
    expect(bridge.setProfileCredential).not.toHaveBeenCalled();
  });

  it('shows the adapter-mismatch notice but stays usable', async () => {
    const bridge = fakeBridge();
    bridge.connectPrinter.mockResolvedValue({
      url: 'http://10.0.0.9/',
      preloadUrl: 'file:///preload/webview.mjs',
      adapter: GENERIC_ADAPTER,
      adapterMatched: false,
    });
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Mystery', host: '10.0.0.9' });
    expect(el('#control-adapter-notice').hidden).toBe(false);
    expect(document.querySelector('webview')).not.toBeNull();
  });

  it('shows an error state with retry when the guest fails to load', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50' });
    const guest = document.querySelector('webview')!;
    guestEvent(guest, 'did-fail-load', {
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
    });
    expect(el('#control-error').hidden).toBe(false);
    expect(el('#control-webview-host').hidden).toBe(true);
    expect(el('#control-error-message').textContent).toContain("didn't load");
  });

  it('renders key-cap hints and mirrors guest focus into the aria-live probe', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50' });
    const hintText = el('#hint-bar').textContent ?? '';
    expect(hintText).toContain('Move');
    expect(hintText).toContain('Select');
    expect(hintText).toContain('Ctrl+`');

    const guest = document.querySelector('webview')!;
    guestEvent(guest, 'ipc-message', { channel: 'nav:focus-changed', args: ['Menu'] });
    expect(el('#nav-focus-probe').textContent).toBe('Menu');
  });
});

describe('control view on-screen D-pad', () => {
  beforeEach(() => {
    document.body.innerHTML = CONTROL_MARKUP;
  });

  it('shows the pad on connect and forwards pad presses to the guest as nav:event', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50' });

    const pad = el('#nav-pad');
    expect(pad.hidden).toBe(false);

    const guest = document.querySelector('webview')!;
    const send = vi.fn();
    Object.assign(guest, { send });
    pad.querySelector('#nav-pad-down')!.dispatchEvent(new Event('pointerdown'));
    expect(send).toHaveBeenCalledWith('nav:event', { type: 'move', direction: 'down' });
    pad.querySelector('#nav-pad-down')!.dispatchEvent(new Event('pointerup'));
    pad.querySelector('#nav-pad-ok')!.dispatchEvent(new Event('pointerdown'));
    expect(send).toHaveBeenCalledWith('nav:event', { type: 'activate' });
  });

  it('honors the settings toggle (hidden when off, live-updatable)', async () => {
    const bridge = fakeBridge();
    const view = createControlView({
      getBridge: () => bridge,
      showToast: vi.fn(),
      getOnScreenPadVisible: () => false,
      onExit: vi.fn(),
    });
    await view.connect({ nickname: 'Office MF750', host: '192.168.1.50' });
    expect(el('#nav-pad').hidden).toBe(true);

    view.setPadVisible(true);
    expect(el('#nav-pad').hidden).toBe(false);
    view.setPadVisible(false);
    expect(el('#nav-pad').hidden).toBe(true);
  });
});

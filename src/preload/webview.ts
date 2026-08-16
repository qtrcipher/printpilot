import { ipcRenderer } from 'electron';
import {
  FocusRing,
  GamepadInputSource,
  KeyboardInputSource,
  LoginWatcher,
  NavEventBus,
  type InputSource,
} from './nav-layer';
import type { AdapterManifest } from '../main/adapters';

/**
 * Guest preload injected into the embedded printer Remote UI page (design
 * doc §3: webview + preload = control core). Runs in the isolated world
 * with contextIsolation on / nodeIntegration off — it shares the page DOM
 * but not its JS globals, so the nav layer can't be clobbered by page
 * scripts. Host → guest config arrives via `nav:config`; guest → host
 * events go over ipcRenderer.sendToHost (received as `ipc-message` on the
 * <webview> element in the shell).
 */

export interface NavConfig {
  adapter: AdapterManifest;
  /** Saved profile the credential offer should attach to, if any. */
  profileId?: string;
}

let bus: InputSource | null = null;
let ring: FocusRing | null = null;
let loginWatcher: LoginWatcher | null = null;
let adapter: AdapterManifest | null = null;

function describe(element: HTMLElement): string {
  const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ');
  const label = element.getAttribute('aria-label') ?? text;
  return label.slice(0, 80) || element.tagName.toLowerCase();
}

function startNavLayer(config: NavConfig): void {
  adapter = config.adapter;

  ring = new FocusRing(document, {
    skipSelectors: adapter.focusSkip,
    onFocusChange: (element) => {
      ipcRenderer.sendToHost('nav:focus-changed', element ? describe(element) : '');
    },
  });
  ring.start();

  bus = new NavEventBus([new KeyboardInputSource(window), new GamepadInputSource(window)]);
  bus.onEvent((event) => {
    if (event.type === 'leave') {
      // No keyboard traps (design doc §7): Ctrl+` hands focus to the shell.
      ipcRenderer.sendToHost('nav:leave');
      return;
    }
    ring?.handle(event);
  });
  bus.start();

  loginWatcher = new LoginWatcher(document, adapter.login, (pin) => {
    ipcRenderer.sendToHost('nav:login-submitted', { pin });
  });
  loginWatcher.start();
}

ipcRenderer.on('nav:config', (_event, config: NavConfig) => {
  if (bus) return; // already configured (config is sent once per connection)
  startNavLayer(config);
});

// Tell the shell whether the loaded page still looks like the login page, so
// the credential offer only fires after a *successful* login (navigation
// away from the login URL).
function reportPageKind(): void {
  if (!adapter) return;
  const hasPasswordForm = Boolean(
    document.querySelector(adapter.login.passwordSelector)?.closest(adapter.login.formSelector),
  );
  ipcRenderer.sendToHost('nav:page-kind', { login: hasPasswordForm });
}

window.addEventListener('DOMContentLoaded', reportPageKind);

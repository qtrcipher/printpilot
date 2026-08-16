import { ipcRenderer } from 'electron';
import {
  FocusRing,
  GamepadInputSource,
  KeyboardInputSource,
  LoginWatcher,
  NavEventBus,
  sanitizeNavEvent,
  type InputSource,
  type NavEvent,
} from './nav-layer';
import type { AdapterManifest } from '../main/adapters';
import { DEFAULT_GAMEPAD_MAPPING, type GamepadMapping } from '../main/settings-schema';

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
  /** Resolved gamepad mapping from settings.json (defaults fill gaps). */
  gamepad?: GamepadMapping;
  /** Key overrides from key-kind remap bindings (key → nav event). */
  keyMap?: Record<string, NavEvent>;
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

  const dispatch = (event: NavEvent): void => {
    if (event.type === 'leave') {
      // No keyboard traps (design doc §7): Ctrl+` hands focus to the shell.
      ipcRenderer.sendToHost('nav:leave');
      return;
    }
    ring?.handle(event);
  };

  bus = new NavEventBus([
    new KeyboardInputSource(window, config.keyMap ?? {}),
    new GamepadInputSource(window, { mapping: config.gamepad ?? DEFAULT_GAMEPAD_MAPPING }),
  ]);
  bus.onEvent(dispatch);
  bus.start();

  // On-screen D-pad: the shell forwards validated pointer events here; they
  // take the exact same path as keyboard/gamepad input.
  ipcRenderer.on('nav:event', (_event, payload: unknown) => {
    const event = sanitizeNavEvent(payload);
    if (event) dispatch(event);
  });

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

// Forward page errors to the shell → main's rotating log (design doc §5).
// The shell relays these over the typed log:write IPC (rate-limited there).
function forwardPageError(message: string): void {
  ipcRenderer.sendToHost('log:guest', { level: 'error', message: message.slice(0, 500) });
}

window.addEventListener('error', (event) => {
  forwardPageError(`printer page error: ${event.message || 'unknown'}`);
});
window.addEventListener('unhandledrejection', (event) => {
  forwardPageError(`printer page unhandled rejection: ${String(event.reason)}`);
});

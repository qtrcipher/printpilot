import { ipcRenderer } from 'electron';
import {
  FocusRing,
  GamepadInputSource,
  isTextEntryElement,
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

  // Text-entry focus tracking for the on-screen keyboard: the shell shows
  // the keyboard when a text field gains focus, hides it when focus leaves
  // (moving between two text fields keeps it up — relatedTarget check).
  // Registered BEFORE the focus ring starts: ring.start() focuses the first
  // element, which may itself be a text field (e.g. the login PIN input).
  document.addEventListener('focusin', (event) => {
    if (isTextEntryElement(event.target)) {
      ipcRenderer.sendToHost('nav:text-focus', { active: true });
    }
  });
  document.addEventListener('focusout', (event) => {
    if (
      isTextEntryElement(event.target) &&
      !isTextEntryElement((event as FocusEvent).relatedTarget)
    ) {
      ipcRenderer.sendToHost('nav:text-focus', { active: false });
    }
  });
  // Value mirror while a text field is focused (drives the shell-side probe;
  // same trust domain as the credential-offer PIN flow). Truncated.
  // Password fields are excluded (docs/audit-2026-08-24.md): they still get
  // focus reports so the OSK opens for PINs, but their value is never
  // mirrored into the shell DOM.
  document.addEventListener(
    'input',
    (event) => {
      if (!isTextEntryElement(event.target)) return;
      const el = event.target as HTMLElement;
      if (el instanceof HTMLInputElement && el.type === 'password') return;
      const value =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : (el.textContent ?? '');
      ipcRenderer.sendToHost('nav:text-value', { value: value.slice(0, 200) });
    },
    true,
  );

  ring = new FocusRing(document, {
    skipSelectors: adapter.focusSkip,
    onFocusChange: (element) => {
      ipcRenderer.sendToHost('nav:focus-changed', element ? describe(element) : '');
    },
  });
  ring.start();

  // Programmatic focus() in a still-blurred document may not fire focusin —
  // report the initial state explicitly so auto-show can't be missed.
  if (isTextEntryElement(document.activeElement)) {
    ipcRenderer.sendToHost('nav:text-focus', { active: true });
  }

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

  // On-screen keyboard Enter: submit the focused field's form (or click the
  // focused control). Synthetic key events can't express implicit form
  // submission (no keypress leg), so this is DOM-level and deterministic.
  ipcRenderer.on('osk:enter', () => {
    const active = document.activeElement;
    const form = active instanceof HTMLElement ? active.closest('form') : null;
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
    } else if (active instanceof HTMLElement) {
      active.click();
    }
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

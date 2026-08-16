import { isLoginUrl } from '../main/adapters';
import type { GamepadMapping } from '../main/settings-schema';
import type { ConnectResult, ConnectTargetInput, PrintPilotBridge } from '../preload/index';
import type { NavEvent } from '../preload/nav-layer';

/**
 * Control view (design doc §7): embeds the printer's Remote UI in a
 * <webview> with its own nav-layer preload, wrapped in shell chrome —
 * status strip (name, host, live connection dot), persistent hint bar
 * (key caps, or gamepad glyphs while a pad is connected), Back-to-Home.
 *
 * States: loading splash → success (webview) | error banner (Retry /
 * open-in-browser — the webview never shows a raw error page);
 * adapter mismatch degrades to a notice while staying usable.
 *
 * webview vs WebContentsView: the <webview> tag keeps the guest inside the
 * renderer's layout (no main-process bounds bookkeeping) and electron-vite
 * builds the dedicated guest preload as a second preload entry — materially
 * simpler here, same security posture (nodeIntegration off, contextIsolation
 * on, no remote module).
 */

/** Input config threaded to the guest nav layer on connect (settings.json). */
export interface NavInputConfig {
  gamepad: GamepadMapping;
  keyMap: Record<string, NavEvent>;
}

export interface ControlViewDeps {
  getBridge(): PrintPilotBridge | undefined;
  showToast(message: string): void;
  /** Resolved gamepad mapping + key overrides for the guest nav layer. */
  getNavConfig?(): NavInputConfig;
  /** Called when the user returns to Home. */
  onExit(): void;
}

export interface ControlView {
  connect(target: ConnectTargetInput): Promise<void>;
  /** True while the control view is on screen. */
  readonly active: boolean;
  /** Debug menu (dev builds): open the embedded page's DevTools. */
  openGuestDevTools(): void;
}

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

type ControlState = 'loading' | 'success' | 'error';

const KEYBOARD_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['↑ ↓ ← →', 'Move'],
  ['Enter', 'Select'],
  ['Esc', 'Back'],
  ['Tab', 'Next item'],
  ['Ctrl+`', 'App ⇄ Page'],
];

const GAMEPAD_HINTS: ReadonlyArray<readonly [string, string]> = [
  ['✚ / stick', 'Move'],
  ['Ⓐ', 'Select'],
  ['Ⓑ', 'Back'],
  ['Ctrl+`', 'App ⇄ Page'],
];

export function createControlView(deps: ControlViewDeps): ControlView {
  const view = el('#control-view');
  const backButton = el<HTMLButtonElement>('#control-back');
  const dot = el('#control-dot');
  const nameLabel = el('#control-name');
  const hostLabel = el('#control-host');
  const pageLabel = el('#control-page');
  const adapterNotice = el('#control-adapter-notice');
  const loading = el('#control-loading');
  const loadingName = el('#control-loading-name');
  const errorPanel = el('#control-error');
  const errorMessage = el('#control-error-message');
  const retryButton = el<HTMLButtonElement>('#control-retry');
  const openBrowserButton = el<HTMLButtonElement>('#control-open-browser');
  const webviewHost = el('#control-webview-host');
  const hintBar = el('#hint-bar');
  const focusProbe = el('#nav-focus-probe');
  const offer = el('#credential-offer');
  const offerText = el('#credential-offer-text');
  const offerSave = el<HTMLButtonElement>('#credential-save');
  const offerDismiss = el<HTMLButtonElement>('#credential-dismiss');

  let webview: Electron.WebviewTag | null = null;
  let connection: ConnectResult | null = null;
  let target: ConnectTargetInput | null = null;
  let pendingPin: string | null = null;
  // Chromium fires dom-ready for its built-in error page after did-fail-load;
  // this flag keeps the shell error banner from being overwritten by it.
  let loadFailed = false;

  function show(state: ControlState): void {
    loading.hidden = state !== 'loading';
    errorPanel.hidden = state !== 'error';
    webviewHost.hidden = state !== 'success';
  }

  function setOnline(online: boolean): void {
    dot.className = `status-dot ${online ? 'status-dot--online' : 'status-dot--offline'}`;
    dot.title = online ? 'Connected' : 'Not connected';
    dot.setAttribute('aria-label', online ? 'Connected' : 'Not connected');
  }

  function renderHints(gamepad: boolean): void {
    hintBar.replaceChildren(
      ...(gamepad ? GAMEPAD_HINTS : KEYBOARD_HINTS).map(([keys, action]) => {
        const chip = document.createElement('span');
        chip.className = 'hint-bar__chip';
        const cap = document.createElement('kbd');
        cap.className = 'hint-bar__keys';
        cap.textContent = keys;
        const label = document.createElement('span');
        label.textContent = action;
        chip.append(cap, label);
        return chip;
      }),
    );
  }

  function hideOffer(): void {
    offer.hidden = true;
    pendingPin = null;
  }

  function maybeOfferCredential(url: string): void {
    if (!pendingPin || !connection || !target?.profileId) return;
    if (isLoginUrl(url, connection.adapter)) return; // still on the login page
    const pin = pendingPin;
    offerText.textContent = `Save the Remote UI PIN for ${target.nickname}?`;
    offerSave.onclick = () => {
      const bridge = deps.getBridge();
      const profileId = target?.profileId;
      hideOffer();
      if (!bridge || !profileId) return;
      void bridge
        .setProfileCredential(profileId, pin)
        .then(() => deps.showToast('PIN saved to this profile.'))
        .catch((err: unknown) =>
          deps.showToast(err instanceof Error ? err.message : String(err)),
        );
    };
    offerDismiss.onclick = hideOffer;
    offer.hidden = false;
  }

  function attachWebviewEvents(guest: Electron.WebviewTag): void {
    guest.addEventListener('did-start-loading', () => {
      loadFailed = false;
    });

    guest.addEventListener('dom-ready', () => {
      if (!connection || loadFailed) return; // error page's dom-ready — stay on the banner
      const nav = deps.getNavConfig?.();
      guest.send('nav:config', {
        adapter: connection.adapter,
        profileId: target?.profileId,
        gamepad: nav?.gamepad,
        keyMap: nav?.keyMap,
      });
      show('success');
      setOnline(true);
    });

    guest.addEventListener('did-fail-load', (event) => {
      if (event.errorCode === -3) return; // ERR_ABORTED — normal navigation churn
      loadFailed = true;
      show('error');
      setOnline(false);
      errorMessage.textContent =
        `The Remote UI at ${connection?.url ?? 'the printer'} didn't load ` +
        `(${event.errorDescription || 'connection failed'}). Check that the printer is on and ` +
        'reachable, then retry — or open it in your system browser.';
    });

    guest.addEventListener('render-process-gone', () => {
      show('error');
      setOnline(false);
      errorMessage.textContent = 'The embedded page crashed. Retry to reload the Remote UI.';
    });

    guest.addEventListener('did-navigate', (event) => {
      setOnline(true);
      maybeOfferCredential(event.url);
    });

    guest.addEventListener('page-title-updated', (event) => {
      pageLabel.textContent = event.title;
    });

    guest.addEventListener('new-window', (event) => {
      // 'new-window' is legacy-typed as a plain Event; it carries the target URL.
      void deps.getBridge()?.openExternal((event as Event & { url: string }).url);
    });

    guest.addEventListener('ipc-message', (event) => {
      if (event.channel === 'nav:focus-changed') {
        const [label] = event.args as [string];
        focusProbe.textContent = label;
      } else if (event.channel === 'nav:leave') {
        // Ctrl+` inside the page: focus returns to the shell chrome.
        backButton.focus();
      } else if (event.channel === 'nav:login-submitted') {
        const [{ pin }] = event.args as [{ pin: string }];
        pendingPin = pin;
      }
    });
  }

  async function connect(nextTarget: ConnectTargetInput): Promise<void> {
    const bridge = deps.getBridge();
    if (!bridge) return;
    target = nextTarget;
    hideOffer();
    view.hidden = false;
    nameLabel.textContent = nextTarget.nickname;
    hostLabel.textContent =
      nextTarget.port && nextTarget.port !== 80
        ? `${nextTarget.host}:${nextTarget.port}`
        : nextTarget.host;
    pageLabel.textContent = '';
    loadingName.textContent = `Connecting to ${nextTarget.nickname}…`;
    adapterNotice.hidden = true;
    show('loading');
    setOnline(false);
    backButton.focus();

    try {
      connection = await bridge.connectPrinter(nextTarget);
    } catch (err) {
      errorMessage.textContent = err instanceof Error ? err.message : String(err);
      show('error');
      return;
    }
    adapterNotice.hidden = connection.adapterMatched;

    webview?.remove();
    const guest = document.createElement('webview') as Electron.WebviewTag;
    guest.className = 'control__webview';
    guest.setAttribute('src', connection.url);
    guest.setAttribute('preload', connection.preloadUrl);
    // Dedicated guest preload (nav layer). nodeIntegration off,
    // contextIsolation on; sandbox must be off for the ESM preload file.
    guest.setAttribute('webpreferences', 'contextIsolation=yes, nodeIntegration=no, sandbox=no');
    webview = guest;
    webviewHost.replaceChildren(guest);
    attachWebviewEvents(guest);
  }

  function close(): void {
    webview?.remove();
    webview = null;
    connection = null;
    target = null;
    hideOffer();
    view.hidden = true;
    deps.onExit();
  }

  backButton.addEventListener('click', close);
  retryButton.addEventListener('click', () => {
    show('loading');
    webview?.reload();
  });
  openBrowserButton.addEventListener('click', () => {
    if (connection) void deps.getBridge()?.openExternal(connection.url);
  });

  // Gamepad-aware hint bar (design doc §7); disconnect = non-blocking notice.
  window.addEventListener('gamepadconnected', () => renderHints(true));
  window.addEventListener('gamepaddisconnected', () => {
    renderHints(false);
    if (!view.hidden) deps.showToast('Gamepad disconnected — keyboard controls still work.');
  });
  renderHints(false);

  // Ctrl+` in the shell hands focus to the embedded page (no keyboard traps).
  document.addEventListener('keydown', (event) => {
    if (view.hidden) return;
    if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === '`') {
      event.preventDefault();
      webview?.focus();
    }
  });

  return {
    connect,
    get active() {
      return !view.hidden;
    },
    openGuestDevTools() {
      webview?.openDevTools();
    },
  };
}

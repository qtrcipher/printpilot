import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import { isValidIpv4, type DiscoveredPrinter } from '../main/discovery';
import {
  GAMEPAD_ACTIONS,
  resolveGamepadMapping,
  type SettingsFile,
  type ThemeSetting,
} from '../main/settings-schema';
import type { AppInfo, ConnectTargetInput, PrintPilotBridge, PublicProfile } from '../preload/index';
import type { NavEvent } from '../preload/nav-layer';
import { createControlView, type NavInputConfig } from './control';
import { createOnboarding } from './onboarding';
import { createSettingsView } from './settings';
import './styles.css';

/**
 * Home/discovery screen (design doc §7 four-state rule):
 * loading = scan skeleton; error = discovery failure + retry; empty = no
 * printers → guided Add-by-IP with reachability pre-check; success = printer
 * list (saved profiles pinned with status dot, discovered-but-unsaved below
 * with a Save action). Clicking a printer opens the control view (simple
 * view switching — no router dep).
 */

declare global {
  interface Window {
    printpilot?: PrintPilotBridge;
  }
}

const bridge = window.printpilot;

// Forward shell runtime errors to the main-process rotating log (design §5).
window.addEventListener('error', (event) => {
  void bridge?.writeLog('error', `shell error: ${event.message || 'unknown'}`);
});
window.addEventListener('unhandledrejection', (event) => {
  void bridge?.writeLog('error', `shell unhandled rejection: ${String(event.reason).slice(0, 400)}`);
});

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

const homeView = el('#app');
const settingsButton = el<HTMLButtonElement>('#settings-button');
const scanButton = el<HTMLButtonElement>('#scan-button');
const addIpButton = el<HTMLButtonElement>('#add-ip-button');
const retryButton = el<HTMLButtonElement>('#retry-button');
const skeleton = el('#scan-skeleton');
const errorState = el('#error-state');
const errorMessage = el('#error-message');
const emptyState = el('#empty-state');
const listState = el('#list-state');
const savedHeading = el('#saved-heading');
const discoveredHeading = el('#discovered-heading');
const savedList = el<HTMLUListElement>('#saved-list');
const discoveredList = el<HTMLUListElement>('#discovered-list');
const manualAdd = el<HTMLFormElement>('#manual-add');
const ipInput = el<HTMLInputElement>('#ip-input');
const checkIpButton = el<HTMLButtonElement>('#check-ip-button');
const ipFeedback = el('#ip-feedback');
const saveManualButton = el<HTMLButtonElement>('#save-manual-button');
const toast = el('#toast');
const versionLabel = el('#version-label');

type HomeState = 'loading' | 'error' | 'empty' | 'success';

let scanWindowMs = 5000;
let scanTimer: number | undefined;
let toastTimer: number | undefined;
let savedProfiles: PublicProfile[] = [];
let appInfo: AppInfo | null = null;
let settings: SettingsFile | null = null;
const discovered = new Map<string, DiscoveredPrinter>();
let lastManualHit: { host: string; vendor: string; model: string } | null = null;

/* --- Theme (design doc §8): dark default, light palette as a second set of
   CSS variables toggled by data-theme; "system" follows the OS. ---------- */
const darkSchemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(theme: ThemeSetting): void {
  const resolved = theme === 'system' ? (darkSchemeQuery.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
}

darkSchemeQuery.addEventListener('change', () => {
  if (!settings || settings.theme === 'system') applyTheme('system');
});

/** Input config handed to the control view → webview guest on connect. */
function buildNavConfig(): NavInputConfig {
  const gamepad = resolveGamepadMapping(settings?.gamepad);
  const keyMap: Record<string, NavEvent> = {};
  for (const action of GAMEPAD_ACTIONS) {
    const binding = gamepad[action];
    if (binding.kind !== 'key') continue;
    keyMap[binding.key] =
      action === 'activate'
        ? { type: 'activate' }
        : action === 'back'
          ? { type: 'back' }
          : { type: 'move', direction: action };
  }
  return { gamepad, keyMap };
}

function show(state: HomeState): void {
  skeleton.hidden = state !== 'loading';
  errorState.hidden = state !== 'error';
  emptyState.hidden = state !== 'empty';
  listState.hidden = state !== 'success';
  manualAdd.hidden = state === 'loading' || state === 'error';
  addIpButton.disabled = state === 'loading' || state === 'error';
}

function showToast(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3000);
}

const controlView = createControlView({
  getBridge: () => bridge,
  showToast,
  getNavConfig: buildNavConfig,
  onExit: () => {
    homeView.hidden = false;
    scanButton.focus();
  },
});

function openControl(target: ConnectTargetInput): void {
  homeView.hidden = true;
  void controlView.connect(target);
}

/* --- Settings view + onboarding (design doc §7) --------------------------- */

const settingsView = createSettingsView({
  getBridge: () => bridge,
  getAppInfo: () => appInfo,
  showToast,
  onSettingsChanged: (updated) => {
    settings = updated;
    applyTheme(updated.theme);
    scanWindowMs = updated.discovery.scanWindowMs;
  },
  onShowWelcome: () => {
    reshowingWelcome = true;
    onboarding.show();
  },
  openGuestDevTools: () => controlView.openGuestDevTools(),
  connectFakePrinter: () => {
    homeView.hidden = false; // settings hid itself; Home owns the flow
    void connectFakePrinter();
  },
  onExit: () => {
    homeView.hidden = false;
    settingsButton.focus();
  },
});

settingsButton.addEventListener('click', () => {
  if (!settings || controlView.active) return;
  homeView.hidden = true;
  settingsView.open(settings);
});

let reshowingWelcome = false;
const onboarding = createOnboarding({
  onDismiss: () => {
    // Dismiss or completion both mean: never show again (design doc §7).
    void bridge
      ?.updateSettings({ onboardingSeen: true })
      .then((updated) => {
        settings = updated;
      })
      .catch(() => undefined);
    if (reshowingWelcome) {
      reshowingWelcome = false;
      homeView.hidden = false;
      settingsButton.focus();
    } else {
      void startScan(); // straight into the normal Home scan
    }
  },
});

/** Debug menu shortcut: connect to the fake/fixture printer (fake discovery). */
async function connectFakePrinter(): Promise<void> {
  if (!bridge) return;
  showToast('Looking for the fake printer…');
  const off = bridge.onPrinterFound((printer) => {
    off();
    window.clearTimeout(giveUp);
    openControl({
      nickname: printer.hostname ?? 'Fake printer',
      host: printer.host,
      port: printer.port,
      vendor: printer.vendor ?? '',
      model: printer.model ?? '',
      adapter: printer.vendor === 'canon' ? 'canon-mf750' : '',
    });
  });
  const giveUp = window.setTimeout(() => {
    off();
    showToast('No fake printer found — start the app with PRINTPILOT_FAKE_DISCOVERY=1.');
  }, 5000);
  await bridge.startDiscovery();
}

function showError(message: string): void {
  window.clearTimeout(scanTimer);
  errorMessage.textContent = message;
  scanButton.disabled = false;
  scanButton.textContent = 'Scan for printers';
  show('error');
}

function settleScan(): void {
  scanButton.disabled = false;
  scanButton.textContent = 'Scan for printers';
  show(savedProfiles.length + discovered.size > 0 ? 'success' : 'empty');
}

async function startScan(): Promise<void> {
  if (!bridge) return;
  show('loading');
  scanButton.disabled = true; // disable during async command (design doc §7)
  scanButton.textContent = 'Scanning…';
  discovered.clear();
  renderLists();
  try {
    await bridge.startDiscovery();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(settleScan, scanWindowMs);
}

function onPrinterFound(printer: DiscoveredPrinter): void {
  discovered.set(printer.host, printer);
  // Live updates: swap whatever is showing (skeleton, empty) for the list.
  show('success');
  renderLists();
}

function describe(printer: { vendor?: string; model?: string }): string {
  return [printer.vendor, printer.model].filter(Boolean).join(' ');
}

function rowButton(primary: string, secondary: string, onOpen: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'printer-row';
  const name = document.createElement('span');
  name.className = 'printer-row__name';
  name.textContent = primary;
  const detail = document.createElement('span');
  detail.className = 'printer-row__detail mono';
  detail.textContent = secondary;
  button.append(name, detail);
  button.addEventListener('click', onOpen);
  return button;
}

function renderLists(): void {
  // Saved profiles pinned on top, status dot green when the host is
  // currently discovered on the LAN.
  savedList.replaceChildren();
  for (const profile of savedProfiles) {
    const li = document.createElement('li');
    li.className = 'printer-list__item';
    const online = discovered.has(profile.host);
    const dot = document.createElement('span');
    dot.className = `status-dot ${online ? 'status-dot--online' : 'status-dot--offline'}`;
    dot.title = online ? 'Online' : 'Not seen on the network';
    const row = rowButton(
      profile.nickname,
      [profile.host, describe(profile)].filter(Boolean).join(' · '),
      () => {
        openControl({
          nickname: profile.nickname,
          host: profile.host,
          vendor: profile.vendor,
          model: profile.model,
          adapter: profile.adapter,
          profileId: profile.id,
        });
      },
    );
    row.prepend(dot);
    li.append(row);
    savedList.append(li);
  }
  savedHeading.hidden = savedProfiles.length === 0;

  // Discovered-but-unsaved below, each with a Save action.
  const savedHosts = new Set(savedProfiles.map((p) => p.host));
  const unsaved = [...discovered.values()].filter((p) => !savedHosts.has(p.host));
  discoveredList.replaceChildren();
  for (const printer of unsaved) {
    const li = document.createElement('li');
    li.className = 'printer-list__item';
    const row = rowButton(
      printer.hostname ?? printer.host,
      [printer.host, describe(printer)].filter(Boolean).join(' · '),
      () => {
        openControl({
          nickname: printer.hostname || describe(printer) || printer.host,
          host: printer.host,
          port: printer.port,
          vendor: printer.vendor ?? '',
          model: printer.model ?? '',
          adapter: printer.vendor === 'canon' ? 'canon-mf750' : '',
        });
      },
    );
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'btn btn--secondary printer-list__save';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      void saveDiscovered(printer, save);
    });
    li.append(row, save);
    discoveredList.append(li);
  }
  discoveredHeading.hidden = unsaved.length === 0;
}

async function saveDiscovered(printer: DiscoveredPrinter, button: HTMLButtonElement): Promise<void> {
  if (!bridge) return;
  button.disabled = true;
  try {
    await bridge.addProfile({
      nickname: printer.hostname || describe(printer) || printer.host,
      host: printer.host,
      vendor: printer.vendor ?? '',
      model: printer.model ?? '',
      adapter: printer.vendor === 'canon' ? 'canon-mf750' : 'generic',
    });
    savedProfiles = await bridge.listProfiles();
    renderLists();
    showToast(`Saved ${printer.hostname ?? printer.host}.`);
  } catch (err) {
    showToast(err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
  }
}

function feedback(kind: 'info' | 'success' | 'warning' | 'error', message: string): void {
  ipFeedback.className = `manual-add__feedback manual-add__feedback--${kind}`;
  ipFeedback.textContent = message;
  ipFeedback.hidden = false;
}

manualAdd.addEventListener('submit', (event) => {
  event.preventDefault();
  void checkManualIp();
});

async function checkManualIp(): Promise<void> {
  if (!bridge) return;
  const ip = ipInput.value.trim();
  lastManualHit = null;
  saveManualButton.hidden = true;

  // Inline format validation — no IPC round-trip for obvious typos.
  if (!isValidIpv4(ip)) {
    feedback('error', 'Enter a valid IPv4 address, e.g. 192.168.1.50.');
    ipInput.focus();
    return;
  }

  checkIpButton.disabled = true;
  feedback('info', `Checking ${ip}…`);
  try {
    const result = await bridge.checkManualHost(ip);
    switch (result.status) {
      case 'printer': {
        const name = describe(result);
        feedback(
          'success',
          `Found a printer at ${ip}${name ? ` — ${name}` : ''}. Canon Remote UI detected.`,
        );
        lastManualHit = { host: ip, vendor: result.vendor ?? '', model: result.model ?? '' };
        saveManualButton.hidden = false;
        break;
      }
      case 'reachable-unknown':
        feedback(
          'warning',
          `A device answered at ${ip} but it doesn't look like a printer's Remote UI. ` +
            'If this is your printer, its Remote UI may be disabled — enable it in the printer’s network settings and check again.',
        );
        break;
      case 'unreachable':
        feedback(
          'error',
          `Nothing answered at ${ip}. Check that the printer is powered on, connected to the same network, and that the IP is correct.`,
        );
        break;
    }
  } catch (err) {
    feedback('error', err instanceof Error ? err.message : String(err));
  } finally {
    checkIpButton.disabled = false;
  }
}

saveManualButton.addEventListener('click', () => {
  void (async () => {
    if (!bridge || !lastManualHit) return;
    saveManualButton.disabled = true;
    try {
      await bridge.addProfile({
        nickname: lastManualHit.model || lastManualHit.host,
        host: lastManualHit.host,
        vendor: lastManualHit.vendor,
        model: lastManualHit.model,
        adapter: lastManualHit.vendor === 'canon' ? 'canon-mf750' : 'generic',
      });
      savedProfiles = await bridge.listProfiles();
      renderLists();
      saveManualButton.hidden = true;
      show('success');
      showToast(`Saved ${lastManualHit.host}.`);
    } catch (err) {
      feedback('error', err instanceof Error ? err.message : String(err));
    } finally {
      saveManualButton.disabled = false;
    }
  })();
});

scanButton.addEventListener('click', () => {
  void startScan();
});
retryButton.addEventListener('click', () => {
  void startScan();
});
addIpButton.addEventListener('click', () => {
  ipInput.focus();
});

async function init(): Promise<void> {
  if (!bridge) {
    showError('App bridge unavailable — restart the app.');
    return;
  }
  try {
    appInfo = await bridge.getAppInfo();
    versionLabel.textContent = `v${appInfo.version}`;
    scanWindowMs = appInfo.scanWindowMs;
    settings = await bridge.getSettings();
    applyTheme(settings.theme);
    savedProfiles = await bridge.listProfiles();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
    return;
  }
  // Non-scary crash recovery notice (design doc §5; shown exactly once —
  // main consumes the flag when answering app:info).
  if (appInfo.recoveredFromCrash) {
    showToast('PrintPilot recovered from a crash last time. Copy diagnostics in Settings has the details.');
  }
  bridge.onPrinterFound(onPrinterFound);
  bridge.onDiscoveryError(showError);
  if (!settings.onboardingSeen) {
    onboarding.show(); // first run: welcome, then the normal scan on dismiss
    return;
  }
  await startScan(); // scan on launch (design doc §7)
}

void init();

import {
  DEFAULT_GAMEPAD_MAPPING,
  GAMEPAD_ACTIONS,
  describeBinding,
  resolveGamepadMapping,
  type GamepadAction,
  type GamepadBinding,
  type SettingsFile,
} from '../main/settings-schema';
import type { AppInfo, PrintPilotBridge } from '../preload/index';

/**
 * Settings screen (design doc §7): theme, gamepad remap via press-to-assign,
 * scan-window duration, copy-diagnostics, About, and the dev-only debug
 * section. A plain view next to Home/control — no router. Remap bindings
 * are stored sparse in settings.json; the nav layer resolves them over
 * DEFAULT_GAMEPAD_MAPPING on connect.
 */

export interface SettingsViewDeps {
  getBridge(): PrintPilotBridge | undefined;
  getAppInfo(): AppInfo | null;
  showToast(message: string): void;
  /** Called after every successful save so the shell re-applies theme/inputs. */
  onSettingsChanged(settings: SettingsFile): void;
  /** "Show welcome again" — main.ts re-opens the onboarding overlay. */
  onShowWelcome(): void;
  /** Debug menu: open the embedded Remote UI's DevTools (control view owns it). */
  openGuestDevTools(): void;
  /** Debug menu: connect to the fake/fixture printer via fake discovery. */
  connectFakePrinter(): void;
  /** Called when the user returns to Home. */
  onExit(): void;
}

export interface SettingsView {
  open(settings: SettingsFile): void;
  readonly active: boolean;
}

const GITHUB_URL = 'https://github.com/printpilot/printpilot';

const ACTION_LABELS: Record<GamepadAction, string> = {
  up: 'Move up',
  down: 'Move down',
  left: 'Move left',
  right: 'Move right',
  activate: 'Activate',
  back: 'Back',
};

const CAPTURE_AXIS_THRESHOLD = 0.6;

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Missing element: ${selector}`);
  return node;
}

export function createSettingsView(deps: SettingsViewDeps): SettingsView {
  const view = el('#settings-view');
  const backButton = el<HTMLButtonElement>('#settings-back');
  const themeSelect = el<HTMLSelectElement>('#theme-select');
  const remapList = el<HTMLUListElement>('#remap-list');
  const remapReset = el<HTMLButtonElement>('#remap-reset');
  const scanWindowInput = el<HTMLInputElement>('#scan-window-input');
  const copyDiagnosticsButton = el<HTMLButtonElement>('#copy-diagnostics-button');
  const logPathLabel = el('#log-path');
  const revealLogsButton = el<HTMLButtonElement>('#reveal-logs-button');
  const versionLabel = el('#settings-version');
  const githubButton = el<HTMLButtonElement>('#about-github');
  const showWelcomeButton = el<HTMLButtonElement>('#show-welcome');
  const debugSection = el('#debug-section');
  const debugDevtoolsShell = el<HTMLButtonElement>('#debug-devtools-shell');
  const debugDevtoolsGuest = el<HTMLButtonElement>('#debug-devtools-guest');
  const debugFakeConnect = el<HTMLButtonElement>('#debug-fake-connect');
  const debugDumpState = el<HTMLButtonElement>('#debug-dump-state');

  let settings: SettingsFile | null = null;
  let capturing: GamepadAction | null = null;
  let captureFrame: number | null = null;

  function bindingFor(action: GamepadAction): GamepadBinding {
    return (settings ? resolveGamepadMapping(settings.gamepad) : DEFAULT_GAMEPAD_MAPPING)[action];
  }

  function renderRemapList(): void {
    remapList.replaceChildren(
      ...GAMEPAD_ACTIONS.map((action) => {
        const li = document.createElement('li');
        li.className = 'remap-list__row';
        li.dataset.action = action;

        const label = document.createElement('span');
        label.className = 'remap-list__label';
        label.textContent = ACTION_LABELS[action];

        const binding = document.createElement('span');
        binding.className = 'remap-list__binding mono';
        binding.textContent =
          capturing === action
            ? 'Press a gamepad button, move a stick, or press a key…'
            : describeBinding(bindingFor(action));

        const assign = document.createElement('button');
        assign.type = 'button';
        assign.className = 'btn btn--secondary remap-list__assign';
        assign.textContent = capturing === action ? 'Cancel (Esc)' : 'Assign';
        assign.setAttribute(
          'aria-label',
          capturing === action
            ? `Cancel remapping ${ACTION_LABELS[action]}`
            : `Remap ${ACTION_LABELS[action]}`,
        );
        assign.addEventListener('click', () => {
          if (capturing === action) stopCapture();
          else startCapture(action);
        });

        li.append(label, binding, assign);
        return li;
      }),
    );
  }

  async function saveGamepad(gamepad: SettingsFile['gamepad']): Promise<void> {
    const bridge = deps.getBridge();
    if (!bridge) return;
    try {
      const updated = await bridge.updateSettings({ gamepad });
      settings = updated;
      deps.onSettingsChanged(updated);
      renderRemapList();
    } catch (err) {
      deps.showToast(err instanceof Error ? err.message : String(err));
    }
  }

  function onCaptureKeydown(event: KeyboardEvent): void {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      stopCapture();
      return;
    }
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return; // modifier-only press
    const action = capturing;
    stopCapture();
    if (!settings) return;
    void saveGamepad({ ...settings.gamepad, [action]: { kind: 'key', key: event.key } }).then(() => {
      deps.showToast(`${ACTION_LABELS[action]} assigned to key “${event.key}”.`);
    });
  }

  function pollGamepadCapture(): void {
    if (!capturing) return;
    const pads = navigator.getGamepads?.() ?? [];
    for (const pad of pads) {
      if (!pad) continue;
      for (let index = 0; index < pad.buttons.length; index += 1) {
        if (pad.buttons[index]?.pressed) {
          finishGamepadCapture({ kind: 'button', index });
          return;
        }
      }
      for (let axis = 0; axis < pad.axes.length; axis += 1) {
        const value = pad.axes[axis] ?? 0;
        if (Math.abs(value) >= CAPTURE_AXIS_THRESHOLD) {
          finishGamepadCapture({ kind: 'axis', axis, sign: value > 0 ? 1 : -1 });
          return;
        }
      }
    }
    captureFrame = window.requestAnimationFrame(pollGamepadCapture);
  }

  function finishGamepadCapture(binding: GamepadBinding): void {
    const action = capturing;
    if (!action) return;
    stopCapture();
    if (!settings) return;
    void saveGamepad({ ...settings.gamepad, [action]: binding }).then(() => {
      deps.showToast(`${ACTION_LABELS[action]} assigned to ${describeBinding(binding)}.`);
    });
  }

  function startCapture(action: GamepadAction): void {
    stopCapture();
    capturing = action;
    renderRemapList();
    document.addEventListener('keydown', onCaptureKeydown, true);
    captureFrame = window.requestAnimationFrame(pollGamepadCapture);
  }

  function stopCapture(): void {
    if (captureFrame !== null) {
      window.cancelAnimationFrame(captureFrame);
      captureFrame = null;
    }
    document.removeEventListener('keydown', onCaptureKeydown, true);
    if (capturing !== null) {
      capturing = null;
      renderRemapList();
    }
  }

  backButton.addEventListener('click', () => {
    stopCapture();
    view.hidden = true;
    deps.onExit();
  });

  themeSelect.addEventListener('change', () => {
    const bridge = deps.getBridge();
    if (!bridge) return;
    const theme = themeSelect.value as SettingsFile['theme'];
    void bridge
      .updateSettings({ theme })
      .then((updated) => {
        settings = updated;
        deps.onSettingsChanged(updated);
      })
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)));
  });

  remapReset.addEventListener('click', () => {
    remapReset.disabled = true;
    void saveGamepad({})
      .then(() => deps.showToast('Gamepad mapping reset to defaults.'))
      .finally(() => {
        remapReset.disabled = false;
        renderRemapList();
      });
  });

  scanWindowInput.addEventListener('change', () => {
    const bridge = deps.getBridge();
    if (!bridge) return;
    const scanWindowMs = Number.parseInt(scanWindowInput.value, 10);
    if (!Number.isInteger(scanWindowMs) || scanWindowMs < 500 || scanWindowMs > 60_000) {
      deps.showToast('Scan window must be between 500 and 60000 ms.');
      scanWindowInput.value = String(settings?.discovery.scanWindowMs ?? 5000);
      return;
    }
    void bridge
      .updateSettings({ discovery: { scanWindowMs } })
      .then((updated) => {
        settings = updated;
        deps.onSettingsChanged(updated);
      })
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)));
  });

  copyDiagnosticsButton.addEventListener('click', () => {
    const bridge = deps.getBridge();
    if (!bridge) return;
    copyDiagnosticsButton.disabled = true;
    void bridge
      .copyDiagnostics()
      .then(() => deps.showToast('Diagnostics copied to the clipboard.'))
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        copyDiagnosticsButton.disabled = false;
      });
  });

  revealLogsButton.addEventListener('click', () => {
    void deps
      .getBridge()
      ?.revealLogFile()
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)));
  });

  githubButton.addEventListener('click', () => {
    void deps.getBridge()?.openExternal(GITHUB_URL);
  });

  showWelcomeButton.addEventListener('click', () => {
    stopCapture();
    view.hidden = true;
    deps.onShowWelcome();
  });

  debugDevtoolsShell.addEventListener('click', () => {
    void deps
      .getBridge()
      ?.debugOpenDevTools()
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)));
  });
  debugDevtoolsGuest.addEventListener('click', () => deps.openGuestDevTools());
  debugFakeConnect.addEventListener('click', () => {
    stopCapture();
    view.hidden = true;
    deps.connectFakePrinter();
  });
  debugDumpState.addEventListener('click', () => {
    void deps
      .getBridge()
      ?.debugDumpState()
      .then(() => deps.showToast('Redacted state dumped to the clipboard.'))
      .catch((err: unknown) => deps.showToast(err instanceof Error ? err.message : String(err)));
  });

  return {
    open(next: SettingsFile) {
      settings = next;
      themeSelect.value = next.theme;
      scanWindowInput.value = String(next.discovery.scanWindowMs);
      versionLabel.textContent = `v${deps.getAppInfo()?.version ?? '?'}`;
      logPathLabel.textContent = deps.getAppInfo()?.logFilePath ?? '';
      debugSection.hidden = !deps.getAppInfo()?.debugMenu;
      renderRemapList();
      view.hidden = false;
      backButton.focus();
    },
    get active() {
      return !view.hidden;
    },
  };
}

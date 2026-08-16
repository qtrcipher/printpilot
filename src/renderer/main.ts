import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/700.css';
import './styles.css';

/**
 * Home/discovery screen placeholder (Phase 1). Real discovery, the guided
 * Add-by-IP flow, and the control view are Phase 2 — the scan button only
 * demonstrates the loading → empty state cycle and the disable-during-async
 * rule (design doc §7).
 */

interface PrintPilotBridge {
  getAppInfo(): Promise<{ version: string }>;
}

declare global {
  interface Window {
    printpilot?: PrintPilotBridge;
  }
}

const scanButton = document.querySelector<HTMLButtonElement>('#scan-button');
const addIpButton = document.querySelector<HTMLButtonElement>('#add-ip-button');
const skeleton = document.querySelector<HTMLElement>('#scan-skeleton');
const emptyState = document.querySelector<HTMLElement>('#empty-state');
const versionLabel = document.querySelector<HTMLElement>('#version-label');

if (scanButton && skeleton && emptyState) {
  scanButton.addEventListener('click', () => {
    scanButton.disabled = true;
    addIpButton?.setAttribute('disabled', '');
    emptyState.hidden = true;
    skeleton.hidden = false;

    window.setTimeout(() => {
      skeleton.hidden = true;
      emptyState.hidden = false;
      scanButton.disabled = false;
    }, 1200);
  });
}

void window.printpilot?.getAppInfo().then((info) => {
  if (versionLabel) versionLabel.textContent = `v${info.version}`;
});

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright/test';

/**
 * Shared Electron launch helper for the e2e suite.
 *
 * Determinism: PRINTPILOT_FAKE_DISCOVERY=1 swaps mDNS/SNMP/HTTP for a
 * no-network stub, PRINTPILOT_SCAN_WINDOW_MS shrinks the scan window, and
 * PRINTPILOT_CONFIG_DIR points the app at a throwaway config dir so runs
 * never touch the developer's real profiles/settings. Config dirs are
 * seeded with onboardingSeen=true so the first-run welcome (tested
 * separately in settings.spec.ts) doesn't block the Home screen.
 */

export async function makeConfigDir(onboardingSeen = true): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printpilot-e2e-'));
  if (onboardingSeen) {
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({ version: 2, onboardingSeen: true }),
    );
  }
  return dir;
}

export async function launchApp(
  extraEnv: Record<string, string> = {},
  configDir?: string,
): Promise<ElectronApplication> {
  return electron.launch({
    args: ['.'],
    env: {
      ...process.env,
      PRINTPILOT_FAKE_DISCOVERY: '1',
      PRINTPILOT_SCAN_WINDOW_MS: '300',
      PRINTPILOT_CONFIG_DIR: configDir ?? (await makeConfigDir()),
      ...extraEnv,
    },
  });
}

/**
 * First shell window with a deterministic dark OS scheme — the default
 * theme is "system", and Playwright's default color scheme is light, which
 * would flip token-dependent assertions (e.g. the focus-ring color).
 */
export async function firstPage(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.emulateMedia({ colorScheme: 'dark' });
  return page;
}

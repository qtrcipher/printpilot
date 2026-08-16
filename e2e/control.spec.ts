import { expect, test, type ElectronApplication } from 'playwright/test';
import { startFixtureServer, type FixtureServer } from '../tests/fixtures/server';
import { firstPage, launchApp } from './launch';

/**
 * Control-view e2e (house rule: no physical printer). The mock Canon Remote
 * UI fixtures are served from 127.0.0.1:8931 and the app is pointed at them
 * via the deterministic fake-discovery hook (PRINTPILOT_FAKE_PRINTER_*).
 * Port 8999 is intentionally dead for the error-state test.
 */

const FIXTURE_PORT = 8931;
const DEAD_PORT = 8999;

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer(FIXTURE_PORT);
});

test.afterAll(async () => {
  await fixtures.close();
});

function launchAgainst(port: number): Promise<ElectronApplication> {
  return launchApp({
    PRINTPILOT_FAKE_PRINTER_HOST: '127.0.0.1',
    PRINTPILOT_FAKE_PRINTER_PORT: String(port),
  });
}

test('control view: status strip, hint bar, focus ring, activate, back', async () => {
  const app = await launchAgainst(FIXTURE_PORT);
  const page = await firstPage(app);

  try {
    // Discovered fake printer appears under "Found on this network".
    const row = page.locator('#discovered-list .printer-row');
    await expect(row).toBeVisible();
    await row.click();

    // Status strip: nickname, host in mono, connection dot, page title.
    await expect(page.locator('#control-view')).toBeVisible();
    await expect(page.locator('#control-host')).toHaveText(`127.0.0.1:${FIXTURE_PORT}`);
    await expect(page.locator('#hint-bar')).toBeVisible();
    await expect(page.locator('#hint-bar')).toContainText('Move');
    await expect(page.locator('#hint-bar')).toContainText('Ctrl+`');

    // Fake printer has no vendor → generic adapter notice, still usable.
    await expect(page.locator('#control-adapter-notice')).toBeVisible();

    // Loading splash → success: webview host visible, dot online.
    await expect(page.locator('#control-webview-host')).toBeVisible();
    await expect(page.locator('#control-dot')).toHaveClass(/status-dot--online/);
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');

    // Focus the embedded page (Ctrl+` — the documented focus-boundary chord).
    const probe = page.locator('#nav-focus-probe');
    await expect(probe).toHaveText('Status/Cancel'); // first in-page element
    await page.keyboard.press('Control+`');

    // Tab steps sequentially through the fixture's nav links.
    await page.keyboard.press('Tab');
    await expect(probe).toHaveText('Menu');

    // Enter activates the focused link → guest navigates → title updates.
    await page.keyboard.press('Enter');
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Menu');

    // Arrow keys move the ring on the new page (menu list links).
    await expect(probe).toHaveText('Status/Cancel');
    await page.keyboard.press('ArrowDown');
    await expect(probe).not.toHaveText('Status/Cancel');

    // Esc = history back → top page again.
    await page.keyboard.press('Escape');
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');

    // Back-to-Home returns to the printer list.
    await page.locator('#control-back').click();
    await expect(page.locator('#control-view')).toBeHidden();
    await expect(page.locator('#list-state')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('control view: on-screen D-pad moves and activates; settings can hide it', async () => {
  const app = await launchAgainst(FIXTURE_PORT);
  const page = await firstPage(app);

  try {
    const row = page.locator('#discovered-list .printer-row');
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#control-webview-host')).toBeVisible();

    // Pad is shown by default and mentioned in the hint bar.
    const pad = page.locator('#nav-pad');
    await expect(pad).toBeVisible();
    await expect(page.locator('#hint-bar')).toContainText('Pad');

    // Pad arrows drive the same in-page focus ring as the keyboard.
    const probe = page.locator('#nav-focus-probe');
    await expect(probe).toHaveText('Status/Cancel');
    await page.locator('#nav-pad-right').click();
    await expect(probe).toHaveText('Menu');

    // OK activates the focused link → guest navigates.
    await page.locator('#nav-pad-ok').click();
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Menu');

    // Settings toggle hides the pad (persisted; re-read on next connect).
    await page.locator('#control-back').click();
    await page.locator('#settings-button').click();
    await page.locator('#onscreen-pad-select').selectOption('hide');
    await page.locator('#settings-back').click();

    await row.click();
    await expect(page.locator('#control-webview-host')).toBeVisible();
    await expect(pad).toBeHidden();
  } finally {
    await app.close();
  }
});

test('control view: error state for an unreachable printer, with Retry', async () => {
  const app = await launchAgainst(DEAD_PORT);
  const page = await firstPage(app);

  try {
    const row = page.locator('#discovered-list .printer-row');
    await expect(row).toBeVisible();
    await row.click();

    // Never a raw webview error page: shell banner with recovery actions.
    await expect(page.locator('#control-error')).toBeVisible();
    await expect(page.locator('#control-error-message')).toContainText("didn't load");
    await expect(page.locator('#control-retry')).toBeVisible();
    await expect(page.locator('#control-open-browser')).toBeVisible();
    await expect(page.locator('#control-webview-host')).toBeHidden();
    await expect(page.locator('#control-dot')).toHaveClass(/status-dot--offline/);

    // Retry stays on the error state while the port is dead (no crash).
    await page.locator('#control-retry').click();
    await expect(page.locator('#control-error')).toBeVisible();
  } finally {
    await app.close();
  }
});

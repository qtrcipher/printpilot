import { expect, test, type ElectronApplication } from 'playwright/test';
import { startFixtureServer, type FixtureServer } from '../tests/fixtures/server';
import { firstPage, launchApp } from './launch';

/**
 * On-screen-keyboard e2e (house rule: no physical printer). The mock Canon
 * login fixture has a text field (System Manager ID) and a password field:
 * focusing a text-entry field in the guest must summon the keyboard, keys
 * must land text in the field (asserted via the shell's text mirror probe),
 * Backspace/Enter act as keys, the settings toggle is respected — and a
 * password field's value must NEVER appear in the mirror (audit 2026-08-24).
 * Fixture served from 127.0.0.1:8932 (8931 is control.spec's).
 */

const FIXTURE_PORT = 8932;

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer(FIXTURE_PORT);
});

test.afterAll(async () => {
  await fixtures.close();
});

function launchAgainstFixture(): Promise<ElectronApplication> {
  return launchApp({
    PRINTPILOT_FAKE_PRINTER_HOST: '127.0.0.1',
    PRINTPILOT_FAKE_PRINTER_PORT: String(FIXTURE_PORT),
  });
}

test('on-screen keyboard: auto-show on text focus, typing, backspace, dismiss, settings', async () => {
  const app = await launchAgainstFixture();
  const page = await firstPage(app);

  try {
    const row = page.locator('#discovered-list .printer-row');
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#control-webview-host')).toBeVisible();

    const osk = page.locator('#osk');
    await expect(osk).toBeHidden(); // no text field on the top page

    // Navigate the guest to the login page (Status/Cancel → Menu → Log Out).
    const probe = page.locator('#nav-focus-probe');
    await expect(probe).toHaveText('Status/Cancel');
    await page.keyboard.press('Control+`');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(probe).toHaveText('Log Out');
    await page.keyboard.press('Enter');
    await expect(page.locator('#control-page')).toHaveText('Remote UI');

    // Focus ring lands on the first text field (System Manager ID) →
    // keyboard auto-appears.
    await expect(osk).toBeVisible();
    await expect(page.locator('#osk-status')).toHaveText('On-screen keyboard shown.');

    // Clicking keys inserts text into the guest's focused text field.
    const textProbe = page.locator('#osk-text-probe');
    await page.locator('#osk [data-text="1"]').click();
    await page.locator('#osk [data-text="2"]').click();
    await page.locator('#osk [data-text="3"]').click();
    await expect(textProbe).toHaveText('123');

    // Shift: letters uppercase, then toggle back off.
    await page.locator('#osk-shift').click();
    await page.locator('#osk [data-text="a"]').click();
    await expect(textProbe).toHaveText('123A');
    await page.locator('#osk-shift').click();
    await page.locator('#osk [data-text="b"]').click();
    await expect(textProbe).toHaveText('123Ab');

    // Backspace deletes the last character.
    await page.locator('#osk-backspace').click();
    await expect(textProbe).toHaveText('123A');

    // Tab inside a text field keeps its native form behavior → focus moves
    // to the password field. The keyboard stays up (PINs need it) but the
    // field's value is never mirrored into the shell.
    await page.keyboard.press('Tab');
    await expect(osk).toBeVisible();
    await page.locator('#osk [data-text="9"]').click();
    const pinValue = await page.evaluate(() => {
      const guest = document.querySelector('webview') as unknown as {
        executeJavaScript(code: string): Promise<unknown>;
      };
      return guest.executeJavaScript('document.getElementById("password").value');
    });
    expect(pinValue).toBe('9'); // typed into the guest…
    await expect(textProbe).toHaveText(''); // …but never mirrored

    // Dismiss hides; the chrome toggle brings it back.
    await page.locator('#osk-dismiss').click();
    await expect(osk).toBeHidden();
    await page.locator('#osk-toggle').click();
    await expect(osk).toBeVisible();

    // Enter submits the login form (fixture redirects to the top page).
    await page.locator('#osk-enter').click();
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');
    await expect(osk).toBeHidden(); // password field lost focus on navigation

    // Settings toggle "never": keyboard stays hidden even on the login page.
    await page.locator('#control-back').click();
    await page.locator('#settings-button').click();
    await page.locator('#onscreen-keyboard-select').selectOption('never');
    await page.locator('#settings-back').click();

    await row.click();
    await expect(page.locator('#control-webview-host')).toBeVisible();
    await expect(page.locator('#nav-focus-probe')).toHaveText('Status/Cancel');
    await page.keyboard.press('Control+`');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#control-page')).toHaveText('Remote UI');
    await expect(osk).toBeHidden();
  } finally {
    await app.close();
  }
});

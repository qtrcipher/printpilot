import { expect, test, type ElectronApplication } from 'playwright/test';
import { startFixtureServer, type FixtureServer } from '../tests/fixtures/server';
import { firstPage, launchApp, makeConfigDir } from './launch';

/**
 * Phase 3 hardening e2e (house rule: no physical printer):
 * - crash-recovery notice, simulated via PRINTPILOT_SIMULATE_CRASH=1
 * - webview navigation limit: the guest cannot leave the printer host
 * - permission policy: every Chromium permission is denied by default
 */

const FIXTURE_PORT = 8932;

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer(FIXTURE_PORT);
});

test.afterAll(async () => {
  await fixtures.close();
});

function launchAgainstFixture(extraEnv: Record<string, string> = {}): Promise<ElectronApplication> {
  return launchApp({
    PRINTPILOT_FAKE_PRINTER_HOST: '127.0.0.1',
    PRINTPILOT_FAKE_PRINTER_PORT: String(FIXTURE_PORT),
    ...extraEnv,
  });
}

test('crash recovery: notice shown once after a crash, then never again', async () => {
  // One config/log dir shared by both launches so the crash flag persists.
  const configDir = await makeConfigDir();
  const app1 = await launchApp({ PRINTPILOT_SIMULATE_CRASH: '1' }, configDir);
  const page1 = await firstPage(app1);
  try {
    await expect(page1.locator('#toast')).toBeVisible();
    await expect(page1.locator('#toast')).toContainText('recovered from a crash');
  } finally {
    await app1.close();
  }

  // Second launch, same dirs, no simulator: the flag was consumed — no notice.
  const app2 = await launchApp({}, configDir);
  const page2 = await firstPage(app2);
  try {
    await expect(page2.locator('#scan-button')).toBeEnabled();
    await expect(page2.locator('#toast')).toBeHidden();
  } finally {
    await app2.close();
  }
});

test('security: webview guest cannot navigate away from the printer host', async () => {
  const app = await launchAgainstFixture();
  const page = await firstPage(app);
  try {
    await page.locator('#discovered-list .printer-row').click();
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');

    // A non-http(s) navigation is denied outright (no file:/data: in the app).
    // Page-initiated via the guest itself — will-navigate does not fire for
    // programmatic loadURL (only the shell can call that, and it never does
    // with untrusted URLs).
    await page.evaluate(() => {
      const guest = document.querySelector('webview') as unknown as {
        executeJavaScript(code: string): Promise<unknown>;
      };
      void guest.executeJavaScript('window.location.href = "file:///etc/passwd"');
    });
    // The guest is still on the fixture page — the navigation never happened.
    await page.waitForTimeout(500); // give a (denied) navigation time to misfire
    const url = await page.evaluate(() =>
      (document.querySelector('webview') as unknown as { getURL(): string }).getURL(),
    );
    expect(url).toBe(`http://127.0.0.1:${FIXTURE_PORT}/`);
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');
  } finally {
    await app.close();
  }
});

test('security: all permission queries are denied by default', async () => {
  const app = await launchAgainstFixture();
  const page = await firstPage(app);
  try {
    const state = await page.evaluate(() =>
      navigator.permissions.query({ name: 'notifications' as PermissionName }).then((r) => r.state),
    );
    expect(state).toBe('denied');
  } finally {
    await app.close();
  }
});

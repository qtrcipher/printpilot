import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'playwright/test';
import { startFixtureServer, type FixtureServer } from '../tests/fixtures/server';
import { firstPage, launchApp } from './launch';

/**
 * README screenshot capture — NOT part of the normal e2e suite (skipped
 * unless PRINTPILOT_SCREENSHOTS=1; run via `npm run screenshots`). Launches
 * the app against the mock Canon fixtures and writes PNGs to
 * docs/screenshots/ at 1280×800, dark theme, deviceScaleFactor 1.
 */

test.skip(!process.env.PRINTPILOT_SCREENSHOTS, 'screenshot capture only (npm run screenshots)');

const FIXTURE_PORT = 8934;
const OUT_DIR = path.join(process.cwd(), 'docs', 'screenshots');

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer(FIXTURE_PORT);
  await mkdir(OUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  await fixtures.close();
});

/** Throwaway config: onboarded, dark theme, 1280×800 window. */
async function screenshotConfigDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printpilot-shots-'));
  await writeFile(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      version: 2,
      onboardingSeen: true,
      theme: 'dark',
      window: { width: 1280, height: 800, maximized: false },
    }),
  );
  return dir;
}

function launchAgainstFixture(configDir: string) {
  return launchApp(
    {
      PRINTPILOT_FAKE_PRINTER_HOST: '127.0.0.1',
      PRINTPILOT_FAKE_PRINTER_PORT: String(FIXTURE_PORT),
    },
    configDir,
  );
}

test('home-empty.png', async () => {
  const app = await launchApp({}, await screenshotConfigDir());
  const page = await firstPage(app);
  try {
    await expect(page.locator('#empty-state')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'home-empty.png'), scale: 'css' });
  } finally {
    await app.close();
  }
});

test('home-discovered, control view, D-pad + OSK, settings', async () => {
  const app = await launchAgainstFixture(await screenshotConfigDir());
  const page = await firstPage(app);
  try {
    // Home with a discovered printer.
    const row = page.locator('#discovered-list .printer-row');
    await expect(row).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'home-discovered.png'), scale: 'css' });

    // Control view: status strip + hint bar + embedded fixture page.
    await row.click();
    await expect(page.locator('#control-webview-host')).toBeVisible();
    await expect(page.locator('#control-page')).toHaveText('Remote UI: Top Page');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'control-view.png'), scale: 'css' });

    // Navigate to the login page → password field focused → OSK appears
    // next to the D-pad.
    await page.keyboard.press('Control+`');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.locator('#control-page')).toHaveText('Remote UI');
    await expect(page.locator('#osk')).toBeVisible();
    await expect(page.locator('#nav-pad')).toBeVisible();
    await page.waitForTimeout(400); // let overlay fade-in finish
    await page.screenshot({ path: path.join(OUT_DIR, 'control-dpad-osk.png'), scale: 'css' });

    // Settings screen.
    await page.locator('#control-back').click();
    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-view')).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, 'settings.png'), scale: 'css' });
  } finally {
    await app.close();
  }
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'playwright/test';
import { firstPage, launchApp, makeConfigDir } from './launch';

/**
 * Settings / onboarding / debug-menu e2e (design doc §7). Config dirs are
 * per-test throwaway dirs (e2e/launch.ts) so onboarding state and persisted
 * settings can be asserted on disk without touching the real config.
 */

async function readSettings(configDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

test('settings opens from the gear, theme toggle flips data-theme and persists', async () => {
  const configDir = await makeConfigDir();
  const app = await launchApp({}, configDir);
  const page = await firstPage(app); // dark OS scheme → dark resolved theme

  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.locator('#settings-button').click();
    await expect(page.locator('#settings-view')).toBeVisible();
    await expect(page.locator('#app')).toBeHidden();

    await page.locator('#theme-select').selectOption('light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.locator('#theme-select').selectOption('dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    // Persisted to settings.json, not just applied.
    expect((await readSettings(configDir)).theme).toBe('dark');

    // Back to Home; focus returns to the gear.
    await page.locator('#settings-back').click();
    await expect(page.locator('#app')).toBeVisible();
    await expect(page.locator('#settings-button')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('remap row enters press-to-assign, Esc cancels cleanly, a key can be assigned', async () => {
  const configDir = await makeConfigDir();
  const app = await launchApp({}, configDir);
  const page = await firstPage(app);

  try {
    await page.locator('#settings-button').click();
    const row = page.locator('.remap-list__row[data-action="activate"]');
    await expect(row.locator('.remap-list__binding')).toHaveText('Button 0'); // default

    // Enter press-to-assign, then cancel with Esc — mapping unchanged.
    await row.locator('.remap-list__assign').click();
    await expect(row.locator('.remap-list__binding')).toContainText('Press a gamepad button');
    await page.keyboard.press('Escape');
    await expect(row.locator('.remap-list__binding')).toHaveText('Button 0');
    expect((await readSettings(configDir)).gamepad ?? {}).toEqual({});

    // Assign a keyboard key — stored in settings.json.
    await row.locator('.remap-list__assign').click();
    await page.keyboard.press('x');
    await expect(row.locator('.remap-list__binding')).toHaveText('Key “x”');
    expect((await readSettings(configDir)).gamepad).toEqual({
      activate: { kind: 'key', key: 'x' },
    });

    // Reset to defaults clears the custom binding.
    await page.locator('#remap-reset').click();
    await expect(row.locator('.remap-list__binding')).toHaveText('Button 0');
    expect((await readSettings(configDir)).gamepad).toEqual({});
  } finally {
    await app.close();
  }
});

test('onboarding shows on a fresh config dir, never again after dismiss', async () => {
  const configDir = await makeConfigDir(false); // unseeded → first run
  const app = await launchApp({}, configDir);
  const page = await firstPage(app);

  try {
    const dialog = page.locator('#onboarding');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('LAN-only, no telemetry, no account');
    // Focus is trapped inside the dialog.
    await expect(page.locator('#onboarding-start')).toBeFocused();

    // Esc skips; the normal Home scan follows.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.locator('#empty-state')).toBeVisible();
    expect((await readSettings(configDir)).onboardingSeen).toBe(true);
  } finally {
    await app.close();
  }

  // Second launch with the same config dir: straight to Home, no welcome.
  const again = await launchApp({}, configDir);
  const page2 = await firstPage(again);
  try {
    await expect(page2.locator('#empty-state')).toBeVisible();
    await expect(page2.locator('#onboarding')).toBeHidden();
  } finally {
    await again.close();
  }
});

test('debug menu is visible in dev builds and hidden when packaged is simulated', async () => {
  const configDir = await makeConfigDir();
  const app = await launchApp({}, configDir);
  const page = await firstPage(app);
  try {
    await page.locator('#settings-button').click();
    await expect(page.locator('#debug-section')).toBeVisible(); // e2e runs unpackaged
  } finally {
    await app.close();
  }

  const packaged = await launchApp({ PRINTPILOT_SIMULATE_PACKAGED: '1' }, configDir);
  const page2 = await firstPage(packaged);
  try {
    await page2.locator('#settings-button').click();
    await expect(page2.locator('#debug-section')).toBeHidden();
  } finally {
    await packaged.close();
  }
});

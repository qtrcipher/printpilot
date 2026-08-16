import { expect, test } from 'playwright/test';
import { firstPage, launchApp } from './launch';

/**
 * Electron shell Home-screen tests (house rule: automated verification only).
 * Requires `npm run build` first — wired into the `test:e2e` script.
 * Launch determinism lives in e2e/launch.ts (fake discovery, short scan
 * window, seeded throwaway config dir, dark OS scheme).
 */

test('app launches, scan settles into the empty state, focus ring is visible', async () => {
  const app = await launchApp();
  const page = await firstPage(app);

  try {
    expect(await page.title()).toBe('PrintPilot');
    await expect(page.locator('.home__title')).toHaveText('PrintPilot');

    // Loading state first: scan-on-launch shows the skeleton.
    await expect(page.locator('#scan-skeleton')).toBeVisible();

    // No printers on the test network → empty state with guided Add-by-IP.
    await expect(page.locator('#empty-state')).toBeVisible();
    await expect(page.locator('#manual-add')).toBeVisible();

    // Hard requirement: visible focus ring on interactive elements.
    // Tab order = visual order: Settings gear → IP input → Check → Scan.
    await page.keyboard.press('Tab');
    await expect(page.locator('#settings-button')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#ip-input')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#check-ip-button')).toBeFocused();
    await page.keyboard.press('Tab');
    const scanButton = page.locator('#scan-button');
    await expect(scanButton).toBeFocused();

    const ring = await scanButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBe('2px');
    expect(ring.color).toBe('rgb(96, 165, 250)'); // --focus-ring #60A5FA (dark theme)
  } finally {
    await app.close();
  }
});

test('manual-IP rejects invalid input inline, without any network call', async () => {
  const app = await launchApp();
  const page = await firstPage(app);

  try {
    await expect(page.locator('#empty-state')).toBeVisible();

    await page.locator('#ip-input').fill('not-an-ip');
    await page.locator('#check-ip-button').click();

    const feedback = page.locator('#ip-feedback');
    await expect(feedback).toBeVisible();
    await expect(feedback).toContainText('valid IPv4');
    await expect(page.locator('#ip-input')).toBeFocused();
  } finally {
    await app.close();
  }
});

test('valid-format IP shows the unreachable classification with a fix hint', async () => {
  const app = await launchApp();
  const page = await firstPage(app);

  try {
    await expect(page.locator('#empty-state')).toBeVisible();

    await page.locator('#ip-input').fill('192.0.2.123'); // TEST-NET-1, the stub says unreachable
    await page.locator('#check-ip-button').click();

    const feedback = page.locator('#ip-feedback');
    await expect(feedback).toContainText('Nothing answered at 192.0.2.123');
    await expect(feedback).toContainText('powered on');
    // No profile-save offer for an unreachable host.
    await expect(page.locator('#save-manual-button')).toBeHidden();
  } finally {
    await app.close();
  }
});

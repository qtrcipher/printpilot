import { expect, test, _electron as electron } from 'playwright/test';

/**
 * Electron shell smoke test (house rule: automated verification only).
 * Requires `npm run build` first — wired into the `test:e2e` script.
 */

test('app launches, Home renders, primary button has a visible focus ring', async () => {
  const app = await electron.launch({ args: ['.'] });
  const page = await app.firstWindow();

  try {
    // Window title.
    expect(await page.title()).toBe('PrintPilot');

    // Home screen content (empty state, design doc §7).
    await expect(page.locator('.home__title')).toHaveText('PrintPilot');
    await expect(page.locator('#empty-state')).toBeVisible();

    // Hard requirement: visible focus ring on interactive elements.
    // Tab moves focus to the first interactive element (the primary button)
    // and keyboard focus triggers :focus-visible.
    const scanButton = page.locator('#scan-button');
    await page.keyboard.press('Tab');
    await expect(scanButton).toBeFocused();

    const ring = await scanButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.outlineColor, width: style.outlineWidth, style: style.outlineStyle };
    });
    expect(ring.style).toBe('solid');
    expect(ring.width).toBe('2px');
    expect(ring.color).toBe('rgb(96, 165, 250)'); // --focus-ring #60A5FA
  } finally {
    await app.close();
  }
});

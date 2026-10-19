import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Press a key until a condition holds.
 *
 * Playwright synthesises key events rather than dispatching trusted OS input.
 * Under five browser projects running in parallel, WebKit intermittently
 * drops one even when the document holds focus. Retrying a couple of times
 * compensates for that harness limitation, not for product behaviour: the
 * effect is the same one a real key press has, and the assertion afterwards is
 * unchanged.
 *
 * Bounded, so a genuinely broken handler still fails rather than looping.
 */
export async function pressUntilSettled(
  page: Page,
  key: string,
  settled: () => Promise<boolean>,
  attempts = 3,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await settled()) return;
    await page.keyboard.press(key);
  }
  await expect
    .poll(settled, { timeout: 15_000, message: `pressing ${key} never settled` })
    .toBe(true);
}

/** Wait for an element to disappear. */
export async function expectGone(locator: Locator): Promise<void> {
  await expect(locator).toHaveCount(0);
}

/**
 * Wait until React has taken over the page.
 *
 * Server and client render the same markup, so typing before hydration puts
 * text in the DOM that never reaches component state. Waiting on the marker
 * avoids a sleep, and keeps the suite deterministic on slower engines.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true', { timeout: 30_000 });
}

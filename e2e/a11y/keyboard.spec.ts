import { expect, test, type Page } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * Keyboard-only operation (WCAG 2.2 AA — 2.1.1 Keyboard, 2.4.3 Focus Order).
 *
 * The lightbox is the screen this product is built around, and it declares
 * `aria-modal="true"`. That declaration is a promise: assistive technology is
 * told the rest of the page is inert, so a keyboard user who tabs forward
 * expecting to stay in the viewer will find focus somewhere else entirely if
 * the implementation does not hold the promise. Nothing catches that in an
 * automated audit -- axe sees a valid `role="dialog"` and moves on.
 *
 * So the assertion here is behavioural, not structural: press Tab, then read
 * where focus actually went.
 *
 * The second half of the file covers the two interactions a keyboard user has
 * to be able to complete without a pointer: casting a vote, and hearing that
 * the vote landed.
 */

const RANKING = '/places/guishan-island/ranking';

/** Where focus is right now, described well enough to assert on. */
async function focusDescriptor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return 'none';
    const testId = active.getAttribute('data-testid');
    if (testId !== null) return `testid:${testId}`;
    const tag = active.tagName.toLowerCase();
    if (active === document.body) return 'body';
    return `${tag}:${(active.textContent ?? '').trim().slice(0, 20)}`;
  });
}

/** Is focus inside the lightbox? */
async function focusInsideLightbox(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return false;
    return active.closest('[data-testid="lightbox"]') !== null;
  });
}

test('tabbing forward inside the viewer never leaves the viewer', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  await page.getByTestId('ranking-leader-open').click();
  await expect(page.getByTestId('lightbox')).toBeVisible();

  // Focus starts inside the dialog, so the trap has somewhere to start from.
  await expect
    .poll(() => focusInsideLightbox(page), { timeout: 15_000 })
    .toBe(true);

  // Walk forwards past every control the viewer has. The viewer has fewer
  // than a dozen focusable elements, so twelve steps is comfortably more than
  // one full cycle.
  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Tab');
    const inside = await focusInsideLightbox(page);
    if (!inside) {
      throw new Error(
        `focus escaped the viewer after ${step + 1} Tab press(es); it is now on ` +
          `${await focusDescriptor(page)}`,
      );
    }
  }
});

test('shift-tabbing backwards inside the viewer never leaves the viewer', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  await page.getByTestId('ranking-leader-open').click();
  await expect(page.getByTestId('lightbox')).toBeVisible();
  await expect
    .poll(() => focusInsideLightbox(page), { timeout: 15_000 })
    .toBe(true);

  for (let step = 0; step < 12; step += 1) {
    await page.keyboard.press('Shift+Tab');
    const inside = await focusInsideLightbox(page);
    if (!inside) {
      throw new Error(
        `focus escaped the viewer after ${step + 1} Shift+Tab press(es); it is now on ` +
          `${await focusDescriptor(page)}`,
      );
    }
  }
});

test('the viewer is reachable and operable from the keyboard alone', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  // Reach the trigger without ever using the mouse.
  const trigger = page.getByTestId('ranking-leader-open');
  await trigger.focus();
  await expect
    .poll(() => focusDescriptor(page), { timeout: 15_000 })
    .toBe('testid:ranking-leader-open');

  await page.keyboard.press('Enter');
  await expect(page.getByTestId('lightbox')).toBeVisible();
  await expect
    .poll(() => focusInsideLightbox(page), { timeout: 15_000 })
    .toBe(true);
});

test('a vote can be cast with the keyboard and is announced', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  // The leader's up-vote button.
  const list = await page.request.get('/api/places/guishan-island/photos');
  const body = (await list.json()) as { items: Array<{ id: string }> };
  const photoId = body.items[0]?.id;
  expect(photoId).toBeTruthy();

  const up = page.getByTestId(`vote-up-${photoId ?? ''}`);
  await expect(up).toBeVisible();

  const before = await up.getAttribute('aria-pressed');
  expect(before).toBe('false');

  await up.focus();
  await expect.poll(() => focusDescriptor(page), { timeout: 15_000 }).toContain('vote-up-');

  await page.keyboard.press('Enter');

  // The vote took: the button now reports itself as pressed.
  await expect
    .poll(async () => up.getAttribute('aria-pressed'), { timeout: 15_000 })
    .toBe('true');

  // And the change was announced rather than happening silently.
  const status = page.getByTestId(`vote-status-${photoId ?? ''}`);
  await expect(status).toHaveAttribute('aria-live', 'polite');
  await expect.poll(() => status.innerText(), { timeout: 15_000 }).not.toBe('');
});

test('the background page is not reachable by tabbing while the viewer is open', async ({
  page,
}) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  await page.getByTestId('ranking-leader-open').click();
  await expect(page.getByTestId('lightbox')).toBeVisible();

  // Tab far enough to walk off the end of the viewer's own controls.
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press('Tab');
  }

  // Whatever has focus, it must not be one of the page's own controls.
  const onBackground = await page.evaluate(() => {
    const active = document.activeElement;
    if (active === null) return false;
    return active.closest('.lightbox') === null && active !== document.body;
  });
  expect(onBackground).toBe(false);
});

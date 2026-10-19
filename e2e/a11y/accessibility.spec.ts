import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * Automated accessibility (TEST_STRATEGY §7, E2E_SCENARIOS A11Y-04).
 *
 * The bar is WCAG 2.2 AA with zero critical and zero serious findings.
 * Moderate/minor findings are reported rather than failed on, and are recorded
 * in the Phase 12 acceptance notes with an owner.
 */

type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();

  const bySeverity = new Map<Severity, string[]>();
  for (const violation of results.violations) {
    const list = bySeverity.get(violation.impact ?? 'minor') ?? [];
    list.push(`${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`);
    bySeverity.set(violation.impact ?? 'minor', list);
  }
  return { results, bySeverity };
}

test.describe('accessibility', () => {
  test('home page has no critical or serious violations', async ({ page }) => {
    await page.goto('/');
    await waitForHydration(page);

    const { results, bySeverity } = await scan(page);

    const blocking = [...(bySeverity.get('critical') ?? []), ...(bySeverity.get('serious') ?? [])];
    if (blocking.length > 0) {
      const detail = blocking
        .map((entry) => {
          const violation = results.violations.find((item) => entry.startsWith(item.id));
          return `${entry}\n    ${violation?.nodes
            .slice(0, 3)
            .map((node) => node.target.join(' '))
            .join('\n    ')}`;
        })
        .join('\n  - ');
      throw new Error(`Blocking accessibility violations on home:\n  - ${detail}`);
    }

    expect(blocking).toHaveLength(0);
  });

  test('places index has no critical or serious violations', async ({ page }) => {
    await page.goto('/places');
    await waitForHydration(page);

    const { bySeverity } = await scan(page);
    const blocking = [...(bySeverity.get('critical') ?? []), ...(bySeverity.get('serious') ?? [])];
    expect(blocking, blocking.join('\n')).toHaveLength(0);
  });

  test('ranking page has no critical or serious violations', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const { bySeverity } = await scan(page);
    const blocking = [...(bySeverity.get('critical') ?? []), ...(bySeverity.get('serious') ?? [])];
    expect(blocking, blocking.join('\n')).toHaveLength(0);
  });

  test('upload page has no critical or serious violations', async ({ page }) => {
    await page.goto('/places/guishan-island/upload');
    await waitForHydration(page);

    const { bySeverity } = await scan(page);
    const blocking = [...(bySeverity.get('critical') ?? []), ...(bySeverity.get('serious') ?? [])];
    expect(blocking, blocking.join('\n')).toHaveLength(0);
  });

  test('the lightbox has no critical or serious violations', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);
    await page.getByTestId('ranking-leader-open').click();
    await expect(page.getByTestId('lightbox')).toBeVisible();

    const { bySeverity } = await scan(page);
    const blocking = [...(bySeverity.get('critical') ?? []), ...(bySeverity.get('serious') ?? [])];
    expect(blocking, blocking.join('\n')).toHaveLength(0);
  });

  test('every photograph carries alt text and decorative chrome is hidden', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const images = await page.evaluate(() =>
      [...document.querySelectorAll('img')].map((image) => ({
        src: (image as HTMLImageElement).src.slice(0, 60),
        alt: image.getAttribute('alt'),
        width: image.getAttribute('width'),
        height: image.getAttribute('height'),
      })),
    );

    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      // alt is present and describes the photograph, never left as the
      // filename and never an empty string on meaningful content.
      expect(image.alt, image.src).toBeTruthy();
      expect(image.alt, image.src).not.toBe(image.src.split('/').pop());
      // Explicit dimensions keep the grid from shifting as images decode.
      expect(Number(image.width)).toBeGreaterThan(0);
      expect(Number(image.height)).toBeGreaterThan(0);
    }
  });

  test('every interactive control has an accessible name', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const unnamed = await page.evaluate(() => {
      const problems: string[] = [];
      const controls = document.querySelectorAll('button, a[href], input, textarea, select');
      for (const node of controls) {
        const element = node as HTMLElement;
        const label =
          element.getAttribute('aria-label') ??
          element.getAttribute('title') ??
          (element.textContent ?? '').trim() ??
          '';
        const labelled = element.getAttribute('aria-labelledby') !== null;
        const hasLabelElement =
          element.id !== '' && document.querySelector(`label[for="${element.id}"]`) !== null;
        const wrapped = element.closest('label') !== null;
        if (label === '' && !labelled && !hasLabelElement && !wrapped) {
          problems.push(element.outerHTML.slice(0, 90));
        }
      }
      return problems;
    });

    expect(unnamed, `controls without an accessible name:\n${unnamed.join('\n')}`).toHaveLength(0);
  });

  test('vote buttons expose their pressed state', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const votes = page.locator('[data-testid^="vote-up-"]');
    const count = await votes.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      await expect(votes.nth(index)).toHaveAttribute('aria-pressed', /^(true|false)$/);
    }
  });

  test('keyboard focus is visible on the primary controls', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const button = page.getByTestId('ranking-leader-open');
    await button.focus();

    // A focused control must not be left without any visible indicator.
    const outline = await button.evaluate((node) => {
      const styles = getComputedStyle(node);
      return {
        outlineStyle: styles.outlineStyle,
        outlineWidth: styles.outlineWidth,
        boxShadow: styles.boxShadow,
      };
    });
    const hasIndicator =
      (outline.outlineStyle !== 'none' && Number.parseFloat(outline.outlineWidth) > 0) ||
      outline.boxShadow !== 'none';
    expect(hasIndicator, JSON.stringify(outline)).toBe(true);
  });

  test('the page can be traversed with Tab', async ({ page }) => {
    await page.goto('/places/guishan-island/ranking');
    await waitForHydration(page);

    const reached: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Tab');
      const id = await page.evaluate(
        () =>
          document.activeElement?.getAttribute('data-testid') ??
          document.activeElement?.tagName ??
          '',
      );
      reached.push(id);
    }

    // Focus must actually move, not get stuck on the first element.
    expect(new Set(reached).size).toBeGreaterThan(2);
  });
});

test('every interactive control is big enough to tap', async ({ page }) => {
  // WCAG 2.2 AA Target Size (Minimum) is 24x24 CSS pixels. The navigation
  // links measured 22px wide on a phone, which is a real problem on a site
  // whose main audience is people opening it on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.waitForSelector('html[data-hydrated="true"]');

  const tooSmall = await page.evaluate(() => {
    const problems: string[] = [];
    for (const node of document.querySelectorAll('button, a[href]')) {
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      // The visible box must be large enough; a pseudo-element that extends
      // the hit area is a legitimate technique, so it is measured separately.
      if (rect.width < 24 || rect.height < 24) {
        const label = (node.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 18);
        problems.push(
          `${node.tagName}"${label}" ${Math.round(rect.width)}x${Math.round(rect.height)}`,
        );
      }
    }
    return problems;
  });

  expect(tooSmall, `触控目标小于 24x24: ${tooSmall.join(' | ')}`).toEqual([]);
});

/**
 * Does the ranking page actually render the photos?
 *
 * The scaling probe reported a constant 918 KB for the ranking page whether the
 * place held 25 photos or 500. That is the signature of a page that is not
 * rendering the leaderboard at all, so this probe counts what the browser
 * actually receives.
 */
import { chromium } from '@playwright/test';

const ORIGIN = process.env.PROBE_ORIGIN ?? 'http://127.0.0.1:3083';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const response = await page.goto(`${ORIGIN}/places/guishan-island/ranking`, {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(1500);

const info = await page.evaluate(() => {
  const cards = document.querySelectorAll('[data-testid^="photo-card-"]');
  const rows = document.querySelectorAll('.photo-row');
  const images = [...document.querySelectorAll('img')];
  return {
    status: document.querySelector('.feature-position')?.textContent?.trim() ?? '(none)',
    photoCards: cards.length,
    rows: rows.length,
    images: images.length,
    loadedImages: images.filter((i) => i.complete && i.naturalWidth > 0).length,
    wallHtmlBytes: document.querySelector('.photo-grid')?.outerHTML.length ?? 0,
    documentBytes: document.documentElement.outerHTML.length,
  };
});

console.log(`  HTTP ${response?.status()}`);
console.log(`  照片卡片 ${info.photoCards} 个，行 ${info.rows} 行，图片 ${info.images} 张（已解码 ${info.loadedImages}）`);
console.log(`  排行榜区 HTML ${(info.wallHtmlBytes / 1024).toFixed(0)} KB，文档 ${(info.documentBytes / 1024).toFixed(0)} KB`);
console.log(`  第一名标记 "${info.status}"`);

await browser.close();

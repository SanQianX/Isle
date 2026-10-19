/**
 * ISLE — performance baseline.
 *
 * Measures what a real visitor experiences: how long the page takes to show
 * something, how much it moves while loading, and how many bytes it costs.
 *
 * Numbers here are the reference the optimisation loop is judged against, so the
 * thresholds are deliberately loose -- a regression should be obvious, not
 * sensitive to a slow machine.
 */
import { chromium } from '@playwright/test';

const ORIGIN = process.env.PERF_ORIGIN ?? 'http://127.0.0.1:3080';

const PAGES = [
  { name: '首页', path: '/' },
  { name: '地点列表', path: '/places' },
  { name: '照片榜', path: '/places/guishan-island/ranking' },
  { name: '上传页', path: '/places/guishan-island/upload' },
];

/** Slow 4G, so the numbers reflect a phone on mobile data rather than a LAN. */
const NETWORK = {
  offline: false,
  downloadThroughput: (1.6 * 1024 * 1024) / 8,
  uploadThroughput: (750 * 1024) / 8,
  latency: 150,
};

async function measure(page, path) {
  const requests = [];
  const failures = [];

  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(ORIGIN)) return;
    const length = Number(response.headers()['content-length'] ?? 0);
    requests.push({
      url,
      status: response.status(),
      length,
      type: response.request().resourceType(),
    });
  });
  page.on('requestfailed', (request) => failures.push(request.url()));

  await installLcpObserver(page);
  await page.goto(`${ORIGIN}${path}`, { waitUntil: 'networkidle' });
  // Let lazy images and animations settle.
  await page.waitForTimeout(1200);

  const metrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint');
    // LCP is only readable from an observer installed before the paint; the
    // buffered entry type is not exposed to getEntriesByType.
    const lcpEntry = window.__lcp ?? { startTime: 0 };

    // Cumulative layout shift, counted the way the browser defines it.
    let cls = 0;
    for (const entry of performance.getEntriesByType('layout-shift')) {
      if (!entry.hadRecentInput) cls += entry.value;
    }

    return {
      domContentLoaded: navigation?.domContentLoadedEventEnd ?? 0,
      load: navigation?.loadEventEnd ?? 0,
      fcp: paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? 0,
      lcp: lcpEntry?.startTime ?? 0,
      cls,
      transferSize: navigation?.transferSize ?? 0,
      resources: performance.getEntriesByType('resource').length,
      domNodes: document.querySelectorAll('*').length,
      images: document.images.length,
      decodedImages: [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length,
    };
  });

  // A cancelled prefetch is the browser discarding a request it no longer
  // needs, not a broken page. It must still be reported separately so a real
  // failure is not hidden among them.
  const cancelled = failures.filter((url) => url.includes('_rsc='));
  const realFailures = failures.filter((url) => !url.includes('_rsc='));

  const totalBytes = requests.reduce((sum, request) => sum + request.length, 0);
  const imageBytes = requests
    .filter((request) => request.type === 'image')
    .reduce((sum, request) => sum + request.length, 0);

  return {
    ...metrics,
    totalBytes,
    imageBytes,
    requestCount: requests.length,
    failures: realFailures,
    cancelledPrefetches: cancelled.length,
  };
}

/**
 * Install a Largest Contentful Paint observer.
 *
 * addInitScript runs before any page script, so the observer is in place before
 * the first paint and therefore sees the real candidate.
 */
async function installLcpObserver(page) {
  await page.addInitScript(() => {
    window.__lcp = { startTime: 0 };
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last !== undefined) {
          window.__lcp = {
            startTime: last.startTime,
            size: last.size,
            element: last.element?.tagName,
          };
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {
      // Some engines do not support the entry type; the rest of the report
      // stays valid without it.
    }
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

const rows = [];
for (const target of PAGES) {
  // Warm the cache so the measurement reflects the server, not the first load.
  await page.goto(`${ORIGIN}${target.path}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  const result = await measure(page, target.path);
  rows.push({ name: target.name, path: target.path, ...result });
}

// A cold, slow-network pass: the number a real phone on mobile data sees.
const slowContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
await slowContext.setOffline(false);
const slowPage0 = await slowContext.newPage();
// CDP is the only way to throttle in Playwright; there is no context-level API.
const cdp = await slowContext.newCDPSession(slowPage0);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', NETWORK);
const slowPage = await slowContext.newPage();
const slowResult = await measure(slowPage, '/');

await browser.close();

const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const ms = (value) => `${value.toFixed(0)} ms`;

console.log('\n=== 性能基线（本地、1440x900、缓存已预热）===');
console.log(
  ['页面', 'FCP', 'LCP', 'CLS', 'DOM', '资源数', '总载荷', '图片载荷', '真失败']
    .map((h) => h.padEnd(10))
    .join(' '),
);
for (const row of rows) {
  console.log(
    [
      row.name.padEnd(10),
      ms(row.fcp).padEnd(10),
      ms(row.lcp).padEnd(10),
      row.cls.toFixed(4).padEnd(10),
      String(row.domNodes).padEnd(10),
      String(row.resources).padEnd(10),
      kb(row.totalBytes).padEnd(10),
      kb(row.imageBytes).padEnd(10),
      String(row.failures.length).padEnd(10),
    ].join(' '),
  );
}

console.log('\n=== 冷启动 + 慢网络（模拟 4G，390x844）===');
console.log(
  `  FCP ${ms(slowResult.fcp)}   LCP ${ms(slowResult.lcp)}   CLS ${slowResult.cls.toFixed(4)}`,
);
console.log(
  `  总载荷 ${kb(slowResult.totalBytes)}   资源数 ${slowResult.resources}   失败请求 ${slowResult.failures.length}`,
);
if (slowResult.failures.length > 0) {
  console.log('  失败:');
  for (const failure of slowResult.failures) console.log(`    ${failure}`);
}

// Machine-readable, so the optimisation loop can diff two runs.
const report = {
  at: new Date().toISOString(),
  origin: ORIGIN,
  pages: rows,
  slowNetwork: slowResult,
};
await (
  await import('node:fs/promises')
).writeFile('.perf-baseline.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log('\n已写入 .perf-baseline.json');

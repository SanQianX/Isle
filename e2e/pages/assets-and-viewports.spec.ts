import { expect, test, type Page, type Request } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * 静态资源与视口验收（MASTER_PLAN Phase 06「无外链图片依赖」、Phase 07 的 G-03/G-04）。
 *
 * 两条独立的结论，各自需要自己的证据：
 *   a) 所有图片都来自本站自己的 API，没有任何外链图床，页面加载也没有失败请求；
 *   b) 从 320px 到 1920px，任何路由都不产生横向滚动，也没有任何元素越过视口右边界。
 *
 * 参考原型（V4.1）用 Wikimedia 外链做样片，产品要求零外链：一旦有人为了「先跑起来」
 * 贴一个外链，访客的网络请求就会暴露给第三方，而且外链挂了页面就空白。
 * 所以这里断言的是「一张都没有」，不是「大部分是本站」。
 */

const ROUTES = [
  '/',
  '/places',
  '/places/guishan-island',
  '/places/guishan-island/ranking',
  '/places/guishan-island/upload',
  '/places/new',
];

/** G-03 的调整序列外加一档最窄的 320px 和一档平板。 */
const VIEWPORTS: ReadonlyArray<{ width: number; height: number }> = [
  { width: 320, height: 640 },
  { width: 360, height: 780 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

/**
 * 视觉回归里已有同名实现，但它是 visual.spec.ts 的局部函数、support.ts 没有导出。
 * 按本轮「只新建文件、不改既有文件」的约束，这里复制一份并登记：
 * 等 Phase 12 收口时应当把它上提到 support.ts，去掉这份重复。
 */
async function settleImages(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      // 只等视口内的图片：摄影墙把屏幕外的 tile 标成 lazy，
      // 等全部图片解码会在懒加载上永久挂起。
      const height = window.innerHeight;
      const visible = [...document.querySelectorAll('img')].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < height;
      });
      // 不要求「至少有一张」：/places/new 这类页面本来就没有图片，
      // 沿用视觉回归里那条 `visible.length > 0` 会让它们永远等不到。
      return visible.every((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0;
      });
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

type UrlHit = { where: string; url: string; origin: string };

/**
 * 收集页面里所有会发起外部请求的资源地址。
 *
 * 走 computed style 而不只是扫 HTML：背景图可以写在样式表里、由 JS 写进 style，
 * 只查 DOM 属性会漏掉它们——而漏掉的那一类恰恰是外链图床最常见的藏身处。
 */
async function collectAssetUrls(page: Page): Promise<UrlHit[]> {
  return page.evaluate(() => {
    const hits: Array<{ where: string; url: string; origin: string }> = [];

    const push = (where: string, raw: string) => {
      const value = raw.trim().replace(/^['"]|['"]$/g, '');
      if (value === '' || value.startsWith('#') || value.startsWith('data:')) return;
      hits.push({ where, url: value, origin: new URL(value, location.origin).origin });
    };

    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const tag = element.tagName.toLowerCase();
      for (const attribute of ['src', 'href', 'srcset', 'poster', 'data-src']) {
        const value = element.getAttribute(attribute);
        if (value === null) continue;
        // srcset 是逗号分隔的候选列表，逐条判定。
        for (const candidate of attribute === 'srcset' ? value.split(',') : [value]) {
          push(`${tag}[${attribute}]`, candidate.trim().split(/\s+/)[0] ?? '');
        }
      }

      const style = getComputedStyle(element);
      for (const property of [
        style.backgroundImage,
        style.borderImageSource,
        style.maskImage,
        style.listStyleImage,
      ]) {
        for (const match of property.matchAll(/url\((['"]?)([^'")]*)\1\)/g)) {
          push(`${tag}[css]`, match[2] ?? '');
        }
      }
    }

    return hits;
  });
}

/** 找出右边界越过视口的元素，并报出它是谁——只给一个数字没法定位问题。 */
async function findElementsPastViewport(page: Page): Promise<{
  limit: number;
  offenders: Array<{ label: string; right: number }>;
}> {
  return page.evaluate(() => {
    const limit = document.documentElement.clientWidth;
    const offenders: Array<{ label: string; right: number }> = [];

    const describe = (element: Element): string => {
      const classes = element.getAttribute('class');
      const text = (element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      const parent = element.parentElement;
      return [
        element.tagName.toLowerCase(),
        element.id === '' ? '' : `#${element.id}`,
        classes === null || classes.trim() === ''
          ? ''
          : `.${classes.trim().split(/\s+/).join('.')}`,
        `«${text}»`,
        `in<${parent?.tagName.toLowerCase() ?? '?'}.${(parent?.getAttribute('class') ?? '').slice(0, 20)}>`,
      ].join('');
    };

    for (const element of document.querySelectorAll('body, body *')) {
      const rect = element.getBoundingClientRect();
      // display:none 的元素量出来是 0×0，不构成横向溢出。
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right <= limit + 1) continue;
      offenders.push({ label: describe(element), right: Math.round(rect.right * 10) / 10 });
    }

    return { limit, offenders: offenders.slice(0, 10) };
  });
}

test('所有页面的图片都来自本站，没有任何外链图床', async ({ page }) => {
  for (const route of ROUTES) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} 不应该 404`).toBe(200);
    await waitForHydration(page);

    const hits = await collectAssetUrls(page);

    // 图片本身：src 与 currentSrc 都要看。currentSrc 是浏览器实际选中的候选，
    // 只查 src 的话，srcset 里藏的外链会被漏掉。
    const images = await page.evaluate(() =>
      [...document.images].flatMap((image) => [image.getAttribute('src'), image.currentSrc]),
    );
    for (const value of images) {
      if (value === null || value === '' || value.startsWith('data:')) continue;
      expect(new URL(value, page.url()).origin, `${route} 的 <img> 指向了外部来源：${value}`).toBe(
        new URL(page.url()).origin,
      );
    }

    const external = hits.filter((hit) => hit.origin !== new URL(page.url()).origin);
    expect(
      external.map((hit) => `${hit.where} → ${hit.url}`),
      `${route} 存在外链资源`,
    ).toEqual([]);

    // 原型用的是 Wikimedia 外链样片，产品明确要求零外链，所以单独点名断言一次：
    // 「没有外链」这个结论必须在有人把 Wikimedia 写回来时立刻失败，而不是靠泛化规则。
    const wikimedia = hits.filter((hit) => /wikimedia|commons\.wikimedia/i.test(hit.url));
    expect(
      wikimedia.map((hit) => hit.url),
      `${route} 引用了 Wikimedia`,
    ).toEqual([]);
  }
});

test('页面加载期间没有任何失败的网络请求', async ({ page }) => {
  for (const route of ROUTES) {
    const failures: Array<{ url: string; reason: string }> = [];
    const onFailed = (request: Request) => {
      failures.push({ url: request.url(), reason: request.failure()?.errorText ?? 'unknown' });
    };
    page.on('requestfailed', onFailed);

    try {
      await page.goto(route);
      await waitForHydration(page);
      // 等一拍让懒加载的预览图也走完，否则「0 个失败请求」可能只是还没发出去。
      await settleImages(page);
    } finally {
      page.off('requestfailed', onFailed);
    }

    // 导航离开时浏览器会取消它不再需要的请求——<Link> 的 RSC 预取、以及还没
    // 显示的预览图。同一件事在不同引擎有不同拼写：Blink/WebKit 报
    // net::ERR_ABORTED，Gecko 报 NS_BINDING_ABORTED。两种都放行。
    //
    // 只放行「被取消」这一种：同一个 URL 以 404 / 500 / DNS 失败告终，依然算失败。
    // 否则这条断言就变成了一个把所有网络错误都放行的洞。
    // 三种拼写，同一件事：WebKit 用 "Load request cancelled"，
    // Gecko 用 NS_BINDING_ABORTED，Blink 用 net::ERR_ABORTED。
    const CANCELLED = ['net::ERR_ABORTED', 'NS_BINDING_ABORTED', 'Load request cancelled'];
    const real = failures.filter(
      (failure) => !CANCELLED.some((code) => failure.reason.includes(code)),
    );
    expect(
      real.map((failure) => `${failure.url} → ${failure.reason}`),
      `${route} 有失败的网络请求`,
    ).toEqual([]);
  }
});

test('从 320px 到 1920px，任何路由都不产生横向滚动', async ({ page }) => {
  // 36 次导航，给足时间；默认 90 秒在慢机器上不够用。
  test.setTimeout(180_000);

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    for (const route of ROUTES) {
      await page.goto(route);
      await waitForHydration(page);
      await settleLayout(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} 在 ${width}px 有 ${overflow}px 横向滚动`).toBeLessThanOrEqual(0);
    }
  }
});

test('任何宽度下都没有元素越过视口右边界', async ({ page }) => {
  test.setTimeout(180_000);

  // 只跑三个「有内容」的路由：表单页和地点列表的右边界由 scrollWidth 那条用例覆盖，
  // 这里要在元素粒度上多花一次往返，控制在最有代表性的页面上。
  const routes = ['/', '/places', '/places/guishan-island/ranking'];

  for (const { width, height } of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    for (const route of routes) {
      await page.goto(route);
      await waitForHydration(page);
      // Let the resize settle before measuring. Sampling straight after the
      // navigation reads the previous viewport's layout on the slower engines,
      // which reports phantom overflow that does not exist.
      await settleLayout(page);

      const { limit, offenders } = await findElementsPastViewport(page);
      expect(
        offenders.map((item) => `${item.label} right=${item.right} (视口 ${limit})`),
        `${route} 在 ${width}px 有元素越过右边界`,
      ).toEqual([]);
    }
  }
});

/**
 * Wait until the viewport change has actually been laid out.
 *
 * Two animation frames is the minimum for a resize to be reflected in
 * getBoundingClientRect on every engine; Firefox and WebKit need it, Chromium
 * does not.
 */
async function settleLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

test('320px 下摄影墙是单列，每张照片保持自身比例且不被裁切', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });

  for (const route of ['/', '/places/guishan-island/ranking']) {
    await page.goto(route);
    await waitForHydration(page);
    await settleImages(page);

    const rows = page.getByTestId('photo-wall').locator('.photo-row');
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(0);

    // G-04：窄屏必须是单列。多于一列就会把竖图挤成 unusable 的碎小卡片，
    // 这正是这条验收项要挡住的情况。
    const cardsPerRow = await rows.evaluateAll((nodes) =>
      nodes.map((row) => row.querySelectorAll('.photo-card').length),
    );
    expect(
      cardsPerRow,
      `${route} 在 320px 下不是单列：每行 [${cardsPerRow.join(', ')}] 张`,
    ).toEqual(cardsPerRow.map(() => 1));

    const measurements = await page
      .getByTestId('photo-wall')
      .locator('.photo-card')
      .evaluateAll((cards) =>
        cards.map((card) => {
          const image = card.querySelector('img') as HTMLImageElement | null;
          const frame = card.querySelector('.photo-tap') as HTMLElement | null;
          if (image === null || frame === null) return null;
          const box = image.getBoundingClientRect();
          const frameBox = frame.getBoundingClientRect();
          const declaredWidth = Number(image.getAttribute('width'));
          const declaredHeight = Number(image.getAttribute('height'));
          const decoded =
            image.complete && image.naturalWidth > 0 ? image.naturalWidth / image.naturalHeight : 0;
          return {
            declaredRatio: declaredHeight > 0 ? declaredWidth / declaredHeight : 0,
            decodedRatio: decoded,
            renderedRatio: box.height > 0 ? box.width / box.height : 0,
            renderedWidth: box.width,
            frameWidth: frameBox.width,
          };
        }),
      );

    expect(measurements.length).toBeGreaterThan(0);
    for (const measurement of measurements) {
      expect(measurement, 'tile 缺少图片或点击层').not.toBeNull();
      if (measurement === null) continue;

      // 渲染框的比例必须等于照片自身的比例：等于就意味着 object-fit 没有可裁剪的余量，
      // 照片是整张显示的，不会被裁边也不会被拉变形。
      expect(measurement.declaredRatio).toBeGreaterThan(0);
      expect(
        Math.abs(measurement.renderedRatio - measurement.declaredRatio),
        '渲染框的比例与照片自身比例不一致',
      ).toBeLessThan(0.01);

      // 解码后的真实比例要等于落库比例，顺带把 EXIF 方向的显示正确性也钉住。
      if (measurement.decodedRatio > 0) {
        expect(
          Math.abs(measurement.decodedRatio - measurement.declaredRatio),
          '解码后的图片比例与落库尺寸不一致（EXIF 方向可能没生效）',
        ).toBeLessThan(0.001);
      }

      expect(
        Math.abs(measurement.renderedWidth - measurement.frameWidth),
        '图片宽于它的容器，说明被横向裁切了',
      ).toBeLessThanOrEqual(1);
    }
  }
});

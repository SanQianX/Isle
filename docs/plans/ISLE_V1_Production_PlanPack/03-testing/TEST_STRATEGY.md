# 全栈自动化测试战略 — 必须包含 Playwright 模拟真实 UI 操作

## 0. 硬性判定

**按钮能点击、页面有样式并不代表功能通过。** 必须分别证明：
1. 用户**在浏览器界面**触发行为；
2. Next API 真正收到请求并返回正确状态；
3. SQLite 数据和磁盘文件按预期改变；
4. 刷新、重开浏览器、服务重启后仍保持正确；
5. 不同浏览器上下文、手机/桌面和失败路径均符合预期。

本计划中的 **`test:e2e` 不允许 Mock API**，不能仅拦截 `page.route('/api/...')` 返回假数据来假装 E2E 成功。Mock 只允许在组件单元测试或网络异常注入场景中，异常场景须明确注明“故障模拟”。

## 1. 测试分层与运行时机

| 层 | 工具/对象 | 目的 | 执行频率 |
|---|---|---|---|
| 静态质量 | ESLint、TypeScript strict、`npm audit --omit=dev` | 早发现未定义/无效依赖/风险 | 每 Commit + CI |
| Unit | Vitest，纯业务/算法 | 票数状态机、排序、校验、画廊动态规划 | 每 Phase |
| Component | RTL + Vitest + 必要的 Mock Server | Button/Upload/Lightbox 的局部无障碍状态 | 每前端 Phase |
| DB/API Integration | Vitest + 真实 SQLite + 临时磁盘 | 唯一约束、事务、路由请求、上传、恢复 | 后端 Phase 后 |
| E2E desktop | Playwright Chromium/Firefox/WebKit | 真实浏览器链路 | 核心完成 + CI |
| E2E mobile | Playwright mobile Chrome / iPhone WebKit 模拟 | 触摸/响应式/文件选择/灯箱 | 核心完成 + CI |
| Visual regression | Playwright screenshot comparator | 视觉不退化、不乱版 | UI Gate + CI |
| Performance | Lighthouse CI 或同等真实测量 | 首页加载与原图按需 | Release Gate |
| Security/abuse | API 边界 + 浏览器脚本 + 依赖审计 | 上传、XSS、CSRF、风控和权限 | Release Gate |
| Staging smoke | Playwright 对真实 staging + Nginx | 反代/TLS/磁盘/服务重启端到端 | 发布前后 |

### 强制实现的 package scripts

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "node scripts/run-e2e-isolated.mjs",
    "test:e2e:chromium": "node scripts/run-e2e-isolated.mjs --project=chromium",
    "test:visual": "node scripts/run-e2e-isolated.mjs --grep=@visual",
    "check:all": "npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm run test:e2e && npm run test:visual"
  }
}
```

以上命令是**交付后应存在的脚本名称与行为约定**，并非现成可执行代码；MiniMax 需要实现 scripts/ 文件、测试目录和环境初始化，保证 exit code 非零会使流水线失败。

## 2. 真实 E2E 隔离环境（不得修改生产数据）

每次本地/CI `test:e2e` 创建唯一临时目录：

```text
<system temp>/isle-e2e-<run-id>/
  db/test.db
  media/original/
  media/preview/
  tmp/
  artifacts/
```

`run-e2e-isolated` 必须：

1. 验证 `NODE_ENV !== production` 不能作为唯一区分；以显式 `ISLE_E2E=1` 和 temp 安全路径双重保护；拒绝连接 `/var/lib/isle/` 等生产位置。
2. 创建独立数据库与存储目录，设置 `DATABASE_URL`、`MEDIA_ROOT`、`UPLOAD_TMP_DIR`、`NEXT_PUBLIC_SITE_URL`、`ISLE_E2E`。
3. 运行 `prisma migrate deploy` + **测试数据 fixture seed（只写隔离库）**，启动 `next start` 或 standalone **生产构建模式**（不只 `next dev`）；Playwright webServer 等待真实 `/api/health`。
4. 使用一个可配置且防冲突的 127.0.0.1 端口；遇已有未知进程不能错误连接真实服务器。
5. 自动运行 Playwright；保留失败的 trace/video/screenshot/report 到 `test-results/`；最后温和终止子进程并清除仅该次临时目录。失败时允许保存隔离数据用于调试。
6. 如果 Phase 内只跑子集，允许命令过滤测试，但最终 Gate 必须全量运行。

**禁止**通过 `prisma migrate reset` 接到项目默认开发/生产 DB 或在用户真实上传目录运行清理。

### Playwright 项目配置建议

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3017',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: {
    command: 'npm run start:test',
    url: `${process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3017'}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
```

- `start:test` 脚本和隔离 env 必须真实实现；webServer 由测试 harness 传递 env，不能运行未经授权的公网站点。
- 使用 Playwright `context` 隔离 cookie，不同 `browser.newContext()` 可模拟不同朋友；**不是**两张共享相同 storageState 的页签就代表两个不同用户。
- E2E 后端以真实 DB 和真实 media 为准；测试可用 seed CLI 安装测试照片，但上传/投票核心用例必须从 UI 触发。

## 3. 测试 Fixture 标准

准备并提交许可合规、稳定的静态测试媒体：

| Fixture | 示例尺寸 | 用途 |
|---|---|---|
| `landscape.jpg` | 1600×900 | 横图 / JPEG / 排名 |
| `portrait.jpg` | 900×1600 | 竖图 / Justified |
| `square.png` | 1000×1000 | 方图 / PNG |
| `extreme-wide.webp` | 2400×480 | 超宽 / 最后一行 |
| `extreme-tall.jpg` | 480×2400 | 超高 / 最小 tile 宽度 |
| `exif-rotate.jpg` | 1200×1600 metadata Orientation=6 | 方向宽高 |
| `small.jpeg` | 80×80 | 不应无意义放大 |
| `invalid-text.jpg` | 内含纯文本 | 假 MIME/魔术字节 |
| `corrupt.jpg` | 截断 JPEG | 解码失败 |
| `too-large.jpg` | >25MiB | 413 大文件 |
| `gps-exif.jpg` | 真 EXIF GPS | 原件 GPS保留、派生图不含 GPS、上传提醒 |

可通过脚本 `scripts/generate-test-fixtures.ts` 生成尺寸素材，测试预览使用获许可的真实图片满足审美回归；所有 fixture 必须有稳定大小/sha/说明，且不能下载外站不可控的动态文件作为断言。

## 4. 单元/集成覆盖要求

### Unit（预期高覆盖度的核心函数）

- `score()`, `voteTransitions()`, `rankingComparator()`: 全部状态表和 tie-breaker。
- `bestPhotoRows()`: 0/1/2/3/4/20/100 张，各比例、极端宽高、容器 320/768/1440，属性测试顺序与无溢出。
- `validateFile()`, `normalizePlaceName()`, `safeFilename()`, `buildStorageKey()`：非法格式、长度、重名、路径注入。
- `imageMetadata`: EXIF Orientation 后宽高处理；错误图片不误判；hash 逐块输出与直接计算一致。

建议关键业务服务+布局算法覆盖率 statements/branches ≥85%，但**覆盖率指标不能替代边界测试**。

### DB + API Integration

- migration from empty DB、seed 幂等，SQLite WAL/busy_timeout/foreign key 正常；迁移后升级保留数据。
- Cookie 首次签发、重用、伪造/篡改处理、安全属性；CSRF Origin 错误被拒。
- 创建地点正常/重复/字段越界/SQL 注入字符串按纯文本处理；跨 session 一致。
- 图片写入/派生/读取/下载/206 Range/304 ETag/失败清理/回收脚本，原图 SHA 一致。
- Vote `(photoId,visitorId)` unique、幂等、并发 20 次写入分数不虚增；不同人分数一致。
- 每一个 400/404/409/413/415/422/429/503 场景**至少有一条对应集成测试**，不存在吞异常统一返回 200。

## 5. 端到端(UI) 与断言设计

**关键完整链路必须至少有以下顺序**：

`打开桂山岛 → 查榜单 → 点赞 → 再点撤销 → 改投反对 → 点图看原图 → 切下一张 → 下载 → 关闭 → 去上传页选 3 张 → 提交 → 回榜单 → 刷新 → 第二个 browserContext 打开榜单发现新照片 → 第二个访客投票 → 首个访客观察榜单更新 → 重启服务后再次检查持久化`。

这不是说必须写一个超长、易碎的单测试；最好拆成多个可独立重复的用例（`E2E_SCENARIOS.md`），再有一个 5–10 分钟内完成的跨功能 happy-path smoke。

UI 断言须优先使用 `getByRole/getByLabel/getByText`；对于 gallery photo、rank、vote 给出稳定 `data-testid`（如 `photo-card-<id>` 和 `photo-score-<id>`），但不可用 testid 代替 accessible role 和 name。

真实 UI 操作示例（由 MiniMax 按实际组件的无障碍名称补齐）：

```ts
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

// @smoke: 使用真实 API、真实 SQLite、真实磁盘；不得 page.route() mock 数据。
test('UI 多图上传并跨访客可见 @smoke', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();
  const a = await alice.newPage();
  const b = await bob.newPage();
  await a.goto('/places/guishan-island/upload');
  await a.locator('input[type="file"]').setInputFiles([
    resolve('tests/fixtures/landscape.jpg'),
    resolve('tests/fixtures/portrait.jpg'),
    resolve('tests/fixtures/square.png'),
  ]);
  await a.getByLabel('照片说明').fill('海岛旅行');
  await a.getByLabel(/原图.*下载/).check();
  await a.getByRole('button', { name: /分享这些照片|开始上传/ }).click();
  await expect(a.getByText(/3 张成功/)).toBeVisible();
  await b.goto('/places/guishan-island/ranking');
  await expect(b.getByText('海岛旅行')).toHaveCount(3);
  await alice.close();
  await bob.close();
});
```

此片段表达**实际用户路径**，非已存在的测试代码；上传结果 UI/路径/标签须在实际实现后固定，并同步需求和测试。测试数据需每 test 自己建隔离 fixture / 唯一描述，避免先前 seed 引起 `toHaveCount(3)` 误判。

### 票数 API + DB 的强校验示例

- UI 点赞后从浏览器看到 `+1`，**同时用隔离测试 DB 连接或内部只用于测试的校验辅助函数**确认 Vote 表唯一约束及 `value=1`。
- UI 同按钮再次点→Vote 行数 0、score 归零；UI 切换到反对→Vote 值 -1。
- 两个 Context A/B：A 赞成、B 反对，总分 0；二者 UI 选中态不同；刷新仍然正确；同一上下文同时点击两次不造成累计 +2。

### 原图一致性校验示例

在 E2E UI 上传某个 fixture 成功后，打开该图灯箱，确认实际请求 **`/original`**，再通过 Playwright 的认证上下文或公开原图 URL 读取响应 bytes；Node.js `createHash('sha256')` 比较 uploaded fixture 和 GET body hash，且检查 `Content-Length`。同时至少有一个实测 `.png` 保持 PNG MIME，绝不被悄悄转成 WebP。

## 6. 视觉回归

### 必须保存的 baseline

| ID | 画面 | 宽度/设备 | 要求 |
|---|---|---|---|
| VR-01 | 首页 hero + NO.01 | 1440×900 | 地点和图为主，照片完整 |
| VR-02 | 地点列表 2 地点 | 1440×900 | 不像后台卡片 |
| VR-03 | 横竖横 Justified row | 1440×900 | 共线等高、无裁切、不留大洞 |
| VR-04 | 完整照片榜 20 张 | 1440×900 | 多行节奏协调、排名有序 |
| VR-05 | 原图灯箱 | 1440×900 | 深色/沉浸/控件不压照片 |
| VR-06 | 上传页选择 3 张 | 1440×900 | 原比例预览与输入清楚 |
| VR-07 | 首页 | 390×844 | 无横向滚动 |
| VR-08 | 排行榜 | 390×844 | 单列、触控按钮可见 |
| VR-09 | 灯箱 | iPhone 13 WebKit | 控件/底部 safe area 正常 |
| VR-10 | 冷雾灰背景对比 | 1440×900 | 所有设计 token 一致 |
| VR-11 | 空地点榜 | 390×844 | 不出现假图片 |
| VR-12 | 上传失败态 | 390×844 | 错误可见且可恢复 |

测试截图前：
- 使用确定的测试 fixture 和冻结时间/排序；待图片 `decode()` 完成且 CSS font ready；禁动画 `animations:'disabled'`；避免网络外链、不使用固定毫秒 sleep。
- 首次 visual baseline 需人工审核；不能为了过 CI 自动更新 snapshot。尽可能在同一 Linux CI 环境进行截图。
- 维护 screenshot diff（expected / actual / diff）供负责人审查；容差以少量真实反锯齿差异为准，不能上调到掩盖布局错误。

## 7. 可访问性 + 设备行为

- Playwright axe 检查 P0 页面无 critical/serious 违反项，至少 WCAG 2.2 AA 对比度与交互目标。
- 键盘 Tab 遍历所有按钮；可见焦点；↑/↓ `aria-pressed` 正确；灯箱 Esc + ←/→ + 焦点恢复。
- 手机上模拟 `tap` / `touchscreen` / swipe，测试灯箱滑动、滚动锁与恢复；不靠单纯 CSS viewport 截图来冒充实际触屏测试。
- WebKit 兼容原图格式和移动上传路径，iPhone real-device 手工 smoke 另列记录（Playwright WebKit 模拟不能替代真机全部差异）。

## 8. 性能、异常、负载（按规模适度）

- 主页常规 4G 模拟目标 p75 LCP ≤2.5s、CLS ≤0.1，首先以真实 Lighthouse 测量报告为准；若高分辨率风景素材使目标不现实，应优化首屏 1200 缩略图/预取策略，不对原件压缩。
- 上榜 100 张照片时首屏不能同步拉 100 张原始文件；列表使用 400/1200 previews，离屏 lazy load；原图仅进入灯箱加载。
- CPU、RSS、SQLite 锁等待、上传高水位测量；20 个并发投票与 2 个并发 25 MiB 上传维持完整性，无 crash/OOM。
- 慢网络/断网：UI 显示 loading、单文件重试、图片错误、投票失败撤销乐观状态；服务重启/容器（无容器部署）重启后的健康与恢复。
- `npm audit` 的高危/严重生产依赖阻断发版，例外必须有清楚风险接受记录。

## 9. CI / 报告与失败机制

GitHub Actions Linux（无需 Docker）：

```text
Checkout → Node 22 + npm ci
→ npm run lint / npm run typecheck
→ npm run test:unit
→ npm run test:integration (isolated sqlite/media)
→ npm run build
→ npx playwright install --with-deps chromium firefox webkit
→ npm run test:e2e (all project variants)
→ npm run test:visual
→ npm audit --omit=dev
→ 上传 playwright-report / test-results / coverage / screenshots
```

- Pull request 任何 P0 功能失败 → 不允许合并或发布。
- Playwright 失败**自动归档 trace**，报告包含步骤、截图、视频（失败时）、环境、Commit hash。
- 测试可以针对 CI 性能进行 shard，但最终必须有整套结果；禁止只在 Chromium 跑过就声称“三浏览器通过”。
- 如果找不到 Google Chrome/Playwright browser、系统缺 libc/sharp，明示 blocked + 安装命令和缺失证据，不可虚报通过。

## 10. Staging/生产验证区分

`staging-smoke` 在隔离 staging 媒体/数据库下运行 UI 创建/上传/投票/灯箱/下载，不能连接生产真实地点并制造测试垃圾。

生产 smoke **只做不破坏数据的检查**：HTTPS、首页、已有榜单、原图 HEAD、health、静态资源、权限、防护，允许通过管理员人工在生产测试一个明确带标签且可通过 CLI 下架的测试作品，但须显式批准。

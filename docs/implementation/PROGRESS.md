# ISLE V1.0 — 实施进度

> 记录格式：**事实 + 命令 + 成功数量 + Commit hash + 残留**。
> 禁止写「测试通过」而无实际执行记录。状态枚举：`PENDING / IN_PROGRESS / PASSED / BLOCKED`。

---

## Phase 00 — 仓库/环境审计

**状态**：PASSED
**提交**：见本文件末尾 Git 日志（Phase 00 commit）
**改动**：新建 `docs/implementation/BASELINE_AUDIT.md`、`DECISIONS.md`、`PROGRESS.md`；`git init -b main`；新建 `.gitignore`
**执行过的命令**：
```bash
cd "D:/SanQian.Xu/Server Project"
git status                                            # → fatal: not a git repository
git init -b main                                      # → Initialized empty Git repository
sha256sum -c docs/plans/ISLE_V1_Production_PlanPack/SHA256SUMS.txt   # → 18 OK / 0 FAILED
grep -c "localStorage" .../V4.1_REFERENCE_ONLY.html                  # → 3
grep -o "URL.createObjectURL" ... | wc -l                            # → 2
grep -o "fetch(\|XMLHttpRequest\|axios\|/api/" ... | uniq -c         # → (空)
grep -o 'href="#/[a-z]*"' ... | sort | uniq -c                       # → 5 类 hash 路由, 15 处
grep -o "https\?://[a-zA-Z0-9./-]*" ... | uniq -c                   # → upload.wikimedia.org ×2, commons.wikimedia.org ×2
node -v    # → v24.13.0
npm -v     # → 11.6.2
npm view next@15 version        # → 15.5.28 (registry 可达)
npx playwright --version         # → 报错，未安装
curl -sI https://cdn.playwright.dev/…  # → HTTP/1.1 307 (可达)
curl -sI https://github.com            # → HTTP/1.1 200 OK
find . -name "*.db" -o -name ".env" -o -name "node_modules"    # → (空)
```
**测试**：不适用（审计阶段，不改业务代码）。Plan Pack 完整性校验 **18/18 OK**。
**实际可验证的功能**：无业务功能。产出：现状对照表、6 条风险登记（R-01..R-06）、12 条 ADR。
**核心审计结论**：
- 仓库为**空仓库 greenfield**，无任何既有业务代码/数据库/图片/凭据 → 实施路径为「新建」，无迁移风险。
- V4.1 经独立复核确认为**单文件 hash 路由静态原型**，**零** `fetch`/`XHR`/`/api/`；访客与投票在 `localStorage`；上传图仅 `URL.createObjectURL()`。**不构成任何后端实现。**
- `bestPhotoRows()` 为**动态规划**（gap 22 / target 335 / max 440 / min 220 / ≤5 张 / 6 条惩罚项），按下标顺序切分，**不重排**——Phase 07 须原样迁移并加不变量测试。
**风险/问题**：
- R-01 本机 Node **24.13.0**，非要求的 22 LTS，且无版本管理器可切换 → ADR-001，CI/systemd 锁 22，本地差异显式标注，不跳过测试。
- R-02 开发机 **Windows**，无法执行 nginx/systemd/Linux ABI 演练 → Phase 11 只交付发布包，标 `NOT_RUN`。
- R-03 Playwright 未安装（约 1 GB 下载）→ Phase 01 安装，失败则记阻塞证据，禁用 mock 顶替。
- R-06 无服务器/域名/证书权限 → 最终上线状态只能是 `READY_NOT_DEPLOYED`。
**下一 Phase**：01

---

## Phase 01 — 可复现工程与 CI 骨架

**状态**：PASSED
**改动**：新建 `package.json`（锁定版本 + `overrides`）、`package-lock.json`、`next.config.ts`（`output:'standalone'`）、`tsconfig.json`（strict + `noUncheckedIndexedAccess`）、`eslint.config.mjs`（flat + `no-explicit-any` error）、`postcss.config.mjs`、`.prettierrc.json`、`.prettierignore`、`.env.example`、`src/lib/config.ts`（Zod 启动校验）、`src/lib/errors.ts`（类型化 API 错误）、`src/app/api/health/route.ts`（真实存储探针）、`src/app/layout.tsx`、`src/app/page.tsx`、`src/app/globals.css`（V4.1 设计 token）、`vitest.config.ts`、`playwright.config.ts`（5 项目）、`tests/setup.ts`（生产路径拒绝守卫）、`scripts/start-test-server.mjs`（standalone 启动器）、`scripts/run-e2e-isolated.mjs`（隔离 E2E 编排）、`.github/workflows/ci.yml`、`e2e/smoke/health.spec.ts`、`tests/unit/{config,errors}.test.ts`
**执行过的命令**：
```bash
npm install --no-audit --no-fund
npm audit --omit=dev --registry=https://registry.npmjs.org   # 初次: 6 漏洞 / 5 high
npm install -D sharp@0.35.5 vitest@4.1.12                    # 升级后逐项复验 sharp/webp/prisma CLI
npx playwright install chromium firefox webkit              # 三引擎下载完成 (chromium-1223, firefox-1555, webkit-2370)
npx vitest run tests/unit            # → 32 passed (2 files)
npx tsc --noEmit                     # → exit 0
npx eslint .                         # → exit 0
npx prettier --write && --check      # → All matched files use Prettier code style!
npm ci --dry-run                     # → up to date（lockfile 与 package.json 同步）
DATABASE_URL=… MEDIA_ROOT=… UPLOAD_TMP_DIR=… npm run build    # → exit 0, Next.js 15.5.28
npm run test:e2e -- --project=chromium   # → 4 passed
npm run test:e2e                       # → 20 passed (chromium/firefox/webkit/mobile-chrome/mobile-webkit)
npm audit --omit=dev --registry=https://registry.npmjs.org   # → found 0 vulnerabilities
```
**测试**：单元 **32 通过 / 0 失败 / 0 跳过**；E2E **20 通过 / 0 失败 / 0 跳过**（5 浏览器项目 × 4 用例）；lint / typecheck / format / build 全部 exit 0。
报告路径：`playwright-report/index.html`、`test-results/e2e-results.json`
**实际可验证的功能**：
- `GET /api/health` → 200 `{status:"ok"}`，对 `original/`、`preview/`、`tmp/` 三个目录做**真实写探针**（写文件再删），任一失败返回 503；响应体经测试断言不含绝对路径、不含 `file:`、不含 Windows 盘符。
- `next build` 产出 `.next/standalone`，E2E 通过 `node .next/standalone/server.js` 启动——**与 Phase 11 systemd 部署路径完全一致**（`next start` 在 standalone 模式下会被 Next 拒绝，故不用）。
- `run-e2e-isolated.mjs` 每次创建 `<OS temp>/isle-e2e-<pid>-<rand>/`（db/media/tmp/artifacts），设 `ISLE_E2E=1`，跑完自动删除（实测残留目录数 = 0）；端口被占用时**拒绝复用未知进程**并退出非零。
- `start-test-server.mjs` 缺少 `ISLE_E2E=1` 或 `NODE_ENV≠production` 时拒绝启动，防止误连真实部署。
**风险/问题**：
- 生产依赖审计 **0 漏洞**。过程中发现并修复：sharp 0.34.5 的 libvips/libheif/librsvg 5 项 high → 升 0.35.5；vitest 3 的 tinypool **critical RCE** → 升 4.1.12（依赖表已无 tinypool）；next 内锁 postcss 8.4.31 与 prisma 内锁 deepmerge-ts 7.1.5 → 用 `overrides` 强制 8.5.30 / 8.0.2（保住 Next 15.5.28 与 Prisma 6.x 既定基线，实测 `prisma --version` 与构建均正常）。
- **已接受风险**：全量 audit 仍有 5 high，全部在 dev-only lint 工具链（`eslint-config-next`、`@next/eslint-plugin-next`、`braces`、`fast-glob`、`micromatch`），其中后三项公告 `range` 为 `*` 即上游无修复版本。这些不进入发布产物，输入面为自有源码。详见 **ADR-013**，含复核命令与解除条件。
- 本机 registry 为 `registry.npmmirror.com`，该镜像未实现 audit 接口，审计命令须显式加 `--registry=https://registry.npmjs.org`。
- `eslint@9.39.5` 被 npm 标记 deprecated，但 `eslint-config-next@15.5.28` peer 限定 `<10`，升级 eslint 10 会破坏约束；lint 为开发期工具，不随产品发布。
- 视觉回归基线在 Linux CI 生成；本地 Windows 写入 `e2e/__screenshots__/local/` 独立目录以免污染基线（ADR-007）。Phase 01 尚无视觉用例。
**下一 Phase**：02

---

## Phase 02 — 数据模型、迁移、服务端访客身份和地点

**状态**：PENDING
**下一 Phase**：03


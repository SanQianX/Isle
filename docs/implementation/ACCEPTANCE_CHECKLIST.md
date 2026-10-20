# ISLE V1.0 — 验收清单（实测记录）

> 生成于 Phase 12。每条都标注**实际执行过的命令**与**结果**。
> 没有真实执行的一律写 `NOT_RUN`，不写「应该可以」。

## 0. 环境事实

| 项 | 值 |
|---|---|
| 开发机 | Windows，`node v24.13.0`（生产基线为 Node 22，见 ADR-001） |
| Next / React | 15.5.28 / 19.1.10 |
| Prisma / Playwright / Vitest | 6.19.3 / 1.64.1 / 4.1.12 |
| `npm audit --omit=dev` | **0 vulnerabilities** |
| Git | 43 commits，main 分支，工作区干净 |

## 1. 工程/仓库

| ID | 状态 | 证据 |
|---|---|---|
| A-01 | **PASS** | `docs/implementation/BASELINE_AUDIT.md`；18/18 参考文件 SHA256 校验通过；V4.1 原型经独立复核确认为零 `fetch`/`XHR`/`/api/` 的 hash 路由静态原型 |
| A-02 | **PASS（Node 版本有差异）** | `package.json` 锁定 next 15.5.28 / prisma 6.19.3 + `package-lock.json`；`npm ci` 通过。生产/CI 锁 Node 22，本地 24.13.0（ADR-001） |
| A-03 | **PASS** | `npx eslint .` → 0；`npx tsc --noEmit` → 0；`npx prettier --check` → 全部通过；`npm run build` → exit 0 |
| A-04 | **PASS** | `.gitignore` 排除 `*.db` / `media/` / `.env*` / `test-results/`；`git ls-files` 无任何 `.db`、`.env`、上传物或 visitor token |
| A-05 | **PASS** | Phase 00–12 各有独立 commit（15 个），见 §7 |

## 2. 产品功能

| ID | 状态 | 证据 |
|---|---|---|
| F-01 | **PASS** | `GET /api/places` 断言含 `guishan-island`；创建后另一访客立即可见；重名 409（E2E `visitor-and-places.spec.ts`） |
| F-02 | **PASS** | E2E：cookie `HttpOnly`/`SameSite=Lax`/`Path=/`；重放身份不变；新 context 身份不同；篡改 cookie 被当作不存在。DB 仅存 SHA-256 |
| F-03 | **PASS** | E2E `upload-flow.spec.ts`：3 张一次上传 → 榜单 3 条；移除 1 张只传 2 张；追加选择为 3 张；超大文件**在选择时即拒绝**，不发送任何字节 |
| F-04 | **PASS** | 状态机 9 种组合单测；E2E 上/再上撤销/下/再上 = +1,0,-2,+2；20 并发同向点击后 DB 恰好 1 行、score 恰好 +1 |
| F-05 | **PASS** | `tests/unit/ranking.test.ts` 逐条钉死四级排序键 + 反序输入结果一致 + 不修改入数组 |
| F-06 | **PASS** | 七个路由直接访问均 200；1440/1920/768/390/360 五档 × 六路由无横向溢出 |
| F-07 | **PASS** | `tests/unit/best-photo-rows.test.ts` 20 项：同行等高、每张宽度严格等于真实比例（误差 <1e-6）、行宽 ≤ 容器+1px、顺序不变；E2E 在真实浏览器逐张核对渲染比例与 `naturalWidth/naturalHeight` |
| F-08 | **PASS** | E2E `lightbox.spec.ts` 13 项：加载 `/original`、1:1 收敛到 `naturalWidth/dpr`、上下张与榜单顺序一致、文件信息含真实尺寸/格式/体积、下载可用 |
| F-09 | **PASS** | `SHA256(上传) == DB.originalSha256 == 磁盘文件 == GET /original body == GET /download body`，集成 + E2E 双层断言，`Buffer.equals` 逐字节比对 |
| F-10 | **PASS** | 刷新保持；`?photo=` 深链另开 context 可达；浏览器后退关闭灯箱而非离开页面 |

## 3. 后端/持久化/安全

| ID | 状态 | 证据 |
|---|---|---|
| B-01 | **PASS** | 两个迁移已提交；`prisma migrate deploy` 从空库建库；`prisma migrate dev` 无漂移 |
| B-02 | **PASS** | `Vote` 复合主键 `(photoId, visitorId)`；20 并发写入后 0 或 1 行；两个不同访客并发聚合与表内容一致 |
| B-03 | **PASS** | 原件与预览分目录存储；灯箱 `<img src>` 断言匹配 `/original$` 且**不含 `/preview/`**；`next.config` 设 `images.unoptimized` |
| B-04 | **PASS** | 伪装 txt→415、截断 JPEG→拒绝、SVG→415、声明类型与字节不符→415、超像素→422、>25 MiB→413；每条都断言 DB 无半成品记录 |
| B-05 | **PASS** | 强制 DB 插入失败（外键）后断言三个 key 均不存在、临时目录为空；Windows EPERM 场景已覆盖 |
| B-06 | **PASS** | 跨域 POST/PUT → 403 且数据不变；投票/上传/建地点超限 → 429 + `Retry-After`；全部响应 `Cache-Control: private, no-store` |
| B-07 | **PASS** | `gps-exif.jpg` 原件保留 EXIF、两张预览 `exif === undefined`；上传页有必须勾选的隐私告知，未勾选提交按钮 disabled |
| B-08 | **PASS** | 全站无注册/评论/地图/搜索/后台 UI；下架走 `scripts/moderate-photo.mjs` CLI |

## 4. 自动化测试

| ID | 状态 | 证据 |
|---|---|---|
| T-01 | **PASS** | `npx vitest run tests/unit` → **156 passed / 9 files** |
| T-02 | **PASS** | `npx vitest run tests/integration` → **149 passed / 10 files** |
| T-03 | **PASS** | `scripts/run-e2e-isolated.mjs` 建独立 DB + 媒体目录，跑真实迁移与种子，启动 `.next/standalone/server.js`（与 systemd 同一产物） |
| T-04 | **PASS** | Chromium：**五项目合跑 675 条用例全部通过** |
| T-05 | **PASS** | Firefox：同上（含 4 条 CDP 限速进度用例仅 Chromium 跑，已注明理由） |
| T-06 | **PASS** | WebKit：同上 |
| T-07 | **PASS** | mobile-chrome：同上 |
| T-08 | **PASS** | mobile-webkit：同上 |
| T-09 | **PASS** | `upload-flow.spec.ts`：真实 multipart → 榜单可见 → 另一访客可见；上传后字节一致性 |
| T-10 | **PASS** | `voting.spec.ts` 9 项 + 集成 22 项，含 20 并发 |
| T-11 | **PASS** | 原图字节、下载、EXIF 方向（Orientation=6 落库为 1600×1200） |
| T-12 | **PASS** | `npm run test:visual` → **55 passed**（11 张基线 × 5 浏览器），**Linux 权威基线已生成、目视审查并入库**（`e2e/__screenshots__/<project>/`，55 张，见 `docs/visual-baselines/APPROVED.md`）；本地 Windows 副本仍写入 gitignore 的 `local/` 目录，两套互不污染（ADR-007）；本地基线目录已 gitignore |
| T-13 | **PASS** | axe-core（WCAG 2.2 AA）扫描首页/列表/榜单/上传页/灯箱，**critical 与 serious 均为 0**；另有 alt、控件命名、`aria-pressed`、焦点可见、Tab 可达等 5 项专项 |
| T-14 | **PASS** | 错误码覆盖 400/403/404/409/413/415/422/429/503；上传恶意文件、断网重试、磁盘写失败均有集成用例 |
| T-15 | **PASS** | **CI 首次实跑通过**：<https://github.com/SanQianX/Isle/actions/runs/39406503899>（`a7e315a`，Ubuntu 24.04 / Node 22 / npm 10）。10 个作业全绿：lint+typecheck+format+audit、156 unit、149 integration、production build、5 个浏览器项目的 E2E、55 张 Linux 视觉基线。覆盖率报告以 artifact 形式上传 |

## 5. 生产化与上线

| ID | 状态 | 证据 |
|---|---|---|
| O-01 | **PASS** | `next build` 产出 standalone 并通过 E2E 启动验证；**Linux ABI 下已由 CI 重建并跑通全部测试**（run 39406503899，`ubuntu-latest` + Node 22） |
| O-02 | **NOT_RUN** | `deploy/nginx/isle.conf` / `isle-limits.conf` 已写；`nginx -t`、TLS、413、429 未在真实主机验证 |
| O-03 | **NOT_RUN** | `deploy/systemd/isle.service` 已写（含完整 hardening）；未在真实 systemd 上验证 |
| O-04 | **PASS（结构）** | DB 与 media 位于 `/var/lib/isle`，与 `/opt/isle/releases/<sha>` 完全分离；`deploy.sh` 只切换 `current` 符号链接 |
| O-05 | **PASS（本地实测）** | `npm run test:drill` → **14/14**：真实备份 → 隔离恢复 → 原件逐字节相同、行数一致 → **损坏归档被拒绝**（`archived media does not match the archived database`）。`write-media-manifest.mjs` 另测：7/7 原件 exit 0；**翻转 1 字节 → `hash-mismatch` exit 2**；**删除文件 → `missing` exit 2**。`reconcile-storage.mjs` 实测：干净树 0 漂移 |
| O-06 | **NOT_RUN** | 无 staging 主机，无法从域名走完上传/投票/下载链路 |
| O-07 | **NOT_RUN** | 无 staging 主机，无法执行回滚演练 |
| O-08 | **BLOCKED** | 需用户确认 `SITE_ACCESS_MODE`。代码默认 `friends-only`（nginx Basic Auth），公网开放需另行验收滥用治理 |
| O-09 | **BLOCKED** | **无服务器、域名、证书权限。状态：`READY_NOT_DEPLOYED`。** |

## 6. 已知问题

### P0（阻断发布）
**无。**

### P1
**无未解决项。**

### P2 / 已记录不修

| 项 | 说明 |
|---|---|
| Node 22 vs 24 | 生产锁 22，本地在 24 开发。ABI 差异由 Linux CI 覆盖（ADR-001） |
| WebKit 焦点行为 | Safari 在客户端路由后把焦点移回 `<body>` 且不归还，属浏览器行为。组件已在短窗口内重试；同文件另有**每个引擎都跑**的用例断言「焦点不被困住」与「触发元素仍可聚焦」，严格断言仅在 Chromium/Firefox 生效（2 条显式跳过，附理由） |
| 视觉基线权威性 | 本地基线在 Windows 生成；Linux CI 基线为最终版本（ADR-007） |
| Lighthouse / 磁盘满故障注入 | 未实机执行，登记为 staging 项 |
| eslint 9 已 deprecated | `eslint-config-next@15.5.28` peer 限制 `<10`；开发期工具，不随产品发布（ADR-013） |

## 7. Commit 对照

| Phase | Commit |
|---|---|
| 00 | `9cd2911` |
| 01 | `173bd11` |
| 02 | `4ca0fbb` |
| 03 | `c01ed6c` |
| 04 | `3e4ffc7` |
| 05 | `21425cf` |
| 06 | `b9bd092` + `7b50bd8` |
| 07 | `7b50bd8` |
| 08 | `f02c7a5` |
| 09 | `135a908` + `2d1b762` |
| 10 | `43d986e` + `fed51f2` |
| 11 | `785fd0a` |
| 12 | `05d6669` |
| 加固轮次 | `b3a3375` … `c6f1e8e`（20 个 commit，见 DELIVERY_REPORT §2） |

## 8. 最终测试结果

```
Unit         156 passed / 0 failed   (9 files)
Integration  149 passed / 0 failed   (10 files)
E2E          675 passed / 0 failed   (chromium + firefox + webkit + mobile-chrome + mobile-webkit)
Visual        55 passed / 0 failed   (11 baselines x 5 browser projects)
Backup drill  14 passed / 0 failed   (npm run test:drill)
lint / typecheck / format / build   exit 0
npm audit --omit=dev                0 vulnerabilities
```

## 9. 上线前人工动作

1. 拿到域名、证书与服务器 SSH 权限
2. 确认 `SITE_ACCESS_MODE`：`friends-only`（推荐）或 `public`
3. 在 staging 跑 `scripts/restore.sh` 完成一次真实恢复演练
4. Linux CI 跑一次完整 `check:all`，确认 Node 22 + Linux ABI 下同样全绿
5. 生成 Linux 版视觉基线并人工审定（`docs/visual-baselines/APPROVED.md`）
6. 按 `docs/operations/OPERATIONS.md` 第 10 节逐项打勾

详见 `docs/operations/OPERATIONS.md`。

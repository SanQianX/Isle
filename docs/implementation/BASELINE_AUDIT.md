# Phase 00 — 仓库与环境基线审计（真实命令输出）

审计日期：2026-10-19
审计目录：`D:\SanQian.Xu\Server Project`
审计结论：**空仓库（greenfield）**。不存在任何既有业务代码、数据库、图片或服务器部署产物，因此实施路径为「从零新建 Next.js 工程」，不存在「迁移既有后端」的风险。

---

## 1. 参考资料完整性

Plan Pack 自带 `SHA256SUMS.txt`，审计第一步验证其完整性：

```bash
cd docs/plans/ISLE_V1_Production_PlanPack && sha256sum -c SHA256SUMS.txt
```

结果：**18 / 18 OK**，无 FAILED、无缺失。

参考文件清单（全部保留在仓库中，不修改）：

| 文件 | 行数/大小 | 用途 |
|---|---|---|
| `00-reference/PRODUCT_REQUIREMENTS.md` | 165 行 | 产品功能边界基准 |
| `00-reference/V4.1_REFERENCE_ONLY.html` | 253 行 | 视觉/交互参考，**禁止直接部署** |
| `00-reference/V4.1_ORIGINAL_NOTES.md` | 17 行 | Justified Gallery 算法说明 |
| `00-reference/REFERENCE_USING_GUIDE.md` | 8 行 | 原型素材使用限制 |
| `00-reference/*.png` × 3 | — | 桌面/手机/摄影墙版式参考 |
| `01-plan/MASTER_PLAN.md` | 240 行 | Phase 00–12 分阶段规范 |
| `02-contracts/DATA_API_STORAGE.md` | 253 行 | 数据/API/存储契约 |
| `02-contracts/FRONTEND_UX.md` | 140 行 | 页面/组件/摄影墙/灯箱规范 |
| `03-testing/TEST_STRATEGY.md` | 268 行 | 测试分层与隔离策略 |
| `03-testing/E2E_SCENARIOS.md` | 183 行 | Playwright 用例目录 |
| `04-deployment/DEPLOY_RUNBOOK.md` | 237 行 | Nginx/systemd/备份/回滚 |
| `06-evidence/ACCEPTANCE_CHECKLIST.md` | 94 行 | 最终验收门禁 |

根目录另存在 `产品设计需求.md`（8.6 KB），内容为 `00-reference/PRODUCT_REQUIREMENTS.md` 的上游原始需求，保留不删。

---

## 2. V4.1 原型事实复核（独立重新确认，不采信文档转述）

对 `V4.1_REFERENCE_ONLY.html` 实际执行：

```bash
grep -c "localStorage" V4.1_REFERENCE_ONLY.html              # → 3
grep -o "URL.createObjectURL" ... | wc -l                    # → 2
grep -o "fetch(\|XMLHttpRequest\|axios\|/api/" ... | uniq -c # → (无输出)
grep -o 'href="#/[a-z]*"' ... | sort | uniq -c
```

实测结论，逐条对应 MASTER_PLAN §A：

| # | 结论 | 证据 |
|---|---|---|
| 1 | **单文件静态原型**，非 Next.js | 无 `fetch`/`XHR`/`axios`/`/api/` 任何一处；全部逻辑在单个 `<script>` 内 |
| 2 | **hash 路由** `#/home` `#/places` `#/ranking` `#/upload` `#/create` | 5 个 hash 路由锚点，共 15 处 `href="#/…"` |
| 3 | **访客身份与演示投票写入 localStorage** | 3 处 `localStorage` |
| 4 | **上传图片仅存在于当前会话** | 2 处 `URL.createObjectURL()`，从不写服务器 |
| 5 | **外部图片依赖** | `upload.wikimedia.org` ×2、`commons.wikimedia.org` ×2；Hero 与灯箱示例图均为 Wikimedia 远程资源 |
| 6 | **存在必须移植的纯算法** `bestPhotoRows()` | 见下节 |

### 2.1 `bestPhotoRows()` 关键实现细节（Phase 07 必须原样迁移并加单测）

实测源码（`V4.1_REFERENCE_ONLY.html:160-186`）确认其为一个**动态规划最优划分**，非贪心：

- 常量：`gap=22`、`target=335`、`maxHeight=440`、`minHeight=220`、每行最多 **5** 张。
- `cost[n]=0`，从 `i=n-1` 向前递推，`k` 从 1 遍历到 `min(5, n-i)`。
- 行高 `raw=(width-gap*(k-1))/sum(ratios)`，再 `actual=Math.min(raw, maxHeight)`。
- 惩罚项共 6 条：偏离目标高度 `(actual-target)/target` 平方；低于 `minHeight` 额外惩罚；非末行留空 `empty>2` 惩罚；`k===1 && n>1` 惩罚 1.4（避免任意位置出现孤立单图）；末行单图额外 0.5；末行留空 >gap 的轻微惩罚 0.16；最窄 tile < 152px 的惩罚 3×((152-narrowest)/152)²。
- **关键不变量：函数纯按下标切分 `[i, i+k)`，输入顺序即输出顺序，不存在任何重排逻辑。** 这与 FRONTEND_UX §4.2 不变量 1 一致，是 Phase 07 单测的硬断言。
- `photoRatio()` 对非法尺寸回退 `1.4`。
- `renderPhotoWall()` 在 `window.innerWidth<=760` 时**跳过 DP**，直接单列并按真实比例输出 `--photo-aspect`；否则按 DP 结果输出每 tile 的 `--photo-width`/`--photo-height`，行内 `gap:22px`，末行 `is-tail` 居中。
- 容器宽度来自 `getBoundingClientRect().width`，非仅 `window.innerWidth`。

### 2.2 V4.1 视觉 token（Phase 06 落地为 CSS 变量）

实测 `--bg:#f8f9f6`、`--hero:#eaf0eb`、`--paper:#ffffff`、`--ink:#1b2927`、`--muted:#71817a`、`--line:#d9e1db`、`--accent:#31594d`、`--lb:#090d0d`；`body[data-tone="mist"]` 覆盖为冷雾灰一组值。与 FRONTEND_UX §1 表格完全一致，无冲突。

### 2.3 断点

实测媒体查询：`1100px`、`760px`、`395px`，外加 `@media(prefers-reduced-motion:reduce)` 关闭动画。实现阶段保留这三个断点。

---

## 3. 工具链实测

```bash
node -v          # → v24.13.0
npm -v           # → 11.6.2
git --version    # → git version 2.45.2.windows.1
python --version # → Python 3.10.9
npx playwright --version   # → 未安装（npm error: missing packages）
```

网络连通性：

```bash
npm view next@15 version        # → 15.5.28 可达
curl -sI https://cdn.playwright.dev/…   # → HTTP/1.1 307（可达）
curl -sI https://github.com             # → HTTP/1.1 200 OK
```

版本管理器探测：`nvm` / `fnm` / `volta` / `nvs` / `nodenv` — **全部不存在**，本机只有 `C:\Program Files\nodejs`（Node 24.13.0）。

磁盘：`D:` 剩余 46 GB（总 317 GB，已用 86%）。

WSL：系统登记了 `Ubuntu-20.04` 发行版（版本 2），但**未验证可用状态**，且 Phase 11 需要的 systemd/nginx 演练不能依赖它。

---

## 4. 现状对照表

| 检查项 | 实际状态 | 对实施的影响 |
|---|---|---|
| Git 仓库 | **不存在**（`fatal: not a git repository`） | 本 Phase 执行 `git init -b main` |
| 业务源码 | **无**。全仓库仅 1 个非文档文件 `产品设计需求.md` | 新建工程，无迁移风险 |
| Next.js / App Router | **无** | 从零 bootstrap |
| 后端 API | **无** | 新建 Route Handlers |
| Prisma / SQLite | **无**，无任何 `*.db` / `*.sqlite` | 新建 schema + migrations |
| 上传图片目录 | **无** | 新建 `DiskStorage` |
| `.env` / 凭据 | **无** | 只需 `.env.example`，`.env` 进 `.gitignore` |
| 服务器代码 / 生产数据 | **无** | 无生产环境可被测试污染 |
| 既有测试 / CI | **无**，无 `.github/` | 新建 |
| 参考资料 | 18 文件，SHA256 全部 OK | 原样保留，禁止改写 |

---

## 5. 风险登记（Phase 00 识别，后续必须处理）

| ID | 风险 | 证据 | 处置 |
|---|---|---|---|
| R-01 | **本机 Node 为 24.13.0，生产基线要求 Node 22 LTS** | `node -v`；无版本管理器 | 记为 ADR-001。CI 与 systemd 均锁定 Node 22；本地在 Node 24 上验证并显式标注差异。**不为此跳过任何测试。** |
| R-02 | **开发机为 Windows，DEPLOY_RUNBOOK 目标是 Linux** | `uname` → Windows；nginx/systemd 不可用 | Phase 11 交付可部署发布包 + 本地生产构建验证；**不得声称已完成 Linux staging**。见 §6。 |
| R-03 | Playwright 浏览器未安装，下载量约 1 GB+ | `npx playwright --version` 报错；CDN 可达 | Phase 01 安装；失败则记录阻塞证据与安装命令，不得用 mock 顶替 |
| R-04 | V4.1 依赖 Wikimedia 远程图片，离线/受限网络会破图 | 4 处外链 | 生产页面**零外链图片依赖**；测试使用本地自建 fixture |
| R-05 | 参考原型截图中的照片是「网页预览分辨率的裁剪图」 | `V4.1_ORIGINAL_NOTES.md` 明示 | 禁止用作「桂山岛真实照片」；fixture 全部本地生成并记录 SHA |
| R-06 | 无服务器/域名/证书权限 | 用户未提供 | 状态只能是 `READY_NOT_DEPLOYED`，不得写「上线成功」 |

---

## 6. 上线状态判定（贯穿全项目）

本 Agent 无服务器 SSH、无域名、无 TLS 证书、无 DNS 权限。因此：

- 本地验收（真实 SQLite + 真实磁盘 + 真实浏览器）→ 可达成
- Linux staging 演练 → **不可达成**，交付脚本与 Runbook，标注 `NOT_RUN`
- 正式上线 → **不可能**。最终状态必须为 `READY_NOT_DEPLOYED`。

此项在 `ACCEPTANCE_CHECKLIST.md` 中对应 O-06/O-07/O-09，最终由 Phase 12 填实。

---

## 7. 实施路径

新建工程（非迁移），顺序严格按 MASTER_PLAN Phase 01 → 12，每 Phase 独立 commit。
参考 HTML **仅作视觉与算法来源**，禁止整段复制进 React（MASTER_PLAN §C 明确禁止），按页面/组件分拆。

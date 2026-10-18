# ISLE V1.0 — 架构决策记录（ADR）

每条记录：**背景 → 决策 → 理由 → 影响**。仅记录「有取舍」的决定，不记录显而易见的实现。

---

## ADR-001 — 开发环境使用 Node 24，生产与 CI 锁定 Node 22

**状态**：accepted（有已知差异）

**背景**
`MASTER_PLAN` §版本基线与 `DEPLOY_RUNBOOK` §1 均要求 Node.js 22 LTS，用于 CI/服务器可重复构建。本机实测 `node -v` = **v24.13.0**，且 `nvm`/`fnm`/`volta`/`nvs`/`nodenv` 全部不存在，无法在不改系统的前提下切换版本。

**决策**
- 实施期在本机 Node 24.13.0 上完成全部构建与测试。
- `package.json` 声明 `"engines": { "node": ">=22 <25" }`。
- `.github/workflows/ci.yml` 使用 `actions/setup-node` 固定 `node-version: 22`。
- `deploy/systemd/isle.service` 的 `ExecStart` 与 Runbook 均按 Node 22 路径书写。
- **不为版本差异跳过任何测试**；Linux ABI 差异在 Phase 11 记为未验证项。

**理由**
Node 24 是当前 LTS 线，Next 15.5 与 Prisma 6 均支持。放弃在 CI/生产强推 Node 22 而本地用 24，会引入「本地过、CI 挂」的静默分歧；反之把 CI 降到 22 则保证上线环境可重复，且本地测试仍覆盖全部功能。差异只落在 sharp/Prisma 原生二进制的 ABI 上，由 CI 覆盖。

**影响**
- 本地所有测试结果有效，但**不能替代 Linux ABI 验证**。
- `ACCEPTANCE_CHECKLIST` A-02 / T-15 需在真实 CI 跑过后才能标 PASS。

---

## ADR-002 — 全栈数据模型、限流与身份一律走服务端 Cookie，不接受前端 visitorId

**状态**：accepted

**背景**
V4.1 原型把访客编号与投票存在 `localStorage`，任何人可改。`DATA_API_STORAGE` §2.3 明确要求访客身份由服务器签发。

**决策**
- 访客 token：服务器 `crypto.randomBytes(32)`（256 bit）生成，仅以 `HttpOnly` + `SameSite=Lax` cookie 下发；数据库只存 `SHA256(token)`。
- Cookie 名：生产 `__Host-isle_visitor`；本地 http 开发用 `isle_visitor`（`__Host-` 前缀要求 Secure，http 下无法设置）。见 ADR-003。
- **任何 API 都不接受请求体/查询参数中的 `visitorId`、`score`、`upCount`。** 全部从 cookie 解析。
- 限流（写操作）同样以 cookie 解析出的 Visitor 为键，不依赖 IP（同一 NAT 下多个朋友不会互相影响）。

**理由**
这是「一访客一票」与「不伪造票数」的唯一可信基础。前端永远不保存权威分数，`score` 只由服务端聚合 `SUM(Vote.value)` 计算。

**影响**
- `PUT /api/photos/:id/vote` 的幂等性完全由 `(photoId, visitorId)` 唯一约束兜底。
- 删 cookie 即换身份（真实且不可完全阻止），此限制在 `DEPLOY_RUNBOOK` 与产品说明中如实写明，不做虚假防刷承诺。

---

## ADR-003 — `__Host-` cookie 前缀与本地 http 的冲突处理

**状态**：accepted

**背景**
`DATA_API_STORAGE` §2.3 建议 cookie 名为 `__Host-isle_visitor`，该前缀强制要求 `Secure` + `Path=/` + 无 `Domain`。本地开发与 Playwright E2E 跑在 `http://127.0.0.1`，浏览器会拒收带 `Secure` 的 cookie。

**决策**
- 由配置项 `VISITOR_COOKIE_NAME` 决定：`PUBLIC_BASE_URL` 为 `https://` 时用 `__Host-isle_visitor`，否则用 `isle_visitor`。
- 两者属性完全一致：`HttpOnly`、`SameSite=Lax`、`Path=/`、`Max-Age=31536000`，生产额外加 `Secure`。
- 该偏离记录在此处，便于审查者确认「本地少一个前缀」是环境差异而非安全降级。

**理由**
既保住生产环境的 `__Host-` 加固，又不让本地/E2E 静默失效。测试断言针对「cookie 属性集合」而非具体名字，避免耦合。

---

## ADR-004 — 上传采用受限流式解析（busboy），不使用 `await request.formData()`

**状态**：accepted

**背景**
`DATA_API_STORAGE` §4.2 第 2 步明确要求「不应无上限 `await request.formData()` 将巨大文件全部缓冲进内存」。

**决策**
- 用 `busboy` 按 `Content-Length` + 逐块累计做双重硬限制（`MAX_UPLOAD_BYTES`，默认 25 MiB）。
- 边接收边写临时文件并增量计算 SHA-256 与实际字节数，超限立即中断流。
- 临时文件名用服务器生成的 UUID，**绝不复用用户上传的文件名**。

**理由**
25 MiB × 并发 2 的缓冲在 Node 单进程下仍可能放大到数百 MB；流式落盘同时天然满足「接收即算 hash」，无需二次读文件。

**影响**
- 需要 `Content-Length` 头；分块传输（chunked）时以实际累计字节为准，超限行为一致。
- 集成测试必须覆盖「上传中途断开」与「超限」两条路径。

---

## ADR-005 — 缩略图用 WebP + `fit: inside`，且不做无意义放大

**状态**：accepted

**背景**
`DATA_API_STORAGE` §4.1 要求 400/1200 两档预览、不裁切、不放大；`PRODUCT_REQUIREMENTS` §四 要求列表页用「压得很小没关系」的缩略图。

**决策**
- 格式统一 WebP（体积优势明显，且列表页不是画质主张所在）。
- `fit: 'inside'`，`withoutEnlargement: true`，`position: 'centre'`。
- **原图字节永不改动**：不转格式、不重编码、不缩放、不剥离 EXIF。派生图默认剥离元数据。
- 预览的 400/1200 是两套**独立文件**，不按需动态生成，避免每次请求重复编码。

**理由**
缩略图是展示辅助，原图才是产品价值所在（`PRODUCT_REQUIREMENTS` §四）。两者彻底分离，使「灯箱拿 1200 冒充原图」在结构上不可能发生。

**影响**
- `Photo` 记录 `preview400Key` / `preview1200Key`，`READY` 前必须二者齐备（DATA_API_STORAGE §6.6）。
- `sharp` 是硬依赖；缺 `libvips` 时构建失败属预期，不可用 JS 兜底（性能与内存不可接受）。

---

## ADR-006 — 榜单排序在 SQL 层完成，游标按 `(score, upCount, createdAt, id)` 编码

**状态**：accepted

**背景**
`DATA_API_STORAGE` §3 要求 `?limit=40&cursor=…`，排序固定为 `score DESC, upCount DESC, createdAt ASC, id ASC`。

**决策**
- 用 Prisma `orderBy` 组合表达排序，`take: limit + 1` 判定 `hasMore`，多出的那条即为下一页游标。
- 游标为该条的复合排序键的 base64url 编码（非自增 ID）。
- 投票会改变排序键，游标可能失效：此时 API 返回 `nextCursor: null` 并置 `rankingMayHaveChanged`，前端引导刷新第一页。**不承诺投票期间长榜单完全快照一致**（契约已明示）。

**理由**
偏移量分页在实时重排的榜单上必然重复/漏项。复合键游标在无投票期间稳定，有投票时按契约降级。

---

## ADR-007 — Visual Regression 基线在 Linux CI 生成，本地 Windows 基线不作为最终证据

**状态**：accepted（有已知缺口）

**背景**
`TEST_STRATEGY` §6 要求「尽可能在同一 Linux CI 环境进行截图」「容差…不能上调到掩盖布局错误」。字体渲染在 Windows/Linux 间差异显著。

**决策**
- 本地（Windows）跑 Playwright 时，视觉快照使用**独立快照目录** `e2e/__screenshots__/local/`，与 CI 的 `default/` 分开存放，避免互相污染。
- `test:visual` 在本地执行并产出 diff 证据，但 `ACCEPTANCE_CHECKLIST` T-12 最终只能由 Linux CI 基线审定。
- 快照容忍度保持默认（`maxDiffPixelRatio` 不上调到掩盖布局错误）。

**理由**
字体抗锯齿差异是平台固有差异，不是布局回归。把两端基线混在一起会产生永久失败的假回归，或诱导上调容差——两者都违反契约。

**影响**
- T-12 最终状态为 `NOT_RUN`（需 CI），在 Phase 12 如实登记。
- 本地视觉用例仍**必须真实执行并通过**，用于捕获自身引入的布局错误。

---

## ADR-008 — 无服务器权限：交付发布包而非执行上线

**状态**：accepted

**背景**
用户未提供服务器 SSH、域名、证书或 DNS 权限；开发机为 Windows，无法执行 nginx/systemd。

**决策**
- Phase 11 交付：`next.config.ts` 的 `output: 'standalone'`、`deploy/nginx/*.conf`、`deploy/systemd/isle.service`、`scripts/{deploy,backup,restore,verify-media-hashes}.sh`、`docs/operations/OPERATIONS.md`。
- 本地验证范围：真实生产构建（`next build` + `next start`）+ 独立 SQLite/磁盘 + 真实浏览器全链路 + 备份/恢复到隔离目录的**实际演练**（脚本在本地可跑的部分）。
- 不可验证项（Linux nginx `nginx -t`、systemd、TLS 证书、`sqlite3 .backup` on Linux）如实标记 `NOT_RUN` 并写明复现命令。

**理由**
`MASTER_PLAN` §G 与 `START_PROMPT` 第 6 条均要求：缺权限时只能交付可执行部署包，**不得假称已发布**。

---

## ADR-009 — 限流采用「进程内滑动窗口 + SQLite 计数」，v1 不引入 Redis

**状态**：accepted

**背景**
`DATA_API_STORAGE` §5 要求服务端访客配额（地点 ≤3/日、照片 ≤30/日、投票 ≤120/分钟），同时 §B 明确「不引入 Redis、Kafka、微服务」作为第一期必需项。

**决策**
- 单机单进程，限流状态用进程内 `Map`（带过期清理）承载投票类高频计数；日配额类计数落 SQLite（`RateBucket` 表），保证重启后不丢。
- 超限返回 `429` + `Retry-After`，中文提示「操作太频繁，请稍后再试」。

**理由**
规模为 5–15 人，进程内状态足够；日配额跨重启必须持久，故放 DB。不引入外部依赖符合 V1 边界。

**影响**
- 多实例部署时进程内计数不共享——但 v1 明确单实例（systemd 单进程），已在 Runbook 记录该约束。

---

## ADR-010 — `status` 字段只由服务层迁移，V1 无后台 UI，下架走运维 CLI

**状态**：accepted

**背景**
`DATA_API_STORAGE` §1 要求 `PROCESSING → READY | FAILED | HIDDEN`，§5 要求保留侵权/隐私撤回的下架能力，但 §B 禁止开发后台 UI。

**决策**
- 状态机写在 `src/server/services/photo.ts`，任何状态变更必须经过服务函数，不允许路由直接 update。
- 下架/恢复通过 `scripts/moderate-photo.ts` CLI（`hide` / `show` / `purge`），每次操作写审计行。
- 查询层只返回 `READY`；`HIDDEN` 照片的 original/preview/download 路由返回 404，不泄露其存在。

**理由**
满足「不能用『永久归档』作为拒绝合法删除的借口」，同时不引入 V1 禁用的后台 UI。

---

## ADR-011 — 测试夹具全部本地程序化生成，并记录 SHA-256

**状态**：accepted

**背景**
`TEST_STRATEGY` §3 要求许可合规、尺寸固定的 fixture；V4.1 的 Wikimedia 远程图与截图裁剪图**不可**作为上传照片（`REFERENCE_USING_GUIDE` 明禁）。

**决策**
- `scripts/generate-test-fixtures.mjs` 用 `sharp` 程序化生成全部尺寸素材（landscape/portrait/square/extreme-wide/extreme-tall/small 等），生成后写 `tests/fixtures/MANIFEST.json`（尺寸 + 字节数 + SHA-256）。
- `exif-rotate.jpg`（Orientation=6）与 `gps-exif.jpg`（真实 GPS）由脚本写入真实 EXIF 段，保证 EXIF 逻辑可测。
- `invalid-text.jpg`（纯文本伪装）、`corrupt.jpg`（截断）同样是程序化生成。
- `too-large.jpg` 不入库（体积），由脚本按需生成到临时目录。

**理由**
消除外链依赖、保证断言稳定、许可干净，且每张图的字节与 hash 可复核。

---

## ADR-012 — 组件与页面拆分，禁止整段复制 V4.1 HTML

**状态**：accepted

**背景**
`MASTER_PLAN` §C 末尾明确禁止「直接将 `V4.1_REFERENCE_ONLY.html` 的 HTML 字符串插进 React」。

**决策**
- V4.1 只作为**视觉与算法来源**：`bestPhotoRows()` 重写为纯 TS 模块并加属性测试；设计 token 转为 CSS 变量 + Tailwind 主题。
- 页面拆为 `src/app/**/page.tsx`，组件按 `shell/place/photo/lightbox/forms` 分类，全部为语义化 JSX。
- 图片展示区域一律 `object-fit: contain`，不裁切、不叠大段文字。

**理由**
可测试性（组件级 RTL 定位）、可维护性、以及避免把「演示用 localStorage 逻辑」当成生产实现带进来。

---

## ADR-013 — 生产依赖清零；5 项 dev-only 告警作为已记录的风险接受

**状态**：accepted（风险接受）

**背景**
`TEST_STRATEGY` §8 规定：`npm audit` 的**高危/严重生产依赖**阻断发版，例外必须有清楚的风险接受记录。首次审计（`npm audit --omit=dev`）得到 6 项漏洞、5 项 high：

| 依赖链 | 严重度 | 公告 |
|---|---|---|
| `sharp` 0.34.5 → libvips / libheif / librsvg | high ×5 | GHSA-f88m-g3jw-g9cj, GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w |
| 初次安装后重新审计 | — | 详见下方最终状态 |

**决策与实测**

1. **`sharp` 0.34.5 → 0.35.5**（`dependencies`，随运行时发布）。
   理由：vips 8.18.7 / heif 1.23.5 / rsvg 2.63.2 修复上述公告。已验证 `require('sharp')` 加载、WebP 编码、JPEG/PNG 解码入口均正常。

2. **`vitest` 3.2.7 → 4.1.12**（`devDependencies`）。
   理由：vitest 3 依赖 `tinypool@^1`，命中 **critical**「Tinypool Prototype Pollution Gadget to RCE」，另有 critical「Vitest Path Traversal via @vitest/mocker Redirect Mock」。vitest 4.1.12 的依赖表中已无 `tinypool`（改用 `obug`/`tinyexec`），两条 critical 一并消除。实测 `npm ls tinypool` → `(empty)`。

3. **`overrides: { "postcss": "8.5.30" }`**。
   理由：next@15.5.28 内部锁定 `postcss@8.4.31`，命中 high「PostCSS Arbitrary File Read via sourceMappingURL」等 4 项。`npm audit fix` 唯一的修复路径是把 next 升到 16，但 `MASTER_PLAN` §版本基线**明确要求使用 15.5.28，不得使用旧 15.x 漏洞版本**，升级到 16 属于擅自改变既定技术基线。改用 override 强制 next 使用已修复的 postcss 8.5.30（同为 8.x 主版本，API 兼容），保留 Next 15.5.28 基线同时清除告警。实测构建通过、`npm audit --omit=dev` 为 0。

4. **`overrides: { "deepmerge-ts": "8.0.2" }`**。
   理由：prisma@6.19.3 → `@prisma/config` → `deepmerge-ts@7.1.5`，命中 high「DeepmergeTS 递归对象图合并栈耗尽」。修复仅能通过 prisma 7（主版本破坏性升级），而 `MASTER_PLAN` 明确要求 **Prisma 6.x 锁定兼容版本**。override 到 8.0.2 后实测 `npx prisma --version` 正常退出码 0，`prisma generate` / `migrate deploy` 均可用。

**最终状态**

```
npm audit --omit=dev   →  found 0 vulnerabilities
npm audit（全量，含 dev） → 5 high（全部为 lint 工具链）
```

**已接受并记录的 5 项 dev-only 告警**

| 依赖 | 严重度 | 可用修复 |
|---|---|---|
| `@next/eslint-plugin-next` | high | 仅 Next 16 可修（与既定基线冲突） |
| `eslint-config-next` | high | 同上 |
| `braces` | high | `range: *` — 上游**尚无修复版本** |
| `fast-glob` | high | `range: *` — 上游尚无修复版本 |
| `micromatch` | high | `range: *` — 上游尚无修复版本 |

**风险接受理由**
- 全部为 `devDependencies`，**不进入发布产物**，不随 `output: 'standalone'` 打包到服务器。
- 仅在开发者/CI 机器上运行，输入是本仓库自有源码文件，不存在攻击者可控输入面。
- `braces` / `fast-glob` / `micromatch` 的公告 `range` 为 `*`，即**上游没有修复版本**，override 只会伪造修复状态，因此不做覆盖。
- `eslint@9.39.5` 亦被 npm 标记 deprecated，但 `eslint-config-next@15.5.28` 的 peer 范围是 `^7.23 || ^8 || ^9`，升级到 eslint 10 会破坏该约束；lint 属开发期工具，不随产品发布。

**复核方式**
```bash
npm audit --omit=dev --registry=https://registry.npmjs.org   # 期望 0
npm audit --registry=https://registry.npmjs.org               # 5 high，均为上表 lint 工具链
```

**后续条件**
一旦 `MASTER_PLAN` 的 Next 15.5 / Prisma 6 基线被正式解除（例如升级到已审计的 Next 16 / Prisma 7），应重跑审计并把本条 ADR 关闭。

---

## ADR-014 — SQLite 连接池固定为 1，并显式设置三个 PRAGMA

**状态**：accepted

**背景**
`DATA_API_STORAGE` §1 要求 SQLite 开启 WAL、`busy_timeout ≥ 5000`、`foreign_keys=ON`。其中 WAL 是**持久**属性（存在数据库文件里），但 `busy_timeout` 与 `foreign_keys` 是**逐连接**属性，而 Prisma 没有暴露「每连接执行 PRAGMA」的钩子。

**决策**
- 连接串强制追加 `connection_limit=1`。
- 进程内只创建一次 `PrismaClient`（挂在 `globalThis`），启动时执行一次四个 PRAGMA 并等待完成。
- 实测结果：`journal_mode=wal`、`busy_timeout=5000`、`foreign_keys=1`。

**理由**
单连接让逐连接 PRAGMA 确定性地作用于唯一的连接；写入天然串行，杜绝 SQLite 最常见的「两个连接都以为自己是写者」问题。目标用户规模 5–15 人，单连接不是吞吐瓶颈。

**验证方式**
集成测试**不只读标志**，而是实际插入一条孤儿 `Photo` 并断言数据库拒绝（`Foreign key constraint violated`），证明 FK 真的在生效；另删除 Place 断言 Photo 级联消失而 Visitor 保留。

**影响**
多实例部署时该假设失效。已在 `DEPLOY_RUNBOOK` 记录「v1 单机单进程」，ADR-009 的内存限流同样依赖此前提。

---

## ADR-015 — `Photo.originalKey` 去掉 `@unique`，改为普通索引（**偏离 Plan Pack 示例 schema**）

**状态**：accepted（有意偏离，已记录）

**背景**
`DATA_API_STORAGE` §1 的示例 schema 写的是 `originalKey String @unique`。实施中本项目采用了**内容寻址**（content-addressed）存储：key 由文件自身的 SHA-256 派生，形如 `original/ab/<sha256>.jpg`。

两者组合会产生真实缺陷：**两位访客上传完全相同的照片时，第二位会失败**。集成测试实测暴露了这一点——同一 fixture 在同一测试文件内被上传两次时，第二次因 `originalKey` 唯一约束而报错。同理，同一张照片用两个不同的 `idempotencyKey` 重传也会失败。

**决策**
- `originalKey` 改为普通 `String` + `@@index([originalKey])`，不再唯一。
- 迁移 `20261018182353_content_addressed_original_keys`：删除唯一索引、建立普通索引。
- `DiskStorage.putOriginal` 在目标 key 已存在时，**先重新计算既有文件的 SHA-256**，与新内容比对：
  - 相同 → 复用既有 blob，返回成功（不重复写盘、不重复占空间）；
  - 不同 → 抛错拒绝，并明确报「refusing to overwrite」。伪造 key 也无法覆盖任何已归档原件。

**理由**
- 内容寻址下「key 唯一」是**恒等式**，不提供任何额外保证，却引入真实故障。
- 示例 schema 假定 key 是每张照片一个随机 ID；那是**语义等价**要求（原件不可变、key 不更新），唯一索引并非语义本身。`DATA_API_STORAGE` §1 原文即允许「保持等价语义」而非逐字照抄。
- 复用而非报错更符合产品预期：两位朋友传同一张照片应当都成功。

**影响与已处理的连带风险**
- 一张原始文件可能被多条 Photo 行引用。这是安全的，因为原件**永久归档、正常业务永不删除**（`DATA_API_STORAGE` §5）。
- 因此删除路径必须改为**引用检查**：运维 CLI 下架/删除照片前必须先确认没有其他 Photo 引用同一 key，否则会连带删掉别人在用的原件。该检查在 Phase 11 的 `reconcile-storage` / `moderate-photo` 中实现并测试。
- `originalSha256` 列保持不变，且它才是灯箱 ETag 与备份校验的依据，不依赖 key 唯一性。

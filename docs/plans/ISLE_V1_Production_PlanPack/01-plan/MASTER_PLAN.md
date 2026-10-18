# ISLE V1.0 Master Development Plan — 分阶段机械执行规范

**文档级别**：实施契约 | **目标 Agent**：MiniMax | **交付方式**：连续多个小 Commit + 可检验产物。

## A. 真实基线审计（已确认的事实）

对 `00-reference/V4.1_REFERENCE_ONLY.html` 的源码审阅结论：

- V4.1 是单文件静态 HTML/CSS/JavaScript 原型，使用 `#/home`、`#/places`、`#/ranking`、`#/upload`、`#/create` 的 hash 路由；不是 Next.js 项目。
- 地点与照片初始值来自内嵌常量；访客编号和部分演示投票写入浏览器 `localStorage`；新上传图片使用 `URL.createObjectURL()`，仅在页面当前会话中展示，**未写入服务器数据库或永久磁盘**。
- `bestPhotoRows()` 动态规划将按排名排序的照片切分为等高不等宽行；`renderPhotoWall()` 用原始宽高比排列，<=760px 切换单列；这是需移植并写单元测试的关键视觉算法。
- 首屏、地点发现、榜单、上传、新建地点、深色灯箱已经有视觉参考；背景允许纸白/雾灰切换。
- 参考原型含外部 Wikimedia 资源和用户截图裁剪的预览图片；**它们不是可用于真实上线的完整用户原图**。
- 示例 JS 的投票/排序/地点/上传行为只是在前端模拟，不能视为后端实现。

Agent 应在 Phase 00 对**实际目标仓库**重新确认以上结论；若用户另有已有真实后端，以现有源码实况优先，最小迁移而非盲目重做。

## B. 核心产品范围（绝不扩大）

### P0 / 必须全部落地

1. 地点：查看地点列表、创建地点、桂山岛默认存在。
2. 照片：多选/拖拽、上传进度、保存到地点、列表查看、标题/描述、匿名上传者。
3. 榜单：score=赞成数-反对数；降序；同分按赞成数降序；仍同分按上传时间升序；最终以 id 作稳定比较。
4. 投票：同一访客浏览器对同一照片只有一个当前 vote；赞成→再次点赞成=撤销，赞成→反对=-2 分，反对→赞成=+2 分；刷新、重开浏览器、多访客和服务重启一致。
5. 原图：服务端 **一字节不改** 保存并提供独立原图 URL / 下载；400px/1200px 缩略图另存；灯箱上一张/下一张、zoom 1:1、文件信息和投票。
6. UI：V4.1 的安静浅色摄影网站视觉，背景纸白/雾灰，照片突出；Justified Gallery 保留比例，排序顺序不变，不出现大片不合理空白；手机单列。
7. 真实完整测试：Unit + Integration + API + Playwright E2E + Visual Regression + CI。
8. 生产运维：Linux + nginx + systemd，无 Docker 也能启动；HTTPS、数据备份、恢复演练、发版回滚、基础监控。

### V1 禁止范围

- 注册登录、个人主页、关注、私信、评论、地图、搜索、后台管理 UI、视频、AI 自动选图、自动轮播、重装饰动画。
- “打卡”定义为**向地点分享照片**；不增加独立 GPS 定位签到或“我去过这里”按钮，除非用户另行明确要求。
- 不做真实人脸识别/真实身份鉴别；不引入 Redis、Kafka、微服务、容器编排或云对象存储作为第一期必需项。

### 视觉不可退化规则

- 图片不得强制裁成 1:1 或统一 3:2；`object-fit:cover` 不得作用在用户照片的完整展示区域。
- 禁止在图片上叠大段文字、灰色 CMS 卡片边框或浮夸过渡；投票区域不能盖在主要景色上。
- 不牺牲图片横竖比例去制造整齐；容器宽度/高度由布局算法算出。
- 不得让大图查看加载 1200px 缩略图冒充原图。
- 确保没有一个页面仅有“UI 假入口”：按钮必须有实际结果、禁用原因或明确反馈。

## C. 推荐技术架构

| 层 | 方案 | 原因 |
|---|---|---|
| 运行时 | Node.js 22 LTS（同一锁定版本用于 CI/服务器） | 无 Docker 部署可重复 |
| Web | Next.js 15 App Router + TS 严格模式 | 页面/API 同仓库；满足原需求 |
| 样式 | Tailwind CSS + CSS 变量 Design Tokens | 与 V4.1 视觉对齐；保持轻量 |
| 前端状态 | Server Components 读页面 + 少量 Client Components（投票/上传/灯箱） | 不引入全局状态框架 |
| 后端 | App Router Route Handlers（Node runtime）→ Service → Repository | 对外 API 与业务逻辑解耦 |
| ORM/DB | 固定兼容的 Prisma 6.x + SQLite WAL | 小规模可靠持久化与 migrate |
| 图片 | DiskStorage 接口 + sharp 派生缩略图 | 原件不可变；未来可换对象存储 |
| 校验 | Zod + 文件签名/图片解码检查 | 统一 API 输入合法性 |
| 测试 | Vitest + React Testing Library + Playwright Test + axe-core | 逻辑、真实 API、UI 行为与可访问性 |
| 发布 | Nginx → Node (systemd)，Next standalone 构建 | 自有服务器、无 Docker |
| CI | GitHub Actions / Ubuntu runner | 自动 build + 完整浏览器测试 |

依赖应在 Phase 01 锁定版本并提交 lockfile；Next.js 15 至少采用 2026-10-14 官方已修补的 **15.5.28**，如开发日有更高的 15.5 安全补丁应优先采用并记录。

### 模块边界（建议目录，名称允许小调整）

```text
src/
  app/
    page.tsx                       # 首页 / 桂山岛精选（或配置的首选地点）
    places/page.tsx                # 地点列表
    places/new/page.tsx            # 创建地点
    places/[slug]/page.tsx         # 地点首页
    places/[slug]/ranking/page.tsx # 完整照片榜
    places/[slug]/upload/page.tsx  # 上传照片
    api/visitor/route.ts
    api/places/route.ts
    api/places/[placeId]/photos/route.ts
    api/photos/[photoId]/vote/route.ts
    api/photos/[photoId]/original/route.ts
    api/photos/[photoId]/download/route.ts
    api/photos/[photoId]/preview/[size]/route.ts
    api/health/route.ts
  components/{shell,place,photo,lightbox,forms}/
  features/gallery/{best-photo-rows.ts,PhotoWall.tsx}/
  server/
    db/
    auth/visitor.ts
    services/{place,photo,vote}.ts
    storage/{Storage.ts,DiskStorage.ts}
    image/{validate,metadata,derivatives}.ts
  lib/{errors,config,api-contract}.ts
prisma/schema.prisma
prisma/migrations/
tests/{unit,integration,fixtures}/
e2e/{smoke,vote,upload,visual,security}/
scripts/{seed,backup,restore,deploy,release-check}/
.github/workflows/{ci.yml,staging-smoke.yml}
```

**禁止直接将 `V4.1_REFERENCE_ONLY.html` 的 HTML 字符串插进 React 作为长期实现。** 必须按页面/组件分拆，保持语义、可维护性与测试可定位性。

## D. 共通工程标准 / 全局 Gate

- 所有业务代码使用严格 TypeScript；核心功能拒绝无理由 `any`、裸 SQL 拼接、未检验的文件路径。
- `GET` 读 API 与会改变数据的 `POST`/`PUT` 严格分离；写操作校验 Origin 和 cookie。
- 服务端返回标准化成功/错误结构；API 错误有可定位代码；前端必须展示中文错误提示。
- 每张图含固定 `width/height` 或 `aspect-ratio`，不因图片解码造成巨幅 CLS；响应式布局无横向滚动。
- 所有用例使用隔离测试库和临时磁盘目录；**不得修改生产 SQLite 或原始照片目录**。
- 每个 Phase 完成必须运行适用的 lint、typecheck、单元/集成、最小浏览器冒烟和 build；有问题先修复再 Git Commit。
- 发布 Gate 必须运行全量：`npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build && npm run test:e2e && npm run test:visual`；CI 具体脚本须存在并无错误短路。
- 不能因所谓“节省 tokens”省去文件检查和关键测试；可以分阶段只重跑受影响用例，最终必须全量。
- 进度文档 `docs/implementation/PROGRESS.md` 使用“事实+命令+成功数量+Commit hash+残留”格式，不得填“测试通过”却没有执行记录。

## E. 13 个可独立提交的实施阶段

### Phase 00 — 仓库/环境审计（不改变业务代码）

**实施**：核实当前目标目录、Git 状态、原型版本、是否已有 Next/App API、Node/npm/Playwright 可用性、是否存在服务器代码与生产数据；复制/引用 V4.1 原型和需求；建立 `docs/implementation/BASELINE_AUDIT.md`、`PROGRESS.md`、`DECISIONS.md`。

**验收**：输出现状对照表、风险、实施路径（新建或保守迁移）、实际命令及输出；不能把 V4.1 演示功能描述为生产后端。

**提交**：`docs: audit ISLE baseline and lock scope`。若无 Git 初始化，执行初始化并保留全部参考文件。

### Phase 01 — 初始化可复现工程与 CI 骨架

**实施**：Next15 + TS + Tailwind + ESLint + Prisma6 版本锁定、`package-lock.json`；Vitest、RTL、Playwright、axe；eslint 与格式规则；`.env.example`；测试脚本/Playwright webServer；最小真实健康探针；GitHub Actions 最小 lint/typecheck/build/test；`.gitignore` 排除 DB、media、密钥和报告。

**验收**：`npm ci`、`npm run lint`、`npm run typecheck`、`npm run test:unit`、`npm run build` 成功；`GET /api/health` 返回 200；Playwright 可驱动本机 Chromium 打开主页且无致命页面错误；**禁止空脚本用 `echo ok` 假通过**。

**提交**：`chore: bootstrap Next app and testing pipeline`。

### Phase 02 — 数据模型、迁移、服务端访客身份和地点

**实施**：Prisma 模型 Place/Visitor/Photo/Vote；唯一/外键/索引；SQLite WAL/busy timeout；schema 首次 migrate；种子 **桂山岛**（幂等）；随机不可猜访客 cookie，由服务器签发并解析为 Visitor；地点创建、列表、详情 API；地点重名和 slug 处理；测试工厂。

**验收**：新浏览器拿到安全 cookie，同浏览器重开维持身份，另外一个 context 不共享；`GET /api/places` 有桂山岛；添加新地点后重启服务不丢失；重复创建受控；API `400/409/429` 响应符合合同；migration 能从空库建库并重复 deploy 不破坏数据。

**提交**：`feat: persist places and anonymous visitors`。

### Phase 03 — 原图上传、派生缩略图与磁盘存储

**实施**：Storage 接口 + DiskStorage；图片真实文件类型和尺寸检查；单图请求、前端批量调度 2 并发；以临时文件写盘，SHA-256 校验，生成 400/1200 不裁切预览；原图原字节落盘；元数据、上传状态；磁盘失败清理；重复提交防重；上传可展示进度的服务端响应约定。

**验收**：测试夹具上传、重启后仍在；服务端原图文件 SHA-256 = 输入文件 SHA-256；缩略图可解码且不裁切；图片被拒绝时 DB 无可见半成品、没有孤儿文件；缺磁盘权限/写盘中断可恢复；批量 10 张中 1 张错误时另外 9 张可独立成功并反馈。

**提交**：`feat: immutable originals and safe photo ingestion`。

### Phase 04 — 照片查询、榜单与原图访问 API

**实施**：地点照片列表，按 score、upCount、createdAt、id 排序；返回 rank / currentVisitorVote；404/空榜单、分页和游标（避免大数据全量加载）；原图路由直接流出字节，预览尺寸路由；下载响应含正确文件名和 MIME、ETag、Content-Disposition、缓存与 Range（如实现分块）。

**验收**：种子 10–30 图跨页面排序稳定；同分规则实测；原图下载字节与磁盘精确相等，Range（如果支持）符合 RFC；非图片和跨地点 photo ID 无不当泄露；原图不会经过 `/_next/image` 优化。

**提交**：`feat: rank photos and serve unchanged originals`。

### Phase 05 — 投票服务、事务和防重复

**实施**：绝对状态 `PUT /api/photos/:id/vote {value:-1|0|1}`；使用 `(photoId,visitorId)` 唯一约束、事务写入或删除；API 返回新的 authoritative aggregate、currentUserVote、rank；失败回滚；合理的节流、Origin 检查。

**验收**：同一 context 同一照片最多 1 票；赞成→赞成撤销，赞成→反对 score -2；重复请求幂等；多浏览器投票汇总；同时点同一按钮或 20 次并发不能重复累加；榜单立刻重新计算、并发事务无丢票。

**提交**：`feat: transactional anonymous voting`。

### Phase 06 — 全站页面骨架和视觉还原

**实施**：把 V4.1 拆分为真实 Next 页面；导航、页眉/页脚、地点 Hero、地点列表、榜单、创建/上传的初版；设计 token：纸白 / 雾灰、海绿、简洁文字和分隔线；响应式；独立路由可直达和前进/后退；服务器数据接入，不含假地点和 fake votes。

**验收**：桌面 1440x900、平板 768x1024、手机 390x844、窄手机 360x780 页面不横向溢出；可直接打开任意路由；真实创建地点立即从其他浏览器可见；无外链图片依赖和浏览器控制台错误。

**提交**：`feat: implement V4.1 site pages and design tokens`。

### Phase 07 — Justified Gallery + 真实票数交互

**实施**：迁移纯 TS 动态规划 `bestPhotoRows()`；React PhotoWall 根据 ResizeObserver 的容器宽度重新布局；移动端单列原比例，桌面等高不等宽；第一名特殊突出；实时票数 + 选中态；更新后排名可重排且不丢失焦点。

**验收**：0/1/2/3/20/100 张、横/竖/超宽/超高混排全部可用；排名视觉顺序一致；无重叠、变形、大片意外空洞；窗口缩放/设备旋转正确重排；键盘可投票，`aria-pressed` 正确；失败时回滚 UI 并反馈。

**提交**：`feat: responsive justified gallery and live votes`。

### Phase 08 — 原图灯箱 / 原件下载 / 图片隐私提示

**实施**：全屏暗色灯箱、大图自适应、1:1、前后图片、Escape、键盘左右、手机左右轻扫（不干扰 1:1 平移）、详情收起/展开、文件信息、下载原件、当前位置/总数、弹窗焦点管理；可共享 `?photo=ID` 深链与历史返回行为。

**验收**：打开大图请求 `/api/photos/:id/original`，响应 SHA 与上传相同；无缩略图冒充；上一张/下一张顺序与榜单一致；键盘/触摸/浏览器返回正常；下载原件可被校验；含 EXIF 的原件上传页面展示元数据/GPS 隐私提醒。

**提交**：`feat: original-quality accessible photo viewer`。

### Phase 09 — 完整上传页、创建地点页与统一错误体验

**实施**：多选、拖拽、每图缩略预览、重选/移除、大小/类型提示、最多数量、单图进度/失败重试、批次总结；地点选择且不会传错；说明文本限长；创建成功跳转地点；空态、API 错误、网络失败、首屏加载、404 等统一风格；背景纸白/雾灰状态可选本地记忆（只存 UI 偏好，不存投票）。

**验收**：真实 1/10/30 图选择与拖拽，正确保存且每张归属对应地点；1 文件 25MiB 限制等参数使用实际合同，不一致由配置驱动；上传过程中按钮不可重复触发；断网有逐图失败重试；重复地点、无效文件输入均有清晰错误；刷新/重启后图片仍存在。

**提交**：`feat: complete multi-photo upload and place creation UX`。

### Phase 10 — 全栈测试、视觉回归、鲁棒性与性能

**实施**：按 `03-testing/TEST_STRATEGY.md` 和 `E2E_SCENARIOS.md` 逐项实现；Playwright 真正启动 built Next，独立 SQLite + 实盘 fixture；Chromium/Firefox/WebKit + mobile Chrome/WebKit；浏览器控件鼠标/键盘/触摸/上传文件；axe；截图 baseline；API fuzz/错误/并发；性能基线记录；CI artifact 产出 trace、截图、报告。

**验收**：P0 全部自动化用例通过；桌面与手机视觉截图由用户/负责人审定作为 baseline，后续不可随意更新；“原图字节不变”和“单访客一票”有独立可重复自动测试证据；`npm run check:all` 实际 exit code 0。

**提交**：`test: cover real browser flows and production invariants`。

### Phase 11 — Linux 发布工程、数据安全与恢复

**实施**：`next build` standalone、Nginx HTTPS + 上传/速率限制、systemd、仅本机端口监听、目录权限；SQLite migrations；独立持久存储目录；备份/验证/恢复脚本；滚动/停机迁移决策；日志健康探针；部署/回滚/升级 runbook； staging 环境配置。

**验收**：在**与生产相同或等效的 Linux staging** 环境完成冷启动、HTTPS（或测试证书）、图片上传/投票/重启保留、备份恢复校验、故障回滚演练；Nginx 限制超大请求有效；生产媒体不被版本替换覆盖；重启后完整数据不丢。

**提交**：`ops: add reproducible Linux deployment and recovery`。

### Phase 12 — 全量发行验收、文档与交接

**实施**：修复所有 P0/P1 阻塞、全量测试 + CI、静态安全审计、无效依赖检查、构建、Playwright 报告；填 `06-evidence/ACCEPTANCE_CHECKLIST.md`；写部署状态和手动上线步骤；操作录屏/截图证据和截图差异解释；写清尚未上线的原因（如缺域名、证书、服务器访问）。

**验收**：无 P0 blocker；所有必需脚本可复现；PR/Commit 对应测试记录完整；一份可以由另一个工程师按 runbook 在干净 Linux 主机部署的 release；如用户未授予服务器权限，最终状态必须写**上线就绪但尚未上线**，不能称“上线成功”。

**提交**：`docs: finalize release evidence and handoff`。

## F. 每个 Phase 必须写的进度模板

```md
## Phase XX — 名称
状态：PENDING / IN_PROGRESS / PASSED / BLOCKED
提交：<hash or not-committed>
改动：<具体文件/模块>
执行过的命令：<完整命令>
测试：<通过 N / 失败 M / 跳过 K>；报告路径
实际可验证的功能：<路由或 API / 测试证据>
风险/问题：<具体问题/根因/修复>
下一 Phase：<编号>
```

## G. “可上线”与“已经上线”必须区分

- **代码开发完**：完整功能已经实现。
- **本地验收完**：真实数据库/磁盘/Playwright 测试通过。
- **Staging 验收完**：Linux + Nginx + systemd + 备份恢复验证。
- **生产已上线**：域名/HTTPS/端口和实际服务器验证完成，由用户明确授权。

在缺少服务器权限时不得跨越最后状态；应交付可执行部署包和人工操作清单。

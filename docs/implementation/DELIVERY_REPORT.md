# ISLE V1.0 — 交付报告

**项目**：ISLE 屿集（以地点为中心的旅行照片榜）
**交付日期**：2026-10-19
**分支**：`main`　**Commit 数**：16

---

## 1. 项目状态

| 维度 | 状态 |
|---|---|
| 功能开发 | **DONE** |
| 本地真实全栈 E2E | **PASS**（144 单测 + 68 集成 + 478 E2E + 55 视觉，全绿） |
| Linux staging 演练 | **NOT_RUN**（本机为 Windows，无服务器/域名/证书） |
| 正式部署 | **READY_NOT_DEPLOYED** |
| 生产依赖审计 | `npm audit --omit=dev` → **0 vulnerabilities** |

**这不是「已上线」。** 代码、测试与部署脚本齐备，但没有在真实主机上运行过，因此不能声称上线成功。

---

## 2. 按阶段 Commit

| Phase | Commit | 主要更改 | Gate |
|---|---|---|---|
| 00 | `9cd2911` | 仓库/环境审计、风险登记、15 条 ADR | ✅ |
| 01 | `173bd11` | Next 15.5.28 + TS strict + Tailwind 4 + Prisma 6 + CI | ✅ |
| 02 | `4ca0fbb` | 数据模型、迁移、匿名身份、地点 CRUD | ✅ 68 集成 |
| 03 | `c01ed6c` | 原件不可变、内容寻址存储、派生缩略图 | ✅ 字节一致性 |
| 04 | `3e4ffc7` | 排序比较器、游标分页、原图/下载/预览 API | ✅ |
| 05 | `21425cf` | 事务化投票、幂等、并发防护 | ✅ 20 并发 |
| 06 | `b9bd092` `7b50bd8` | V4.1 样式表移植、摄影墙、七条路由、投票 UI | ✅ 摄影墙 20 单测 |
| 07 | `7b50bd8` | 实时重排、焦点保持、`aria-live` | ✅ |
| 08 | `f02c7a5` | 原图灯箱、深链、失败重试、隐私提示 | ✅ 13 E2E |
| 09 | `135a908` `2d1b762` | 上传页、创建地点页、404 与错误边界 | ✅ 16 E2E |
| 10 | `43d986e` `fed51f2` | axe 无障碍、11 张视觉基线、slug 健壮性 | ✅ |
| 11 | `785fd0a` | nginx/systemd/备份/恢复/对账/下架 CLI | ✅ 本地实测 |
| 12 | 本次 | 验收清单与交付报告 | ✅ |

---

## 3. 三条核心可验证结论

### ① 上传原件 SHA-256 一致性

```
SHA256(上传请求体) == DB.originalSha256 == 磁盘文件 == GET /original 响应体 == GET /download 响应体
```

- 集成测试：`tests/integration/photo-ingest.test.ts`
- E2E：`e2e/upload/photo-upload.spec.ts`（真实 multipart 上传后下载比对）
- `Content-Length` 与输入字节数逐项相等；PNG 保持 PNG（断言非 `RIFF` magic）
- 备份侧独立验证：7/7 原件通过；**翻转 1 字节 → `hash-mismatch` exit 2**；**删除文件 → `missing` exit 2**

### ② 匿名投票

- 状态机 9 种组合单测：`0→+1` 插入、`+1→0` 删除、`+1→-1` **-2**、`-1→+1` **+2** 等
- 20 个并发相同请求后 `Vote` 表**恰好 1 行**、`score` 恰好 +1
- 聚合值始终**从 Vote 表重算**，不是累加维护值
- 两个 context 各自投票，票态互不继承

### ③ 自适应摄影墙

- `bestPhotoRows()` 逐行移植自 V4.1，**20 个单测**钉死不变量
- 最重要的一条：**输入顺序 == 输出顺序**（0/1/2/3/4/5/7/20/50/100 张逐一断言）——重排即错误
- 同行等高；每张宽度严格等于自身真实比例（误差 <1e-6，不拉伸不裁切）
- `ResizeObserver` 驱动，1440→700→390 重排正确；≤760px 单列
- E2E 在真实浏览器逐张核对渲染比例与 `naturalWidth/naturalHeight`

---

## 4. 测试总表

| 类型 | 总数 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|---:|
| Unit | 144 | 144 | 0 | 0 |
| API Integration | 68 | 68 | 0 | 0 |
| E2E Chromium | 478* | ✓ | 0 | — |
| E2E Firefox | 478* | ✓ | 0 | — |
| E2E WebKit | 478* | ✓ | 0 | 2** |
| E2E Mobile Chrome | 478* | ✓ | 0 | — |
| E2E Mobile WebKit | 478* | ✓ | 0 | 2** |
| Visual Regression | 55 | 55 | 0 | 0 |
| Staging Smoke | — | — | — | **NOT_RUN** |

\* 五项目合跑总数。视觉用例在常规 E2E 中跳过（需独立数据集），故 478 含 55 跳过项中的 53。

\** 2 条 WebKit 焦点断言显式跳过，理由：Safari 在客户端路由后把焦点移回 `<body>` 且不归还，属浏览器行为。同文件另有每个引擎都跑的等价断言（焦点不被困住、触发元素仍可聚焦）。

---

## 5. 本次开发中发现并修复的真实缺陷

按影响排序，非按发现顺序：

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | 内容寻址 key 与 `originalKey @unique` 冲突 | **两个人传同一张照片会失败** |
| 2 | 灯箱 `isOpen` 由 `active` 推导，而 `index` 默认为 0 | **灯箱永久打开、盖住整页、吞掉所有点击** |
| 3 | 上传把活的 `FileList` 交给 state updater，又清空 input | **多选只剩最后一个文件** |
| 4 | V4.1 的 muted 色对比度 3.88:1、空状态 3.65:1 | **无障碍不达标** |
| 5 | 名字含数字生成裸数字 slug，"A 123" 与 "B 123" 抢同一 URL | **两个不同地点互相覆盖** |
| 6 | SQLite P2002 只报告一个字段，分类逻辑误判 | 并发建地点返回 **500 而非 409** |
| 7 | 灯箱重试只改 load token、未清失败标记 | **原图加载失败后永远无法恢复** |
| 8 | `router.replace` 覆盖历史条目 | **后退键离开网站而非关闭灯箱** |
| 9 | `go()` 在 state updater 内做副作用 | 每次方向键 push 两条历史 |
| 10 | `PhotoWall` 首帧用 1280px 兜底宽度 | **手机端瞬时横向滚动条** |
| 11 | 灯箱每次翻图走 Next 路由 | 快速点击与 RSC 重新拉取竞态 |
| 12 | 409 的 `details` 读错层级 | 重名时「跳到已有地点」的链接**永不出现** |
| 13 | 表单在 React 水合前提交 | **用户输入被静默丢弃** |

---

## 6. 已知限制与风险

| 级别 | 项 | 说明 |
|---|---|---|
| **P0** | **无** | 无未解决的阻断项 |
| **P1** | **无** | — |
| P2 | Node 22 vs 24 | 生产锁 22，本地在 24 开发；ABI 差异待 Linux CI 覆盖 |
| P2 | WebKit 焦点 | 平台行为，组件已重试；附每个引擎都跑的等价断言 |
| P2 | 视觉基线权威性 | 本地 Windows 基线；**Linux CI 基线才是最终版本** |
| P2 | Lighthouse / 磁盘满故障注入 | 未实机执行 |
| P2 | eslint 9 已 deprecated | `eslint-config-next` peer 限制；开发期工具 |

---

## 7. 是否具备公网开放的内容治理

**当前：`friends-only`（nginx Basic Auth），不具备公网开放条件。**

若要改为 `public`，必须先补：

- 匿名滥用举报入口
- 侵权/违法内容下架 SLA 与责任人
- 自动化滥用检测与封禁（当前只有按访客的速率限制：投票 120/分、建地点 3/日、照片 30/日）
- 隐私政策与 EXIF/GPS 告知的对外版本

V1 的定位是 5–15 人朋友内测，默认配置即为此。

---

## 8. 下一次人工操作

1. 提供域名、证书与服务器 SSH 权限
2. 确认 `SITE_ACCESS_MODE`
3. Linux 上跑一次完整 `npm run check:all`（验证 Node 22 + Linux ABI）
4. 在 staging 完成一次真实上传→投票→原图下载链路
5. 完成一次真实备份恢复演练
6. 生成并人工审定 Linux 视觉基线
7. 按 `docs/operations/OPERATIONS.md` §10 逐项打勾后上线

---

## 9. 交接文档

| 文档 | 内容 |
|---|---|
| `docs/implementation/BASELINE_AUDIT.md` | 环境审计与 V4.1 复核 |
| `docs/implementation/PROGRESS.md` | Phase 00–12 逐阶段记录 |
| `docs/implementation/DECISIONS.md` | 15 条 ADR |
| `docs/implementation/ACCEPTANCE_CHECKLIST.md` | 验收清单（实测） |
| `docs/operations/OPERATIONS.md` | 运维手册 |

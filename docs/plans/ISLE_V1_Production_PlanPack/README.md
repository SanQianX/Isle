# ISLE 屿集 — V1.0 生产级前后端开发 Plan Pack

> 交付日期：2026-10-19。用途：交给 MiniMax Agent，在实际项目仓库内分阶段实现、测试、上线准备。
> 这是一份**待执行的开发规格与验收方案**，不是声称已经开发/测试/部署完成。

## 最快开始（建议按顺序）

1. 将本目录复制到要开发的项目仓库下，例如 `docs/plan-packs/ISLE-V1/`。如果新项目尚未创建，将此目录作为任务输入，由 Agent 创建新 Next.js 项目。
2. 把 `05-agent/MINIMAX_START_PROMPT.md` **全部内容**发给 MiniMax Agent；执行提示词很短，细节只从 Plan Pack 读取。
3. Agent 首先执行 Phase 00 的环境和仓库审计，并输出 `docs/implementation/BASELINE_AUDIT.md`，不得直接修改已有参考 HTML。
4. Agent 按 `01-plan/MASTER_PLAN.md` 的 Phase 01 → Phase 12 执行，**每阶段独立 Git Commit，测试不通过不得推进**。
5. 最终交付：源码、DB migrations、测试、Playwright 报告、部署脚本、运维文档和填写完成的验收清单。

## 文件索引

| 文件 | 作用 |
|---|---|
| `00-reference/PRODUCT_REQUIREMENTS.md` | 原始产品需求（原文备份） |
| `00-reference/V4.1_REFERENCE_ONLY.html` | V4.1 视觉/交互参考（不可当成生产代码直接发布） |
| `00-reference/*reference.png` | V4.1 桌面、手机、等高不等宽摄影墙的布局参考 |
| `01-plan/MASTER_PLAN.md` | 项目范围、架构、12 阶段开发、每阶段验收与 Git 提交 |
| `02-contracts/DATA_API_STORAGE.md` | DB、API、上传、访客、投票、原图字节一致性完整约定 |
| `02-contracts/FRONTEND_UX.md` | 每个页面、组件、响应式、摄影墙、灯箱与交互规范 |
| `03-testing/TEST_STRATEGY.md` | 单元、集成、真实全栈 E2E、视觉回归、并发、性能与安全测试 |
| `03-testing/E2E_SCENARIOS.md` | 可机械执行的 Playwright 用例目录和操作步骤 |
| `04-deployment/DEPLOY_RUNBOOK.md` | Nginx、systemd、环境、部署、备份、恢复、回滚、监控 |
| `05-agent/MINIMAX_START_PROMPT.md` | 给 MiniMax 的短启动提示词 |
| `05-agent/MINIMAX_RESUME_PROMPT.md` | 中断后续跑提示词 |
| `06-evidence/ACCEPTANCE_CHECKLIST.md` | 最终 release gate 与证据文件清单 |

## 需求优先级 / 发生冲突时的裁决

1. `PRODUCT_REQUIREMENTS.md` 的**v1 产品行为与排除项**：地点 + 上传 + 投票 + 排名 + 原图灯箱，不引入账号/评论/搜索/地图/关注/后台 UI。
2. 本包的**安全、数据完整性、测试和部署约束**：原图不可变、服务端持久化、匿名标识、安全上传、真实 E2E。
3. V4.1 参考页面的**观感与交互**：暖纸白 / 冷雾灰、小面积海绿、简约、响应式、Justified Gallery。
4. 参考 HTML 中的演示逻辑（`localStorage`、外链样片、对象 URL、hash 导航）**不得当作生产实现**。

## 重要现实边界

- 匿名 cookie = 浏览器身份，不等于现实中每人唯一；删 cookie、换浏览器无法完全阻止重复参与。不做虚假的防刷保证。
- 原图必须 **原始字节不变**；`<img>` 通过 CSS 适应屏幕不等于改写图片文件。榜单允许缩略图。
- 兼容范围：首版接收 JPEG/PNG/WebP。HEIC/HEIF 的跨浏览器原图展示并不可靠：默认明确提示不支持，不可偷偷转换原始文件；如需支持须先通过增补验收方案。
- V4.1 的截图剪裁图和外链 Wikimedia 图片**仅供排版参考**，不能用于伪造用户上传的真实照片或直接发布生产。
- SQLite/Prisma 的未来 PostgreSQL 迁移**不只是换一个 URL**，还涉及 provider、SQL 方言与迁移文件；后端逻辑必须避免绑定 SQLite 专用细节。
- 首期面向 5–15 人可以无应用内账号，但公网写操作必须有合理的限流与上线访问策略；上线前确认使用 `friends-only` 网关还是 `public`。默认建议首发仅对朋友开放。

## 版本基线

- Next.js **15.5.28 或 15.5 分支当时更新的安全修补版**（2026-10-14 官方安全公告；不可使用旧 15.x 漏洞版本）。
- TypeScript、Tailwind CSS、Prisma **6.x 锁定兼容版本**、SQLite（WAL）、sharp、Vitest/RTL、Playwright Test、Node.js 22 LTS。
- Node 22、Prisma 6、Next 15 必须在 Linux CI 上进行完整安装与构建验证；如出现依赖不兼容，先分析升级/锁版方案并记录 ADR，不可通过跳过测试掩盖。
- 不要求 Docker。Linux + Nginx + systemd + 服务器本地磁盘。GitHub Actions 使用原生 Ubuntu runner。

参考文档：
- Next.js 2026-10 安全修复：https://nextjs.org/blog/nextjs-security-update-october-14-2026
- Next.js standalone：https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Playwright E2E：https://playwright.dev/docs/test-webserver
- Playwright CI：https://playwright.dev/docs/ci
- Prisma 6 migrate：https://www.prisma.io/docs/orm/v6/prisma-client/deployment/deploy-database-changes-with-prisma-migrate
- OWASP 上传安全：https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

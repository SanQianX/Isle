# ISLE V1.0 最终验收清单与真实证据登记表

> MiniMax 必须逐项填状态（`PASS / FAIL / BLOCKED / NOT_RUN`）和证据路径/命令。**本文件交付时所有项目默认未验证；不得根据本计划自称通过。**

## 1. 工程/仓库

- [ ] A-01 `BASELINE_AUDIT.md` 描述真实原型和源码现状。状态：NOT_RUN；证据：
- [ ] A-02 Next.js 15 使用已修补的安全版本、Node/Prisma 配套 lockfile。状态：NOT_RUN；证据：
- [ ] A-03 strict TypeScript、lint、format、构建在干净环境通过。状态：NOT_RUN；证据：
- [ ] A-04 无真实 `.env`、访客 token、上传图片、SQLite DB、敏感凭据入 Git。状态：NOT_RUN；证据：
- [ ] A-05 Phase 00–12 每阶段有 Commit、运行记录、测试数据和风险。状态：NOT_RUN；证据：

## 2. 产品功能

- [ ] F-01 默认桂山岛存在，支持创建新地点并持久化。状态：NOT_RUN；证据：
- [ ] F-02 访客由 HttpOnly cookie 标识，不同 context 独立。状态：NOT_RUN；证据：
- [ ] F-03 真实多图上传、单图进度/失败重试、说明持久化。状态：NOT_RUN；证据：
- [ ] F-04 票数 +1/-1/撤销/换票/幂等/并发正确。状态：NOT_RUN；证据：
- [ ] F-05 排序 `score desc, upCount desc, createdAt asc, id asc` 正确。状态：NOT_RUN；证据：
- [ ] F-06 首页 No.01、地点列表、完整榜单、上传与创建在手机/桌面可用。状态：NOT_RUN；证据：
- [ ] F-07 V4.1 式等高不等宽/原比例照片墙，无过大不合理空白。状态：NOT_RUN；证据：
- [ ] F-08 灯箱原图、上下张、1:1、说明/格式/尺寸、下载可用。状态：NOT_RUN；证据：
- [ ] F-09 原件二进制 `SHA256(upload) = SHA256(disk) = SHA256(download)`。状态：NOT_RUN；证据：
- [ ] F-10 重启、刷新、另一个浏览器中的照片、票数、地点仍正确。状态：NOT_RUN；证据：

## 3. 后端/持久化/安全

- [ ] B-01 Prisma migrations 在空库、旧版 staging 升级都能运行。状态：NOT_RUN；证据：
- [ ] B-02 SQLite 唯一约束/事务对抗并发写入。状态：NOT_RUN；证据：
- [ ] B-03 原件/预览分别保存；不经过 Next image optimizer 取原件。状态：NOT_RUN；证据：
- [ ] B-04 上传边界 MIME/签名/大小/像素/伪装/损坏等被实际拒绝。状态：NOT_RUN；证据：
- [ ] B-05 上传中断清理、不出脏 READY 记录，不泄露磁盘路径。状态：NOT_RUN；证据：
- [ ] B-06 同源写入校验、限流与错误码可验证。状态：NOT_RUN；证据：
- [ ] B-07 EXIF/GPS 隐私提醒；原件保留、预览去敏。状态：NOT_RUN；证据：
- [ ] B-08 不引入 v1 禁用的注册/评论/地图/管理 UI。状态：NOT_RUN；证据：

## 4. 自动化测试

- [ ] T-01 Vitest 核心算法/状态机/验证单元测试真实通过。状态：NOT_RUN；命令/报告：
- [ ] T-02 API/DB/磁盘集成测试真实通过。状态：NOT_RUN；命令/报告：
- [ ] T-03 真实 build + 本地 Next API + 独立 SQLite/media 启动测试。状态：NOT_RUN；命令/报告：
- [ ] T-04 Playwright Chromium 全流程无失败。状态：NOT_RUN；命令/报告：
- [ ] T-05 Playwright Firefox 全流程无失败。状态：NOT_RUN；命令/报告：
- [ ] T-06 Playwright WebKit 全流程无失败。状态：NOT_RUN；命令/报告：
- [ ] T-07 Playwright Mobile Chrome 关键交互无失败。状态：NOT_RUN；命令/报告：
- [ ] T-08 Playwright Mobile WebKit 关键交互无失败。状态：NOT_RUN；命令/报告：
- [ ] T-09 真实 UI 多图上传 → DB/磁盘验证 → 第二访客可见。状态：NOT_RUN；命令/报告：
- [ ] T-10 真实 UI 点赞/反对/撤销/重排、并发唯一票通过。状态：NOT_RUN；命令/报告：
- [ ] T-11 原图字节一致性、下载、EXIF 方向用例通过。状态：NOT_RUN；命令/报告：
- [ ] T-12 VR-01..12 图片基线人工审批、截图回归通过。状态：NOT_RUN；截图目录：
- [ ] T-13 axe 严重/高危无障碍问题已清零。状态：NOT_RUN；报告：
- [ ] T-14 API 异常/上传恶意/限流/写盘失败用例通过。状态：NOT_RUN；报告：
- [ ] T-15 CI 完整 `npm run check:all` Exit Code 0，报告能下载。状态：NOT_RUN；CI run URL：

## 5. 生产化与上线

- [ ] O-01 Linux 同 ABI 构建 standalone、static/public 资源齐全。状态：NOT_RUN；证据：
- [ ] O-02 Nginx HTTPS 反代、安全头、上传限制、写入限流测试通过。状态：NOT_RUN；证据：
- [ ] O-03 systemd 自动启动、单进程、端口本地监听、权限合理。状态：NOT_RUN；证据：
- [ ] O-04 SQLite 和 media 在 release 目录之外，版本切换/重启不丢失。状态：NOT_RUN；证据：
- [ ] O-05 一致备份生成、SHA 清单正确、从备份恢复到隔离环境成功。状态：NOT_RUN；证据：
- [ ] O-06 staging 使用 Playwright 完成上传/投票/原图下载整链路。状态：NOT_RUN；报告：
- [ ] O-07 staging 回滚演练成功，数据库迁移风险已处理。状态：NOT_RUN；报告：
- [ ] O-08 公网访问策略已确认（friends-only/public）及相关防滥用措施。状态：NOT_RUN；确认记录：
- [ ] O-09 生产域名/服务器/证书经授权后上线（否则标为 BLOCKED，不得假装）。状态：NOT_RUN；生产 smoke：

## 6. Bug 严重级别 / 阻断规则

- **P0 Blocker**：原件被改写或丢失、错票/重复票、跨地点图片混乱、未授权覆盖文件、无法重新部署、关键 E2E 失败、数据迁移或恢复丢数据。
- **P1**：用户主要流程失败（移动端传不了图、灯箱不能查看原图、无异常反馈、Justified 布局严重错乱、重要安全漏洞）。
- **P2**：非核心微观视觉问题、少量文案、不影响行为的小兼容性问题。

P0/P1 不得发布；P2 须记录 owner、可复现步骤、预计后续阶段（无账号阶段不能声称自动修复）。

## 7. 最终报告需包含（不能只说“全部成功”）

```text
项目：ISLE V1.0
Git branch: <...>
Commits: Phase00 <hash>, ..., Phase12 <hash>
Node/Next/Prisma/Playwright versions: <...>
Build: PASS/FAIL with log
Unit: N passed/M failed
Integration: N passed/M failed
E2E Chromium: N/M; Firefox: N/M; WebKit: N/M
E2E Mobile Chrome: N/M; Mobile WebKit: N/M
Visual baselines: N approved/N failed, diff paths
API/Upload/Original SHA tests: PASS/FAIL (具体文件 hash)
Backup/restore: PASS/FAIL with restored environment path
Staging: PASS/FAIL and environment
Production: DEPLOYED / READY_NOT_DEPLOYED / BLOCKED (真实状态)
Remaining P0/P1/P2: <lists>
Next manual steps: <domain, SSH, DNS, legal/abuse decision>
```

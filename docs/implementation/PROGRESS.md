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

**状态**：PENDING
**下一 Phase**：02

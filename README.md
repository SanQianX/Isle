# ISLE 屿集

> 以地点为中心的旅行照片榜单 —— 每一处风景，都值得被看见。

朋友们把在同一处拍下的照片传上来，为彼此投票，每一个地方因此有了自己的第一名。

**核心承诺：原图一字节不改。** 上传的原始文件按原样归档、可下载，列表页与灯箱只使用另存的缩略图，绝不经过会重新编码的图像优化器。

---

## 它能做什么

| | |
|---|---|
| **地点** | 地点档案与照片榜，桂山岛为默认地点 |
| **上传** | 拖拽或选择多张照片，每张 ≤ 25 MiB，JPEG / PNG / WebP，客户端并发 2 |
| **投票** | 一人一票，赞成 +1 / 反对 −1，再点一次即撤销，改票按差值计分 |
| **榜单** | 净票数 → 赞成数 → 上传时间 → id，四级排序键完全确定 |
| **原图** | 独立 URL 流出，支持 Range 与条件请求，可按原文件名下载 |
| **隐私** | 匿名访客身份仅存于 HttpOnly Cookie，服务端只留 SHA-256 |

**V1 明确不做**：注册登录、评论、关注、私信、地图、搜索、后台管理界面。

---

## 技术栈

- **Next.js 15.5.28**（App Router，standalone 输出）+ **React 19.1**
- **TypeScript 5.9** 严格模式 + **Tailwind CSS 4**
- **Prisma 6.19** + **SQLite**（WAL，`busy_timeout=5000`，`foreign_keys=ON`）
- **sharp 0.35** 生成 400 / 1200 两档 WebP 预览（原图不参与）
- **Vitest 4**（单元 + 集成）、**Playwright 1.64**（Chromium / Firefox / WebKit / 移动 Chrome / 移动 WebKit）
- **busboy 1.6** 流式解析 multipart，不把整张上传读进内存

部署目标是 **Linux + Nginx + systemd**，不依赖 Docker。

---

## 本地运行

```bash
npm ci
cp .env.example .env          # 填入绝对路径：DATABASE_URL / MEDIA_ROOT / UPLOAD_TMP_DIR
npx prisma migrate deploy
npm run build && npm start     # 生产构建；开发用 npm run dev
```

打开 http://127.0.0.1:3000 。

> `src/lib/config.ts` 会对环境变量做 Zod 校验：**缺任何一项就直接启动失败**，不会悄悄回退到项目目录下的 `dev.db`。

### 造点测试数据

```bash
npm run fixtures:generate      # 生成 tests/fixtures 下的媒体素材
ISLE_E2E=1 npx tsx scripts/seed.ts --e2e
```

---

## 测试

```bash
npm run lint          # ESLint
npm run typecheck     # tsc --noEmit
npm run test:unit     # Vitest 单元
npm run test:integration
npm run build
npm run test:e2e      # Playwright，真实 Next 服务 + 独立 SQLite + 隔离媒体目录
npm run test:visual   # 视觉回归（基线在 Linux CI 生成）
npm run check:all     # 以上全部
```

E2E **不使用任何 API mock**。每次运行都会建一个独立的临时目录、跑真实迁移、启动 `.next/standalone/server.js`（与 systemd 生产环境同一个产物），跑完即清理。

---

## 目录

```text
src/
  app/                 页面与 API 路由
  components/          shell / place / photo / lightbox / forms
  features/gallery/    等高不等宽摄影墙的动态规划算法
  server/              db / auth / services / storage / image
  lib/                 配置、错误契约、格式化
prisma/                schema 与迁移
deploy/                nginx 与 systemd 配置
scripts/               构建、备份、恢复、对账、下架 CLI
docs/implementation/   审计、进度、决策记录、验收清单
docs/operations/       运维手册
tests/ e2e/            单元、集成、端到端
```

---

## 运维

备份、恢复、回滚、监控与下架流程见 **[docs/operations/OPERATIONS.md](docs/operations/OPERATIONS.md)**。

一致性备份用 SQLite 的在线备份 API，并对每个原件做 SHA-256 校验；恢复**先校验再安装**，坏数据不会上线。

---

## 设计来源

界面与交互移植自 V4.1 视觉原型，**不是**把它的演示逻辑搬过来：原型的访客身份在 `localStorage`、上传用 `URL.createObjectURL()`、图片走外链，全部换成了服务端实现。

摄影墙的行高与列宽由动态规划算出（`src/features/gallery/best-photo-rows.ts`），保证**行内等高、每张宽度等于自身真实比例、顺序不变**——照片不会被裁切，也不会为了好看而重排名次。

---

## 已知限制

- 匿名 Cookie 只能标识**一个浏览器**，清除 Cookie 或换浏览器即换身份。这是浏览器身份模型的固有限制，不做虚假的一人一票承诺。
- 原件保留 EXIF，可能包含 GPS 等位置信息。预览图会剥离元数据，**原件不会**。
- 视觉回归基线在 Linux CI 生成；Windows 本地运行写入独立目录，因为字体栅格化存在平台差异。
- 本项目按单机单进程设计，SQLite 连接池固定为 1。

## 状态

功能与测试已完成，**尚未部署到生产环境**。上线所需的手工步骤见交付报告。

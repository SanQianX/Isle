# Linux 上线、发布、备份/恢复、回滚与安全 Runbook

> 目标：**单台 Linux 服务器，无 Docker**，Nginx → Next.js 15 Node standalone → SQLite + 本地图片目录。所有步骤必须先在 staging 演练，未经授权不接触用户真实服务器。

## 1. 环境与上线前置清单

生产机建议：Ubuntu 24.04 LTS 等受支持 Linux、2 vCPU / 4 GiB RAM 起步、按预计原图存储配足 SSD，公网 IPv4/6、域名、TLS 证书、Nginx、Node 22 LTS、sqlite3 工具、一个非 root 系统用户 `isle`。实际容量需根据照片上传上限、份数和备份策略估算，不能把示例配置当最终容量保证。

需要用户提供或在正式上线前确认的内容：

- 域名（例如 `photos.example.com`，仅示例）、DNS 管理权限和服务器 SSH 访问方式；**不要让 Agent 在仓库硬编码凭据**。
- 是否 `friends-only`（推荐首发 Nginx Basic Auth/受控入口）还是 `public`（需要更严格的匿名写入治理）。
- 预计磁盘容量、上传图片总量与增量；原图备份目的地/费用；数据下架联系机制。
- 邮件/IM 告警渠道可选（没有不应成为部署脚本失败的理由，需替代的日志告警方案）。

**禁止**：用 `next dev` 上线；把数据库/media 放 `public/` 或 Git 仓库；通过 SSH 用 root 运行站点；给用户写目录加 777；在 Windows 上打包 Linux native sharp 二进制并直接发布。

## 2. 目录布局 / 进程权限

```text
/opt/isle/
  current -> /opt/isle/releases/<version>/
  releases/<version>/server.js, .next/static/, public/
  builds/<source-sha>/       # 仅构建/迁移操作，安全清理旧版本
/etc/isle/isle.env           # 环境变量，root 持有、按需对 isle 可读
/var/lib/isle/db/isle.db     # SQLite 持久数据
/var/lib/isle/media/original/
/var/lib/isle/media/preview/
/var/lib/isle/tmp/
/var/log/isle/              # journalctl 可取代单独日志文件
/var/backups/isle/          # 应配置服务器外复制
```

- 版本更新**只替换 `/opt/isle/current` 指向**，不清理 `/var/lib/isle`。
- 仅 `isle` 系统账号可写 `/var/lib/isle`，不应暴露媒体路径给未经核验的公网 URL。
- 设置上传临时目录空间配额/剩余磁盘阈值（告警 80%/拒绝新上传 90% 是建议值）；上线前测实际执行逻辑。
- media 原件设计为不可变；线上滚动发布与备份不能覆盖原件。

## 3. 配置示例（提交 `.env.example`，**不提交 .env**）

```dotenv
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
PUBLIC_BASE_URL=https://photos.example.com
DATABASE_URL=file:/var/lib/isle/db/isle.db
MEDIA_ROOT=/var/lib/isle/media
UPLOAD_TMP_DIR=/var/lib/isle/tmp
MAX_UPLOAD_BYTES=26214400
MAX_UPLOAD_FILES=30
MAX_CONCURRENT_UPLOADS_PER_CLIENT=2
MAX_IMAGE_PIXELS=100000000
SITE_ACCESS_MODE=friends-only
# 如果部署公共可写入口，附加 rate limiting 与内容下架治理，不用此示例声称已防刷。
```

- 测试库和生产库配置必须完全隔离；`DATABASE_URL` 路径需经 Prisma CLI/运行时分别实际验证。
- 不要通过 `NEXT_PUBLIC_*` 泄露服务器路径、密钥或访问凭据。仅公开无敏感信息的站点标题/公开根 URL。
- `.env.example` 不存凭据；任何 Access Basic Auth hash 存 `/etc/nginx` 外部配置，不写仓库。
- 配置更改应有 schema/Zod 启动校验：缺少必需值就明确报错退出，绝不能 fallback 到项目目录默认 dev.db。

## 4. systemd 单进程服务示例

`/etc/systemd/system/isle.service`，部署 Agent 需按服务器真实 Node 位置调整 `ExecStart`：

```ini
[Unit]
Description=ISLE location photo ranking website
After=network.target

[Service]
Type=simple
User=isle
Group=isle
WorkingDirectory=/opt/isle/current
EnvironmentFile=/etc/isle/isle.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/isle
UMask=0077
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

确保 `node` 完全匹配 build/CI 版本；`HOSTNAME=127.0.0.1`，不使内部 Node 应用暴露公网端口。`systemctl daemon-reload && systemctl enable --now isle && systemctl status isle`。`systemctl restart isle` 后 DB/原件必须依旧存在。

## 5. Nginx 反代与上传/速率限制

**Nginx 配置应由 Agent 生成可直接部署的 `deploy/nginx/isle.conf` 与 http 级 `deploy/nginx/isle-limits.conf`，并通过 `nginx -t`。下方仅为结构性示例：**

`http` 级作用域：

```nginx
map $request_method $isle_write_key {
  default "";
  POST $binary_remote_addr;
  PUT  $binary_remote_addr;
}
limit_req_zone $isle_write_key zone=isle_writes:10m rate=2r/s;
```

`server` 级 HTTPS vhost：

```nginx
server {
  listen 443 ssl http2;
  server_name photos.example.com; # 换成真实域名
  # ssl_certificate /...; ssl_certificate_key /...; 由 certbot 或管理系统配置
  client_max_body_size 30m; # 单张 25MiB + multipart 开销

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy strict-origin-when-cross-origin always;
  add_header X-Frame-Options DENY always;
  add_header Strict-Transport-Security "max-age=31536000" always;

  location /api/ {
    limit_req zone=isle_writes burst=20 nodelay;
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 120s;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

说明：
- POST/PUT rate limiting 的 `$isle_write_key` 若为空不计入限流，保证读取预览时不会被 2r/s 限制误伤；仍需实际测试 nginx map 的行为。
- 另提供 HTTP → HTTPS redirect server；证书安装和续期 smoke；`client_max_body_size` 与后端大小限制一致；上传连接超时根据真实网络设定。
- 首发 `friends-only` 可在 HTTPS `server` 中通过 `auth_basic`/`auth_basic_user_file` 限定访问；缺少用户明确选择时**保守默认限制公网写入**。这属于服务器访问控制，不是网站注册登录。
- CSP 需要结合 Next.js SSR/RSC 的运行方式配置并在 WebKit/Chromium 验证，不应照搬 `script-src 'self'` 致使 hydration 被阻断；阶段验收须对安全 header 给出最终实际配置。
- 不得让 Nginx `alias` 直接把原始媒体目录公开映射到可猜路径；若后期优化大文件性能，可使用 `X-Accel-Redirect` 的 `internal` 位置，并保持服务端按 Photo ID 授权及响应头正确。
- `nginx -t`、HTTP/2、TLS、Upload 413、Rate 429、Media HEAD、Range 原图验证均需留实际测试记录。

## 6. Standalone 构建与版本发布（开发 agent 需实现 `scripts/deploy.sh`）

**前置**：CI 已通过所有测试；选择 Git commit SHA 作为 release ID，构建环境与生产同类 Linux ABI，适用 sharp/Prisma native 依赖。

推荐步骤：

1. 备份线上 DB+media，并执行 restore-check；确认磁盘容量和回滚版本存在。
2. 从指定 Git Commit checkout 到 `/opt/isle/builds/<sha>`，用 lockfile `npm ci`，`npx prisma generate`，`npm run build`，构建产物 `output:'standalone'`。
3. 将 `.next/standalone` **全部**复制到 `/opt/isle/releases/<sha>`；把 `.next/static` 复制到 `releases/<sha>/.next/static`，把 `public` 复制到 `releases/<sha>/public`。官方文档指出 standalone 不会默认复制 `public` 与 `.next/static`。
4. 用锁定的 Prisma 6 CLI 从已验证的 build/workspace 运行 `prisma migrate deploy`（不要用 `db push` 直接改生产）；**迁移前备份**。如果迁移可能不兼容旧版本，安排短暂停写并先在 staging 演练回滚，遵循 expand/contract；不要先迁移后发现旧代码不能回滚。
5. 健康检查新版本的 staging 或隔离实例，确认应用能读生产结构（不写正式数据）。原子调整 `current` symlink 到新 release 并 `systemctl restart isle`。
6. 用 curl/Playwright 做上线后的**无破坏 smoke**：HTTPS、首页、地点列表、榜单、图片访问、API health、静态资源、Nginx 安全头、部署版本号。
7. 保留最近 2–3 个通过的 release 和完整迁移记录；没通过立即按回滚预案处理。

**上线权限规则**：Agent 如果没有服务器/域名/证书权限，只写可执行脚本与 staging 模拟，不连接未知生产服务器。Release notes 必须明确“待部署”，不得写“已正式上线”。

## 7. 数据库迁移与回滚

- 开发创建迁移：Prisma 6 `migrate dev`，提交 `prisma/migrations`；生产使用 **同一个锁定版本**的 `migrate deploy`。
- 发布前 QA 测试将旧版本真实结构的备份还原到 staging，执行迁移，验证照片/投票/访客身份全部保留。
- 新版本与旧版本同时运行时的 schema 兼容性须明确：简单新增字段可兼容；删除/重命名/类型变更可能不可直接回滚。
- **回滚应用代码 ≠ 回滚数据库**；如果 schema 不兼容，应启动短暂停写，使用发布前一致性备份恢复 DB+Media 到同一时间点；先记录该回滚窗口是否会丢失窗口内新上传数据。
- 本项目单机 SQLite 不适合多实例同时读写不同副本；后续迁移 PostgreSQL 是独立任务，不只换 `DATABASE_URL`。

## 8. 备份、原图一致性和恢复演练

### 备份对象

`db/isle.db`（含位置、Visitor、Photo、Vote）与 `media/original/`、`media/preview/`、部署/迁移版本清单；**不能只备份 DB，也不能只备份图片。** 原图有不可恢复性，因此必须加远程异机副本。

### v1 可行的一致性备份策略

1. 小流量夜间采用**暂停写入**（如短时间只读维护或停止应用服务），等待进行中上传完成或中止并清理临时文件。
2. `sqlite3 /var/lib/isle/db/isle.db ".backup '/var/backups/isle/<ts>/isle.db'"` 生成一致 DB 备份；禁止直接复制在线单独的 `.db` 而忽略 WAL。
3. 同步原图与派生图到同一 `<ts>` 备份集，记录原图清单的 byteLength/SHA-256 与 DB 中 originalSha256 对齐。
4. 备份完成后解除维护；离线/异地备份加密并按保存周期滚动，保留至少每日+每周的合理历史层级，监控失败。
5. 数据量增加时可升级为在线 SQLite 快照 + 双轮 media 同步 + DB key manifest 验证，以减少写冻结时间；前期**先完成能真实恢复的简单方案**。

### 恢复演练（Release Gate）

```text
备份集 → 新隔离目录（非生产）
→ 校验原图 SHA 清单
→ 启动同版本应用连恢复 DB
→ Playwright 打开桂山岛榜单、查看大图、下载比对、投票测试
→ 记录 Place/Photo/Vote 行数、错误率、最后备份时间
```

至少每次首次上线和重要数据库迁移前后执行；之后建议每月演练一次。演练仅对隔离副本投票，不改变生产历史。

## 9. 发布后监控 / 数据治理

- `GET /api/health`: DB 可读、Storage 目录存在/权限；不公开绝对路径和凭据，返回 build sha/版本可选。
- `journalctl -u isle --since today` 能查看启动、请求错误、流量限制、上传失败、SQLite busy 等结构化日志，不记录访客完整 cookie 和图片地理定位 EXIF。
- `df -h` / 文件目录容量、备份新鲜度、HTTP 5xx、下载错误、CPU 内存、磁盘 IO 设告警；超过阈值限制上传并通知管理者。
- 反向代理访问日志保留周期与隐私要求配置；`SITE_ACCESS_MODE=public` 时必须追加侵权/违法内容下架流程和公开滥用处置。
- 媒体“永久归档”意为正常业务中不会因为重新生成预览而修改或删原图；侵权、违法、隐私撤回或安全事件下必须支持运维 CLI 封禁/下架/删除，执行前后做好审计。

## 10. 发布前必须有的实体文件

```text
next.config.ts (output:'standalone')
prisma/schema.prisma + prisma/migrations/
.env.example
deploy/nginx/isle.conf + isle-limits.conf
deploy/systemd/isle.service
scripts/deploy.sh
scripts/backup.sh
scripts/restore.sh
scripts/verify-media-hashes.sh
scripts/reconcile-storage.ts
scripts/seed.ts
scripts/run-e2e-isolated.mjs
.github/workflows/ci.yml
.github/workflows/staging-smoke.yml (无 staging 凭据时手动/禁用触发，不能失败闭环)
docs/operations/OPERATIONS.md
docs/implementation/PROGRESS.md
```

必须检查脚本幂等性、错误退出码、`set -e` 传播、权限/路径校验。敏感配置不能进入 Git。

## 11. 官方参考

- Next.js standalone：https://nextjs.org/docs/app/api-reference/config/next-config-js/output
- Prisma 6 production migrations：https://www.prisma.io/docs/orm/v6/prisma-client/deployment/deploy-database-changes-with-prisma-migrate
- OWASP File Upload：https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
- Playwright CI：https://playwright.dev/docs/ci
- Next.js 2026-10-14 漏洞更新：https://nextjs.org/blog/nextjs-security-update-october-14-2026

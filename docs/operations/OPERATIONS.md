# ISLE — 运维手册

面向已经拿到一台 Linux 服务器的人。按顺序读一遍，再动手。

> **当前状态**：`READY_NOT_DEPLOYED`。代码与测试已完成，**尚未部署到任何生产服务器**。
> 缺少域名、证书与 SSH 权限，因此 nginx / systemd / HTTPS / 恢复演练**未在真实主机上执行过**。
> 本文中的每条命令都标注了本地验证状态，未验证的明确写「未验证」。

---

## 1. 主机要求

| 项 | 建议 | 说明 |
|---|---|---|
| 系统 | Ubuntu 24.04 LTS | 未验证 |
| CPU / 内存 | 2 vCPU / 4 GiB 起 | 目标用户 5–15 人 |
| 磁盘 | 按原图总量 × 1.5（含备份副本）估算 | 原图**不压缩**，25 MiB 一张 |
| Node.js | **22 LTS** | 本地开发在 24.13.0 上完成，见 ADR-001 |
| 其他 | nginx、sqlite3、git、curl | `sqlite3` 用于一致性备份 |

```bash
sudo useradd --system --home /opt/isle --shell /usr/bin/false isle
sudo mkdir -p /opt/isle/{builds,releases} /var/lib/isle/{db,media,tmp} /var/backups/isle /etc/isle
sudo chown -R isle:isle /opt/isle /var/lib/isle
sudo chmod 700 /var/lib/isle /var/backups/isle
```

## 2. 目录布局

```text
/opt/isle/
  current -> releases/<sha>/     # 原子切换的符号链接
  releases/<sha>/                 # 每次发布的独立副本
  builds/<sha>/                   # 构建目录，可安全清理
/etc/isle/isle.env                # 环境变量，root 持有、isle 可读
/var/lib/isle/
  db/isle.db                      # SQLite，绝不放进发布目录
  media/original/<ab>/<sha256>.<ext>
  media/preview/{400,1200}/<ab>/<sha256>.webp
  tmp/                            # 上传临时空间
```

**切换版本只改 `current` 符号链接，永远不要动 `/var/lib/isle`。**

## 3. 环境变量

```bash
sudo install -m 640 -o root -g isle /dev/null /etc/isle/isle.env
sudo editor /etc/isle/isle.env
```

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
```

配置**缺任何一项都会直接启动失败**，不会回退到项目目录下的 `dev.db`（见 `src/lib/config.ts`）。

## 4. 首次部署

```bash
sudo cp deploy/systemd/isle.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable isle

# nginx
sudo cp deploy/nginx/isle-limits.conf /etc/nginx/conf.d/isle-limits.conf
sudo cp deploy/nginx/isle.conf       /etc/nginx/conf.d/isle.conf
sudo editor /etc/nginx/conf.d/isle.conf     # 改 server_name 与证书路径
sudo nginx -t && sudo systemctl reload nginx

# 访问控制（默认 friends-only）
sudo htpasswd -c /etc/nginx/isle.htpasswd friends

sudo /opt/isle/current/scripts/deploy.sh <git-sha>
```

`deploy.sh` 会自动：备份 → 从固定 commit 构建 → 组装 standalone → 执行迁移 → 切换 `current` → 重启 → 健康检查，失败时打印回滚命令。

> `deploy.sh` 只在 Linux 运行；非 Linux 会直接拒绝而不是部署一半。

## 5. 日常操作

```bash
sudo systemctl status isle
sudo journalctl -u isle -f
curl -s localhost:3000/api/health | jq .
sudo df -h /var/lib/isle          # 超过 90% 时新上传会被拒绝
sudo du -sh /var/backups/isle
```

## 6. 备份

```bash
sudo /opt/isle/current/scripts/backup.sh
```

做三件事：`sqlite3 .backup` 取**一致性**快照（不是 `cp` 一个正在写的 WAL 文件）→ 复制不可变的原件与预览 → 写 `MANIFEST.json`，记录每张原件的字节数与 SHA-256。

> 快照与媒体不一致时脚本**以非零码退出**，不会产出一个已知损坏的备份。

### 恢复演练（每次上线前、以及建议每月一次）

```bash
# 1. 只验证，不安装
sudo /opt/isle/current/scripts/restore.sh /var/backups/isle/<stamp>.tar.gz

# 2. 装到隔离目录，再启动同一版本的应用人工查看
sudo /opt/isle/current/scripts/restore.sh /var/backups/isle/<stamp>.tar.gz /srv/isle-restore
```

`restore.sh` **先校验再安装**。校验失败就不会让任何坏数据上线。

## 7. 回滚

```bash
sudo systemctl stop isle
sudo ln -sfn /opt/isle/releases/<上一个 sha> /opt/isle/current
sudo systemctl start isle
```

**回滚代码 ≠ 回滚数据库。** 若新版本的迁移不向后兼容，需要用发布前的备份恢复 DB 与媒体到同一时间点，并**明确记录这个窗口内丢失的上传**。迁移一律按 expand/contract 设计，使旧代码能继续跑在新 schema 上。

## 8. 监控与告警

| 指标 | 来源 | 阈值 |
|---|---|---|
| 服务存活 | `GET /api/health` | 连续 3 次非 200 |
| 磁盘水位 | `df /var/lib/isle` | 80% 告警 / 90% 拒绝新上传 |
| 备份新鲜度 | `/var/backups/isle` 最新文件时间 | > 26 小时 |
| 5xx 率 | nginx access log | > 1% |
| 429 数量 | nginx access log | 突增说明被刷 |
| 校验失败 | `write-media-manifest.mjs` 退出码 2 | 立即处理 |

```bash
sudo /opt/isle/current/scripts/verify-media-hashes.sh
```

## 9. 运维 CLI（下架与隐私撤回）

V1 没有后台界面，这是刻意的（`MASTER_PLAN` V1 禁止范围）。下架通过 CLI：

```bash
node scripts/moderate-photo.mjs hide <photoId> --reason "侵权下架"
node scripts/moderate-photo.mjs show <photoId>
node scripts/moderate-photo.mjs purge <photoId>     # 不可逆，仅用于法律要求
```

`hide` 之后该照片立即从榜单消失，且 `original` / `download` / `preview` 全部返回 404。

> **原件可能被多张照片共用**（内容寻址存储，见 ADR-015）。`purge` 前必须确认没有其他 Photo 引用同一个 `originalKey`，否则会连带删掉别人在用的原件。

## 10. 上线前必须人工确认

- [ ] 域名解析、证书签发与自动续期
- [ ] `SITE_ACCESS_MODE` 是 `friends-only` 还是 `public`——**公网开放需要另行验收滥用治理与下架流程**
- [ ] 备份恢复到隔离环境并人工看过照片与票数
- [ ] nginx `client_max_body_size` 与后端 `MAX_UPLOAD_BYTES` 一致
- [ ] 服务器在**服务器之外**还有一份备份副本

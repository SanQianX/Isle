# 数据、API、图片存储和业务规则契约

## 1. 领域模型（Prisma 6.x / SQLite 首版）

用下列模型作为实施起点，而不是生搬 demo 数据结构；实际生成的 `schema.prisma` 保持等价语义。

```prisma
model Place {
  id             String   @id @default(cuid())
  slug           String   @unique
  name           String
  normalizedName String   @unique
  region         String
  description    String   @default("")
  createdAt      DateTime @default(now())
  photos         Photo[]
}

model Visitor {
  id          String   @id @default(cuid())
  tokenHash   String   @unique
  displayCode String   @unique
  createdAt   DateTime @default(now())
  lastSeenAt  DateTime @default(now())
  photos      Photo[]
  votes       Vote[]
}

model Photo {
  id                   String   @id @default(cuid())
  placeId              String
  visitorId            String
  title                String
  description          String   @default("")
  originalKey          String   @unique
  preview400Key        String?
  preview1200Key       String?
  originalFileName     String
  originalMime         String
  originalByteLength   Int
  originalSha256       String
  width                Int
  height               Int
  status               String   @default("PROCESSING")
  uploadIdempotencyKey String?
  createdAt            DateTime @default(now())
  place                Place    @relation(fields: [placeId], references: [id])
  visitor              Visitor  @relation(fields: [visitorId], references: [id])
  votes                Vote[]
  @@index([placeId, status, createdAt])
  @@unique([visitorId, uploadIdempotencyKey])
}

model Vote {
  photoId   String
  visitorId String
  value     Int
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  photo     Photo    @relation(fields: [photoId], references: [id], onDelete: Cascade)
  visitor   Visitor  @relation(fields: [visitorId], references: [id], onDelete: Cascade)
  @@id([photoId, visitorId])
  @@index([photoId, value])
}
```

说明：
- Prisma/SQLite 的 `String` 数据字段需由 Zod 或服务层约束长度；Vote.value 只允许 -1 / +1，撤销票**删除记录**，不存 0。
- `status` 只能由服务层迁移 `PROCESSING → READY` 或 `FAILED/HIDDEN`；查询时仅显示 READY；管理员 CLI 可为滥用内容 HIDDEN，但 V1 不开发后台 UI。
- `uploadIdempotencyKey` 需随单文件提交、在同一访客维度唯一；若为空禁止进入保存流程。
- 原图 Key 一旦 READY 不能更新；禁止修改 originalSha256 和原始文件，更新预览允许重建但不得修改原件。
- 业务模型唯一身份 Visitor 在服务器端，与未来账号关联预留，但 V1 不建 User/Login。
- 创建地点名做 Unicode 规范化+空白归一，`normalizedName` 作为重名约束；slug 仅允许安全 ASCII。默认桂山岛 slug=`guishan-island`，新地点可使用带短 id 的稳定 slug，中文名不要拼接成不安全路径。
- SQLite 初始化为 WAL，busy_timeout≥5000ms，连接数受限，`foreign_keys=ON`；写并发在单机事务内处理。每次备份使用一致性快照，禁止直接拷贝在线 WAL 数据库主文件来声称备份完成。

## 2. 不可变业务规则

### 2.1 榜单比较器

```text
score = upCount - downCount
ORDER BY score DESC, upCount DESC, createdAt ASC, id ASC
rank 从 1 开始，按服务端返回列表位置赋值
```

如果 score 相等且点赞数相等，越早上传越靠前；同一 createdAt 时再用 id 提供完全确定的顺序。

### 2.2 投票状态机（PUT 绝对状态）

`PUT /api/photos/{photoId}/vote` body `{ "value": 1 | -1 | 0 }` 代表**投票完成后期望的状态**：

| 当前值 | 请求值 | DB 结果 | score 变化 |
|---|---:|---|---:|
| 0 | +1 | 新增赞成 | +1 |
| +1 | +1 | 不变（幂等） | 0 |
| +1 | 0 | 删除记录 | -1 |
| +1 | -1 | 更新为反对 | -2 |
| -1 | -1 | 不变（幂等） | 0 |
| -1 | 0 | 删除记录 | +1 |
| -1 | +1 | 更新为赞成 | +2 |

前端在**用户第二次点击已选按钮**时发送 `value=0`；换箭头发目标 ±1。后端永远不按“每收到请求就 +1/-1”执行。相同请求可安全重试。

原子事务：查询当前 vote + 写入/删除 + 聚合查询，数据库唯一约束承担最终防重。事务遇 SQLITE_BUSY 可有限重试并退避；冲突必须返回可重试错误，而不是丢票或静默叠加。多个浏览器上下文应有独立 Visit cookie。

### 2.3 访客标识

- 首次 `GET /api/visitor`：服务器生成至少 128 bit 随机 token（建议 256 bit），存数据库 `tokenHash=SHA256(token)`，只把随机原 token 作为 `__Host-isle_visitor` cookie，给出非身份信息展示码 `访客 #xxxxxx`。
- Cookie 设置 `HttpOnly`, `Secure`（HTTPS 正式环境）, `SameSite=Lax`, `Path=/`, 持续约 365 天；本机 http 开发环境仅允许显式的 Secure 测试特例。
- 绝不信任前端提交的 visitor ID / 作者编号 / score；所有相关字段由 server 读取 cookie 得到。cookie 无效 → 发新 token，旧票仍归旧身份，不试图关联真实个人。
- 永远不把 cookie token、哈希 token 和服务器绝对文件路径发送给公开 API。站内公开名称只是匿名访客码。
- 如有 Cross-Site 写入，拒绝 Origin 不匹配，默认不启用跨域 CORS；浏览器同源请求使用 cookie。
- 本机制**不能保证真人一人一票**，且匿名 Cookie 清除不可恢复；产品文档和部署说明中明确。

## 3. API 端点及输入输出

所有响应有类型化接口、错误码，服务端 Zod 校验并统一异常处理。HTTP 状态保留真实语义。

| Method | Path | 成功 | 核心契约 |
|---|---|---:|---|
| GET | `/api/health` | 200/503 | 健康检查，不暴露机密路径 |
| GET | `/api/visitor` | 200 | 访客 cookie 初始化/重用，返回 `{visitor:{displayCode}}` |
| GET | `/api/places` | 200 | 地点列表、照片数量、封面（最佳照片预览链接） |
| POST | `/api/places` | 201 | `{name,region,description?}`，由服务器生成 ID/slug |
| GET | `/api/places/:placeId` | 200 | 地点详情、计数、topPhoto |
| GET | `/api/places/:placeId/photos` | 200 | `?limit=40&cursor=...`，READY 照片、排名、分数、作者、当前访客票态、预览 URL |
| POST | `/api/places/:placeId/photos` | 201 | `multipart/form-data` **单张** + title?/description?/idempotencyKey，客户端多图上传=多次请求 |
| PUT | `/api/photos/:photoId/vote` | 200 | `{value:-1|0|1}`；服务端绝对状态、聚合结果 |
| GET | `/api/photos/:photoId/original` | 200/206 | 原文件精确字节流；支持 HEAD/Range 优先 |
| GET | `/api/photos/:photoId/download` | 200/206 | 原文件字节不变，附件下载头 |
| GET | `/api/photos/:photoId/preview/400` | 200 | 不裁切缩略图，独立存储 |
| GET | `/api/photos/:photoId/preview/1200` | 200 | 不裁切缩略图，独立存储 |

**实施细则**：
- `placeId` 建议是内部 ID；URL 用 `slug`，服务端解析为 ID。不要把用户任意字符串直接变成文件系统路径。
- `GET /api/places/:id/photos` 示例：

```json
{
  "placeId": "place-id",
  "items": [{
    "id": "photo-id", "title": "从云端经过桂山岛",
    "description": "", "rank": 1,
    "width": 4032, "height": 3024,
    "mime": "image/jpeg", "bytes": 5242880,
    "score": 12, "upCount": 13, "downCount": 1,
    "currentVisitorVote": 1,
    "uploader": { "displayCode": "a3f182" },
    "preview400Url": "/api/photos/photo-id/preview/400",
    "preview1200Url": "/api/photos/photo-id/preview/1200",
    "originalUrl": "/api/photos/photo-id/original",
    "downloadUrl": "/api/photos/photo-id/download",
    "createdAt": "2026-10-19T00:00:00.000Z"
  }],
  "nextCursor": null
}
```

- `PUT /vote` 返回：

```json
{
  "photoId": "photo-id", "currentVisitorVote": -1,
  "score": 10, "upCount": 12, "downCount": 2,
  "rankingMayHaveChanged": true
}
```

- 错误统一：

```json
{
  "error": { "code": "PHOTO_TOO_LARGE", "message": "单张照片不得超过 25 MiB" }
}
```

- 必须区分：`400 BAD_REQUEST`, `401 INVALID_VISITOR`（能否自动刷新身份依合同）, `403 INVALID_ORIGIN`, `404 NOT_FOUND`, `409 DUPLICATE_PLACE / DUPLICATE_UPLOAD`, `413 PHOTO_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `422 INVALID_IMAGE`, `429 RATE_LIMITED`, `500 INTERNAL_ERROR`, `503 STORAGE_UNAVAILABLE`。
- 幂等上传：同 `visitorId + idempotencyKey` 的成功重试应返回已存在照片信息（推荐 200），不再次写图；参数明显不同可 409。网络重复发送不能额外增加照片。
- 媒体 API：Content-Type 应与实质匹配，Content-Disposition 区分 `inline`/`attachment`；`X-Content-Type-Options: nosniff`；ETag 可由 SHA 派生；支持条件请求。原件 `Content-Length` 与数据库 bytes 相同，不能经过 Next 图片优化器。
- 带票态的 API 要使用 `Cache-Control: private, no-store`；匿名缓存容易泄露另一个访客已投状态。缩略图使用不可变内容地址后可安全长缓存；动态排行重新拉取。
- 稳定分页：纯静态数据下不得重复/跳过；投票实时重排导致已有 cursor 失效时可重新加载第一页，不承诺无限长榜单在投票期间完全快照一致。

## 4. 上传和图片处理的精确定义

### 4.1 格式/体积/数量（初始配置）

- `image/jpeg`、`image/png`、`image/webp`；扩展名和 MIME 不作为唯一依据，必须做签名字节检测和 sharp 解码/metadata 检查。
- **25 MiB / 文件**、**每次前端最多 30 张**、**同时最多 2 个上传请求**；限制作为集中配置并同步前端提示、Nginx、API 和自动测试。默认约束不是对 25MiB/30 的硬需求，如果真实图片规格需变更应改配置+同步测试记录。
- 每张图给出可理解的失败原因（大小、格式、像素、损坏、磁盘不足等）。空文件、非图片、伪装图片、恶意图片、超量、图像解码炸弹拒绝；建议像素预算不超过 100 MP，可根据实拍照片确认和调整。
- HEIC/HEIF：首版显式拒绝并解释跨浏览器原图直看限制；需要支持时另开 ADR：保留 HEIC 原件，浏览器不支持时预览派生图明确标识，但**不得声称派生图是原图**。

### 4.2 服务端处理顺序（严格）

1. 识别/签发访客身份，验证 Origin、权限、频率、地点是否存在、idempotencyKey。
2. 采用有大小/文件数量硬限制的流式 multipart 解析，**不应无上限 `await request.formData()` 将巨大文件全部缓冲进内存**。Node Route Handler + 受限 streaming parser（例如 busboy）即可。
3. 安全随机临时路径（服务器生成的 ID，绝不复用用户文件名），边接收边计算 SHA-256 与实际字节数，并强制停止超限流。
4. 验证文件签名、真实可解码性、元数据和像素预算，读取 EXIF Orientation，确定**展示方向一致的宽高**。
5. 用 `sharp` 从临时原件生成 400/1200px `fit:inside` 预览：**不能裁切、不能无意义放大**；预览默认不保留敏感 EXIF，原件原样保留。
6. `DiskStorage` 写入不可变 key 路径，采用临时写+`fsync`（按运行环境合理实现）+原子 rename；禁止覆盖现有文件。
7. 数据库创建 READY 照片（或 PROCESSING → READY），包含元数据和不可变 originalKey/hash；只有 READY 能公开查询。
8. 若失败，清理临时文件、可修复的半成品与数据库 PROCESSING 记录；设计 `scripts/reconcile-storage` 识别孤儿/缺文件以便修复，不得随意删除已归档的正常原件。
9. 最终返回照片对象；客户端单图进度汇总为批次成功 N、失败 M、重试按钮。

必须编写中途断开网络、磁盘写失败和 sharp 崩溃的集成测试；确认可见榜单永不暴露破损图片或不一致 status。

### 4.3 存储接口和路径

```ts
export interface Storage {
  putOriginal(key: string, source: AsyncIterable<Uint8Array>): Promise<{
    byteLength: number; sha256: string;
  }>;
  putDerivative(key: string, bytes: Uint8Array): Promise<void>;
  openReadStream(key: string, range?: { start: number; end?: number }): Promise<{
    stream: NodeJS.ReadableStream; size: number;
  }>;
  stat(key: string): Promise<{ size: number }>;
  removeTemporary(key: string): Promise<void>;
}
```

以上为语义合同，MiniMax 可以因 streaming parser 的实际 API 调整 TS 细节，不得破坏“原图不可变/路径不可注入”。建议物理路径：

```text
/var/lib/isle/
  db/isle.db                 # SQLite，永不放在 Git / Next public / release 包
  media/original/ab/<opaque-id>.<ext>
  media/preview/400/ab/<opaque-id>.webp
  media/preview/1200/ab/<opaque-id>.webp
  tmp/                      # 上传临时空间
```

`ab` 是服务器生成 ID 或 SHA 的前缀片段，不能接受用户输入 `../`。前端不得得到内部真实文件路径。

## 5. 安全、隐私与风控门槛

- 上传原图可能含 GPS、设备型号等 EXIF；上传前提示“原件会保留并可被下载，可能包含位置信息”，取得用户明确确认。预览可剥离 EXIF，但不能偷偷改原件。
- 严格限制文件类型、大小、像素和上传次数；服务端保证临时文件不会被执行，媒体放置在 webroot 之外；不允许 SVG/HTML/script 文件。
- 请求必须有服务端身份 cookie；防 CSRF Origin 核验；所有用户字符串服务端验证长度、前端按文字输出，不允许任意 HTML 注入。
- 默认 Nginx IP 级别限流和服务端访客配额：示例每访客每日创建地点 ≤3、照片上传 ≤30、每分钟投票请求 ≤120；超限提示可理解。可配置但不可无限制开放。
- 首期朋友内测，如部署在公网，优先用 `friends-only` 网关做访问边界（例如 Nginx Basic Auth）；不是站内注册功能。若要求“打开就能用”且全球开放，需追加公开匿名滥用治理/举报与下架流程的验收，否则不能宣称安全地开放给所有网民。
- 已发布图片默认不在 UI 提供删除；为侵权、违法内容或隐私撤回保留**运维 CLI** 的 HIDDEN/下架操作，不能用“永久归档”作为拒绝合法删除的借口。
- 磁盘容量、水位、非法媒体、访问量、429/5xx 必须有日志和运维阈值。

## 6. 重点集成断言（强制）

1. `sha256(inputFile) === sha256(GET /api/photos/:id/original body) === DB.originalSha256`。
2. `Content-Length(original) === inputFile.size`。
3. `width/height` 符合 EXIF Orientation 处理后的显示比例，所有缩略图与原始画面没有裁切。
4. `Vote` 中 `(photoId, visitorId)` 只能有 0 或 1 行，永远不会出现 value=0。
5. `score === SUM(Vote.value)`，`upCount/downCount` 与 Vote 表一致；前端不自行保存权威分数。
6. `READY` 对应原件、两张预览都存在；强制写盘失败后不出现坏图上榜。
7. 客户端一次传多张时即使中途一张失败，其它成功张数与磁盘/数据库一一对应。

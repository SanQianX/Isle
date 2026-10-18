# Playwright 真实浏览器操作场景清单（可逐条机械实现）

> 每一场景必须有**UI 操作步骤 + 浏览器断言 + 后端/数据断言**。UI 页面不能只用 `page.evaluate()` 直接调用业务函数来冒充点击。断言时间依赖应使用 `expect(...).toBeVisible()` 等自动等待，不使用 `sleep(3000)`。

## 一、测试项目/夹具使用规则

- 每个用例在干净隔离库运行，或通过独立 `testRunId`/地点/照片隔离以免互相污染；执行顺序不应影响成功率。
- Desktop Chromium、Firefox、WebKit 覆盖 P0 主流程；Mobile Chrome 与 WebKit 重点跑触控、上传、灯箱和 overflow；视觉快照在稳定项目配置执行。
- 使用 `browser.newContext()` 生成访客 A、访客 B。单独 `context.request` 或 testing DB helper 校验持久层，只用于**结果核验**而不是绕过 UI 操作。
- 关键 CSS/DOM 定位增加最少一组稳定测试 ID：`photo-card-{id}`、`photo-score-{id}`、`vote-up-{id}`、`vote-down-{id}`、`photo-wall`、`lightbox-original-image`、`upload-row-{file-key}`、`upload-summary`。页面导航和按钮优先 `getByRole()`。
- 所有 `@smoke` 用例在 staging 也要能使用隔离测试域的数据执行。

## 二、P0 Happy Path 必须覆盖的完整真实动作

| ID | Playwright 用户操作 | 浏览器断言 | 服务端/持久化断言 |
|---|---|---|---|
| HP-01 @smoke | context A 打开 `/` → 点击桂山岛 → 完整榜单 | 正确标题、名次、票数和缩略图 | `/api/places` `/photos` 真实返回 |
| HP-02 @smoke | 点某图 ↑ → 再点 ↑ → 点 ↓ → 再点 ↑ | 分数和高亮每次正确，榜单可重排 | 单访客 vote 状态依次 `+1,0,-1,+1`，没有重复行 |
| HP-03 @smoke | 点图 → 查看大图 → 下一张 → 返回 → 下载 → 关闭 | 灯箱黑底、顺序、文件信息、按钮正确 | 请求原始路由，下载 hash 与原件完全一样 |
| HP-04 @smoke | 点击“我也拍过这里” → 选择横、竖、方 3 张 → 输入说明 → 确认原件提醒 → 开始上传 | 展示每图进度、3 张成功、跳转榜单 | 新增 3 Photo READY，生成预览、磁盘真实存在 |
| HP-05 @smoke | 第二访客 B 新建 context → 打开同地点榜单 → 给 A 上传的图投票 | B 能看到图片；A/B 选中态各自不同 | 两个 Visitor、各自 Vote 正确，聚合 score 正确 |
| HP-06 @smoke | 页面刷新 → 浏览器关闭/重新打开（沿用 storageState）→ 服务重启后访问 | 投票、地点、图片还在；缩略和灯箱可访问 | SQLite 和原始文件持久完整 |

## 三、导航与路由（NAV）

| ID | 操作 | 通过条件 |
|---|---|---|
| NAV-01 | 打开首页，点击 Logo/导航/“完整榜单” | URL 对应 `/`、`/places`、`/places/guishan-island/ranking`，无 hash 伪路由 |
| NAV-02 | 地址栏直接输入 `/places/guishan-island/ranking` | 首屏可独立加载真实图片，不能先访问首页才可用 |
| NAV-03 | `?photo=<id>` 深链打开，按 Esc 关闭 | 灯箱关闭、URL query 消失；浏览器后退/前进行为一致 |
| NAV-04 | 输入不存在的 place slug、非法 photo id | 404 页面或清楚“不存在”的错误，服务不 crash |
| NAV-05 | 切换到另一个新地点 | 榜单/上传属地正确，不混入桂山岛图片 |
| NAV-06 | 浏览器后退/前进、刷新 3 次 | 页面状态/路由与数据稳定，无重复请求造成二次写入 |
| NAV-07 | 页面加 query、中文地点名、长标题 | 不崩溃、用户内容显示为纯文本，URL 安全 |

## 四、匿名身份（ID）

| ID | 操作 | 通过条件 |
|---|---|---|
| ID-01 | 首次打开，访问 `/api/visitor` | 返回唯一访客码，设置 HttpOnly/SameSite cookie，未泄露 token |
| ID-02 | 刷新+关闭页面（同 context） | 访客码不变，已投票态不变 |
| ID-03 | 新 browserContext（无共享 cookie） | 访客码不同，不会继承另一人的 vote |
| ID-04 | 手动篡改 cookie token | 服务端拒绝旧 token/重新签发，无法冒充 A 的已有 vote |
| ID-05 | 无 cookie 直接调用投票/上传 API | 由服务端一致的身份初始化或受控拒绝，不得使用前端伪造 visitorId |

## 五、地点创建（PLACE）

| ID | 操作 | 通过条件 |
|---|---|---|
| PLACE-01 | “发现地点” → “添加地点” → 创建“海陵岛” | 成功跳转新地点，显示真实空态，重启后存在 |
| PLACE-02 | 输入空名字后提交 | 中文验证错误，不发送有效创建请求 |
| PLACE-03 | 在另一个 Context 新建相同规范化名称 | 返回 409 或跳已有地点，不产生重复地点 |
| PLACE-04 | 输入中文、空格、HTML 字符串及超长字符串 | 规范化、限制长度、不执行 HTML，不出现 XSS |
| PLACE-05 | 两个 Context 同时创建同名地点 | DB 唯一约束保证只有 1 条记录，第二个得到冲突提示 |

## 六、多图上传（UPLOAD）

| ID | 操作 | 通过条件 |
|---|---|---|
| UP-01 | 文件框一次选择 3 图（横/竖/方） | 每张显示比例、文件名、大小，不裁切预览 |
| UP-02 | 原生拖拽 3 图进入 dropzone（模拟 DataTransfer drop） | 文件加入队列；拖拽高亮/解除正确 |
| UP-03 | 两次分别选 2 张+1 张 | 队列总 3 张、不意外覆盖第一批 |
| UP-04 | 队列移除第二张 → 上传 | 服务端仅新增其余 2 张 |
| UP-05 | 10 张上传，设置并发上限=2 | 服务端最终 10 READY，进度与并发限制可证明 |
| UP-06 | 上传 30 张允许，第 31 张被明确拒绝 | 前后端限制一致，无隐藏截断导致误报成功 |
| UP-07 | 选 >25 MiB 文件 | UI/服务端阻止，API 413，不写文件或 READY 记录 |
| UP-08 | 伪装 jpg 的 txt、损坏 JPEG、SVG | 服务端拒绝 `415/422`，不能只依赖前端 file.accept |
| UP-09 | 混合 2 合法+1 损坏图 | 2 成功、1 失败清楚显示，重试不重复上传成功 2 张 |
| UP-10 | 断网/中止单张请求 → 恢复连接并重试 | 不出现半成品 READY，后续成功也不重复 2 张 |
| UP-11 | 相同 idempotencyKey 的成功请求重放 | Photo 总数只 +1，原件只有一份 |
| UP-12 | 上传后刷新、重启、另一访客打开 | 照片和说明持久；排名和作者正确 |
| UP-13 | 上传带 Orientation=6 EXIF 的竖拍图 | 页面按正确视觉方向排列，原件 hash 不变 |
| UP-14 | 上传带 GPS EXIF 的 JPEG | 提交前出现可理解警示；原件 GPS 仍存在、预览 GPS 被去除 |
| UP-15 | 上传到海陵岛后回桂山岛 | 海陵岛有新图，桂山岛不会出现错误图 |
| UP-16 | 在提交中双击上传按钮 | 无重复结果；并发限制/禁用态生效 |

## 七、投票与真实排行（VOTE）

| ID | 操作 | 通过条件 |
|---|---|---|
| VOTE-01 | A 点击 ↑ | score +1、A 按钮 `aria-pressed=true`，Vote 表值 1 |
| VOTE-02 | A 再点 ↑ | score -1 回到原分、Vote 行删除 |
| VOTE-03 | A 先 ↑，再 ↓ | score 净 -2、单行 Vote=-1，不会同时保留赞/反两行 |
| VOTE-04 | A 先 ↓，再 ↑ | score 净 +2，单行 Vote=+1 |
| VOTE-05 | A 重复发送目标 `value=1` 同 API 两次 | 幂等，score 只增加 1 |
| VOTE-06 | A/B 两个 context 给同一图投不同票 | 两个独立 vote，总分相减正确，各端按钮高亮不同 |
| VOTE-07 | A/B/C 让第二名得分超过第一名 | 榜单第一名切换；地点 Hero 更新；名次不重复 |
| VOTE-08 | 两图同分但点赞数不同 | 赞成票多者更靠前 |
| VOTE-09 | 两图同分同赞成，创建时间不同 | 更早上传者靠前 |
| VOTE-10 | 同分同赞成同时间（固定测试时钟） | 最后按 id 稳定排序，无页面抖动 |
| VOTE-11 | 同一访客快速并发写入 20 次（含 UI 重复点） | DB unique 约束始终 0/1 行，分数不是 20；无未捕获错误 |
| VOTE-12 | API 注入 `value=5`、字符串、空 body、跨域 Origin | 400/403；数据库不变 |
| VOTE-13 | 投票时模拟 500/断网（只注入故障） | UI 恢复正确分数/选中态，用户看见失败原因 |
| VOTE-14 | 在灯箱投票 → 关闭返回榜单 | 主榜和灯箱票态一致，后端总数一致 |

## 八、原图灯箱与下载（LB）

| ID | 操作 | 通过条件 |
|---|---|---|
| LB-01 | 点击榜单任一缩略图 | 全屏灯箱打开，实际 GET URL 包含 `/original` |
| LB-02 | 比较 `/original` bytes 与上传原件的 sha256/大小/MIME | 三者严格一致，没有 Next.js 自带 `_next/image` 重编码 |
| LB-03 | 下载原图再计算 SHA256 | 下载响应字节和输入 fixture 完全一致，文件名安全 |
| LB-04 | 点击“下一张/上一张” | 名次和照片序列与当时榜单一致；边界按设计循环 |
| LB-05 | 按键盘 `ArrowLeft`、`ArrowRight`、`Escape` | 左右切图、Esc 关闭，并恢复背景滚动/焦点 |
| LB-06 | iPhone WebKit 在非 1:1 状态左右轻扫 | 可以切图，页面不会随手势产生横向 overflow |
| LB-07 | 进入 1:1 后拖拽/平移，点击“适应屏幕” | 显示自然像素的放大/缩小状态，切换图后恢复预期 |
| LB-08 | 展开“图片信息” | 显示真实像素、格式、大小、访客、描述和下载入口 |
| LB-09 | 查看竖图 / 超宽图 | 无裁切，图像完整，保留自然方向比例 |
| LB-10 | 图片请求失败/网络断开 | 有重试/错误态，不用缩略图冒充原件 |
| LB-11 | 使用 `?photo=...` 深链另开新 Context | 直接进入指定图片灯箱，关闭后回页面 |
| LB-12 | image 原图 GET `Range: bytes=0-99` | 服务端返回 206 和准确 100 字节，或经文档明确的可接受策略；不更改原件 |

## 九、Justified Gallery 与移动端（GALLERY / MOBILE）

| ID | 操作 | 通过条件 |
|---|---|---|
| G-01 | 1440px 横/竖/横三图 | 同行等高、宽度不同，所有图片完整，无显著死白区 |
| G-02 | 1/2/3/20/100 图切换 | 不卡死、不会无限重排、不丢图片和 rank |
| G-03 | `320 → 1440 → 768 → 390` 调整 viewport | ResizeObserver 重排，没有横向溢出和重叠 |
| G-04 | 390px / 360px 窄手机 | 单列，竖图不把其它照片推成难用的碎小卡片 |
| G-05 | 混合 0.2、0.5、1.0、2.5、5.0 的 w/h | 能合理退化但不裁切、不反转排名 |
| G-06 | 投票导致排名重排 | 有稳定 key、不丢当前访问状态、无整页强制滚顶 |
| G-07 | 故意让某张缩略加载失败 | fallback 明确，布局仍保留该图宽高比，不塌陷 |
| G-08 | 横竖屏旋转（Playwright viewport/device） | 排版重新计算、按钮仍可点 |
| G-09 | 标签、说明超长 + 中文英数混排 | 不截断主要信息导致不可读，单张不撑爆一行 |
| M-01 | 手机上 `tap` 赞/反、上下滚动 | 触控目标大小合规，没有误触遮挡 |
| M-02 | 手机 UI 上传 3 张 | 可操作，无底部键盘覆盖提交按钮 |
| M-03 | 手机灯箱 Swipe + 关闭 | 焦点/滚动、安全区/浏览器可交互 |

## 十、负面安全/容错（SEC）

| ID | 操作 | 通过条件 |
|---|---|---|
| SEC-01 | 上传路径名 `../../x` / 非法字符 | 服务端改安全文件名，不能覆盖站点/DB 文件 |
| SEC-02 | 上传伪造 Content-Type（HTML、SVG） | 415/422，不保存可执行内容 |
| SEC-03 | 超大请求/像素炸弹 | 413/422、服务进程继续健康、临时文件被清理 |
| SEC-04 | 创建地点 XSS 字符串 | 文本正常转义，未执行 script |
| SEC-05 | 无效 Origin 请求 PUT/POST | 403，数据不变 |
| SEC-06 | 高频投票/上传/创建地点触发限流 | 429，有 Retry-After 或等价可理解提示 |
| SEC-07 | 原图 URL 穿越/非法 ID | 404/400，不泄露服务器绝对路径 |
| SEC-08 | 原图和下载只用允许 MIME + nosniff | 响应头安全；图片真实字节匹配 |
| SEC-09 | 模拟磁盘已满/不可写 | 服务端 503 或可恢复失败，UI 有反馈，原件不损坏 |
| SEC-10 | 后台移除/隐藏违规照片 CLI | 榜单和原件访问依据策略失效；不需要后台 UI |

## 十一、可访问性与视觉（A11Y / VR）

| ID | 操作 | 通过条件 |
|---|---|---|
| A11Y-01 | Tab 全站按钮、输入框 | 可见焦点，没有无法键盘触达的交互 |
| A11Y-02 | 投票按钮 aria-pressed | 视觉状态与辅助技术状态一致 |
| A11Y-03 | 灯箱打开/关闭键盘行为 | 焦点限制在灯箱内、关闭回到触发元素 |
| A11Y-04 | 自动 axe 扫描首页、地点、榜单、上传、灯箱 | 无 critical/serious，记录可接受的剩余问题 |
| VR-01..12 | 执行 TEST_STRATEGY 视觉 baseline 列表 | 稳定截图没有未审批变更；失败有差异图 |

## 十二、服务器/staging E2E（OPS）

| ID | 操作 | 通过条件 |
|---|---|---|
| OPS-01 | Linux staging 编译并启动 systemd | Nginx 能代理，Node 只监听 127.0.0.1，健康检查 200 |
| OPS-02 | Playwright 从 staging 域名上传 → 投票 → 下载 | 完整真实 API 链路跨反向代理成功，原件 SHA 一致 |
| OPS-03 | staging 服务重启 | 地点、照片、票数不丢失，磁盘和 DB 位于 releases 之外 |
| OPS-04 | staging DB/Media 一致性备份 → 恢复到新隔离实例 | SHA + rowcounts 完全相符，新环境可浏览投票 |
| OPS-05 | 引入破坏性回归模拟 → 回滚至上版构建 | 旧版服务可恢复；若 schema 变更不兼容，遵循有验证的 DB restore/expand-contract，而非强行运行旧代码 |
| OPS-06 | nginx body 25MiB/30MiB 限额测试 | 单张正常上传，超限被拒且用户能看见正确提示 |
| OPS-07 | HTTPS/security headers/证书/同源 cookie | 正确配置，无无限制跨域 |

## 十三、测试覆盖与 P0 发布门禁

**发布阻断**：HP-01..06、UP-01/05/08/09/12、VOTE-01..09/11、LB-01..06、G-01..05、SEC-01..05、OPS-01..04 中任何失败都不能标为 V1 release-ready。其它条目如不能按期实现，必须写清技术缺口并获得用户批准，不能静默删除。

**结果报告建议格式**：

```md
# ISLE E2E Test Report
Commit: <hash>; Next/Node/Prisma/Playwright: <versions>
运行日期、OS、项目：chromium/firefox/webkit/mobile-chrome/mobile-webkit
真实后端: Yes; isolated SQLite: <temp path>; isolated media: <temp path>
用例：Total N / Passed P / Failed F / Skipped S
浏览器控制台错误：N；HTTP 5xx：N
原图 SHA 用例：PASS/FAIL；一图一票并发：PASS/FAIL
截图差异：approved N / unapproved N；Trace HTML: <path>
未解决问题：<具体>
```

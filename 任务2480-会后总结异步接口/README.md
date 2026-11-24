# 会后总结异步生成接口（可运行演示）

一个可运行的异步会后总结服务：预处理 → 分段 map（信号量并发 ≤ 4）→ 超过 20 段时分层 reduce → 系统写入 `speaker_legend` 与 `confidentiality` → 通用草稿管线 → 仅进入 L1 复核队列。段结果按「段文本 SHA-256 + 模板版本」缓存 24 小时；失败段可单独重跑。所有会议数据均为**虚构合成数据**，无外发、不计算金额。

源码与交付目录：本地目录（无 git 初始化/推送）。

## 1. 技术栈与运行

- Node 22 + Express 4；React 18 + Vite 6 演示前端；Playwright 测试复用系统 Edge（`channel: 'msedge'`，不下载 Chromium）。
- 无新增第三方依赖：信号量、缓存、multipart 解析、分层汇总均用 Node 内置能力实现。

```bash
npm install
npm run build          # 构建 React/Vite 演示到 dist/
npm test               # 6 个流水线用例 + 6 个流程/契约/UI 用例
npm run dev:all        # Mock API(3001) + Vite(5173)，打开 http://localhost:5173
docker compose up --build   # 演示台 4173，API 3001
```

`npm run build && node server.js` 可在单机模拟容器一体化启动（4173 承载前端，`/api` 代理到 3001）。

## 2. 文件清单

| 路径 | 作用 |
| --- | --- |
| `mock-server/index.js` | 服务主体：端点、multipart 解析、信号量、TTL 缓存、mock map/reduce、分层汇总、复核队列、指标 |
| `server.js` | 容器一体化启动器（API + 静态演示） |
| `src/`, `index.html`, `vite.config.js` | React 18 + Vite 6 演示界面 |
| `tests/async.test.js` | 四项验收断言 + 附加约束用例 |
| `tests/flow.spec.js` | 交付文件校验、投标格式、API 契约与 UI 流程 |
| `playwright.config.js` | 测试配置（系统 Edge，webServer 自动拉起） |
| `Dockerfile`, `docker-compose.yml` | 容器打包与一键启动 |
| `README.md`, `验证记录.md`, `投标文本.txt` | 说明、真实命令输出、投标文本 |

## 3. API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/ops/meeting-summaries/generate` | multipart：`text` 或 `file`，以及 `meeting_meta`（title/type/date(nullable)/event_id(nullable)/attendee_roles）；返回 202 与 `job_id` |
| GET | `/api/v1/ops/jobs/{job_id}` | 进度：`phase`、`map_done`、`map_total`、`failed_segments`、`error_code` |
| POST | `/api/v1/ops/jobs/{job_id}/retry` | 仅重跑失败段；成功段走缓存；非 failed 状态返回 409 |
| GET | `/api/v1/review-queue` | 仅 L1 复核草稿（不外发） |
| GET | `/api/v1/ops/metrics` | map/reduce 调用记录、并发峰值与缓存统计（供断言） |
| GET | `/api/v1/observability/outbound` | 外发计数器，设计上恒为 0 |
| GET | `/api/v1/meta` `/api/v1/openapi.json` | 管线参数与 OpenAPI 3.0 文档 |
| POST | `/api/v1/test/reset` `/api/v1/test/config` | 测试用：重置内存状态、设置 map 延迟与失败段号 |

`phase` 取值：`preprocess` → `map` → `reduce` → `drafted`，失败为 `failed`。失败时 `error_code = MAP_SEGMENT_FAILED`，`failed_segments` 为 1 起始的段号数组。

## 4. 设计要点

**分段 map 与并发**：`mock-server/index.js` 中的 `Semaphore` 用 FIFO 等待队列实现，上限 4。每段一次逻辑调用，内部最多 3 次尝试（1 次调用 + 2 次网关重试）；失败段耗尽尝试后返回 `ok:false`，整单标记 `failed`。metrics 记录每次逻辑调用、尝试次数与并发峰值，测试据此断言并发不超过 4。

**分层汇总**：段数 > 20 时按每 10 段一组做局部 `ops.meeting.reduce`，再对局部摘要做 1 次最终 reduce。25 段得到 3 次局部 + 1 次最终（分组大小 10/10/5，最终输入 3）。20 段及以下跳过 reduce，直接拼接段摘要。

**缓存**：key = `SHA-256(段文本) + "|" + TEMPLATE_VERSION`，TTL 24 小时；`cacheGet`/`cacheSet` 用 Map 模拟 Redis 的 `GET`/`SET EX`，过期即删除。生成与重跑都先查缓存，因此重跑只调用失败段，其余 29 段命中缓存。

**系统信封与复核隔离**：`speaker_legend` 由参会角色生成，`confidentiality` 由会议类型推导，二者随草稿一起写入 `review_queue`，状态 `pending_review`、级别 `L1`。服务没有外发通道，外发计数器恒为 0；草稿 `amount` 恒为 null，不参与任何金额计算。

## 5. 验收对照

| # | 验收点 | 实现位置 | 自动化测试 |
| --- | --- | --- | --- |
| 1 | 30 段生成时并发段调用 ≤ 4 | `Semaphore` + `runMapPhase` | `30 segments: concurrent segment calls stay at or below the semaphore limit` |
| 2 | 25 段触发 3 次局部 + 1 次最终汇总 | `buildSummary` / `mockOpsMeetingReduce` | `25 segments trigger hierarchical reduce...` |
| 3 | 第 7 段失败重跑只重调第 7 段，其余命中缓存 | `runMapPhase` + `segmentCache` + retry 端点 | `segment 7 retry invokes only that segment and reuses cached results` |
| 4 | 进度 API 在 map 阶段返回正确 `map_done`/`map_total` | `publicJob` / GET job | `progress API reports correct map_done and map_total while mapping` |

## 6. 替换点（接入真实系统时）

1. **缓存**：`segmentCache` 的 `cacheGet`/`cacheSet` 替换为真实 Redis `GET`/`SET key value EX 86400`；key 格式与模板版本保持不变。TTL 来自 `CACHE_TTL_MS`。
2. **网关调用**：`mockOpsMeetingPreprocess` / `mockOpsMeetingMap` / `mockOpsMeetingReduce` 替换为真实 `ops.meeting.*` 客户端；保留每次逻辑调用与尝试次数的埋点、重试次数与外部超时配置。
3. **草稿管线**：`enqueueReviewDraft` 替换为真实草稿服务写入，保持 `review_level = L1`、仅入库不外发、`amount` 不计算。
4. **持久化**：`db.jobs`、`db.reviewQueue`、`metrics` 为进程内内存，服务重启即清空；生产环境改为数据库与指标系统。
5. **上传文件**：multipart 解析为内置最小实现，仅覆盖演示字段；生产环境应换成经过安全审计的流式文件上传组件。

## 7. 诚实边界

- 会议、角色、段落文本、`job_id`、`draft_id` 全部为虚构演示数据；无真实个人信息、无外部数据集。
- `ops.meeting.map` / `ops.meeting.reduce` 为 mock，带可调延迟与故障注入，不访问任何真实模型或网关。
- Redis 为内存模拟（带 TTL），进程重启后清空；未接真实 Redis。
- 输出只写入复核队列 L1，没有外发通道，也没有金额/支付逻辑。
- 分层阈值（20）、分组大小（10）、并发上限（4）、缓存 TTL（24h）均为本演示的可调常量，见 `mock-server/index.js` 顶部与 `/api/v1/meta`。
- 这是演示级可运行交付，不是生产系统；上文「替换点」列出需要工程化改造的部分。

**Data sources**: only the buyer's brief and the public listing page; all content is synthetic fictional data.

测试实证见 `验证记录.md`。

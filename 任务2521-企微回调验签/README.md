# 消息回调验签、加解密与防重放演示

可运行交付：地址验证（GET 回调）、事件推送（POST 回调）、真实 AES-256-CBC 加解密、SHA1 验签、receiveid 绑定、时间窗防重放、事件去重入库、安全日志与演示界面。所有密钥、CorpID、消息体均为**虚构值**，不连接任何真实消息服务。

## 实现口径（诚实说明）

需求原文以 FastAPI 举例；本交付按指定技术栈用 **Node 22 + Express** 实现同一 HTTP 契约与同一套密码学语义（Node 内置 `crypto` 等价于 Python `Crypto` 的 AES-256-CBC / SHA1）。**本仓库不是 Python FastAPI 代码**。事件表用内存 `Map` 模拟，真实建表语句在 `migrations/001_event_table.sql`。

## 技术栈

- Node 22 + Express 4；`node:crypto` 实现 SHA1 签名与 AES-256-CBC（不装新软件，无 xml2js 等依赖）
- React 18 + Vite 6 演示界面
- Playwright，复用系统 Edge（`channel: 'msedge'`，不下载 Chromium）
- 内存事件表 + SQL 迁移文件；Dockerfile 使用 `node:22-alpine`

## 一键启动

```bash
# A. Docker（验收用）
docker compose up --build
#   演示界面 http://localhost:4173   API http://localhost:3001/api/wecom/health
#   compose 内的三项密钥是虚构兜底值；非演示环境请用宿主机真实环境变量覆盖。

# B. 本机开发（界面演示需要非 production 模式）
npm install --no-package-lock
npm run dev:all          # mock:3001 + Vite:5173，打开 http://localhost:5173

# C. 本机生产预览（模拟容器）
npm install --no-package-lock && npm run build
WECOM_TOKEN=... WECOM_ENCODING_AES_KEY=... WECOM_CORP_ID=... node server.js
#   http://localhost:4173，/api 代理到 3001

# D. 测试
npm test                 # 15 项全绿，单 worker，系统 Edge
```

## 配置项（密钥只从环境变量读取）

| 变量 | 含义 | 代码内默认值 |
|---|---|---|
| `WECOM_TOKEN` | 签名用 Token | 无；缺失则拒绝启动 |
| `WECOM_ENCODING_AES_KEY` | 43 字符 EncodingAESKey | 无；缺失则拒绝启动 |
| `WECOM_CORP_ID` | 期望的 receiveid | 无；缺失则拒绝启动 |
| `PORT` | 回调 API 端口 | `3001` |
| `H5_PORT` | 演示界面端口 | `4173` |
| `NODE_ENV` | `production` 时关闭测试钩子 | 未设置 |
| `ALLOW_TEST_HOOKS` | 显式设为 `1` 可在非演示环境打开钩子 | 未设置 |

`mock-server/index.js` 只从 `process.env` 读取三项凭据；源码里没有硬编码真实 Token / EncodingAESKey / CorpID。`docker-compose.yml` 中的值仅为虚构演示兜底。测试向量中的虚构值只用于生成请求，不会被应用当作默认配置。

## 回调接口

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/api/wecom/callback` | 参数 `msg_signature / timestamp / nonce / echostr`；验签 + 时间窗通过后解密 echostr，`text/plain` 返回解密后的验证明文 |
| POST | `/api/wecom/callback` | 同上三个参数 + XML 中的 `Encrypt`；验签 + 时间窗 + AES 解密 + receiveid 校验 + XML 解析 + 去重入库 |
| GET | `/api/wecom/health` | 健康检查、当前时钟、事件行数、已处理次数 |
| GET | `/api/wecom/meta` | 支持的事件、签名/加密口径、时间窗、去重字段、配置来源 |
| POST | `/api/wecom/_test/make-callback` | 仅演示/验收：生成一份已签名加密的可重复投递信封 |
| POST | `/api/wecom/_test/make-url-check` | 仅演示/验收：生成地址验证信封 |
| GET | `/api/wecom/_test/events` / `_test/logs` | 仅演示/验收：查看事件表与安全日志 |
| POST | `/api/wecom/_test/reset` | 仅演示/验收：清空内存事件表与日志 |

测试钩子在 `NODE_ENV=production` 且未显式开启 `ALLOW_TEST_HOOKS` 时返回 404；因此生产模式下演示页的“推送/地址验证”按钮不可用，这是有意的门禁。

## 加解密与签名规则

- 签名：`[token, timestamp, nonce, ciphertext]` 字典序拼接（无分隔符）后 SHA1，得到 40 位十六进制；用 `timingSafeEqual` 恒定时间比较。
- 密钥：`Base64(EncodingAESKey + "=")` → 32 字节 AES key；IV 取 key 前 16 字节。
- 加密：AES-256-CBC；PKCS#7 块长 **32 字节**（手动填充，并关闭 Node cipher 的默认 16 字节自动填充）。
- 明文封包：`16 字节随机串 + 4 字节大端消息长度 + 消息体 + receiveid`。
- 解包后校验 `receiveid === WECOM_CORP_ID`，不一致直接 403。
- 外层回调 XML 用正则取出 `Encrypt`；内层消息 XML 用轻量正则解析 CDATA 字段，不引入 XML 库。

## 支持的事件与去重

事件类型：`change_contact`（成员变更）、`add_external_contact`、`del_external_contact`、`edit_external_contact`。

事件表 `wecom_callback_event` 字段：`dedup_key`（唯一）、`event_type`、`payload_json`、`received_at`、`processed_at`、`status`。

`dedup_key = sha256(FromUserName + CreateTime + Event + ChangeType + UserID/ExternalUserID)`（字段间用不可见分隔符连接，前缀 `evt_`）。运行中按 `dedup_key` 先查后写：重复推送返回 `duplicate`，**不更新** `processed_at`，也不增加已处理计数。

## 安全说明

1. **先验签、再解密**：签名不符或格式非法立即 403，代码路径不进入解密函数。
2. **时间窗**：与服务器时间相差超过 300 秒即 403；无效时间戳同样拒绝。
3. **receiveid 绑定**：解密后校验 CorpID，防止跨主体密文被接受。
4. **防重放**：唯一 `dedup_key` + 先查后写，同一事件多次推送只处理一次。
5. **密钥隔离**：三项凭据只来自环境变量；测试向量中的虚构值不进入应用默认配置。
6. **日志最小字段**：日志仅含白名单字段（时间、级别、固定事件码、事件类型、dedup_key 摘要、行状态、拒绝原因码、HTTP 状态、时间偏差），**不打印明文消息体、密文、Token、EncodingAESKey 或 CorpID**。
7. **演示钩子门禁**：生产模式默认关闭，避免把签名/加密能力暴露为公开预言机。

## 验收对照

| 验收项 | 自动化测试 |
|---|---|
| 自建向量加解密结果与原文一致、签名与手算值一致 | `自建向量：模块与独立参考实现的密文完全一致` / `自建向量：解密结果与原文逐字一致，含 UTF-8 中文正文` / `自建向量：签名等于按文档手算的排序拼接 SHA1` |
| 错误签名与时间戳偏差 >300 秒均返回 403 | `错误签名与超过 300 秒的时间偏差都返回 403，且不解密不入库` |
| 同一事件推 3 次只有 1 条记录且只处理 1 次 | `同一事件推送三次只入库一条，且只处理一次` |
| 日志不含明文消息体或 EncodingAESKey | `日志不含明文消息体、密文、Token 或 EncodingAESKey` |
| 四类事件、receiveid 校验、界面演示 | `四类事件都解析为结构化事件记录` / `receiveid 与配置不符时拒绝推送` / 两条界面测试 |

测试向量在 `data/test-vectors.json`，包含虚构 CorpID、自生成 EncodingAESKey、确定性随机前缀、预计算密文和按文档手算的签名值；测试内另有一份独立参考实现交叉核对。

## 数据来源与诚实边界

**Data sources**：仅来自需求页与本地构造；CorpID、Token、EncodingAESKey、成员与外部联系人标识、消息正文全部为虚构占位，无真实个人/企业数据，不连接任何真实服务。

- 事件表是内存 `Map`，进程重启即清空；SQL 迁移文件表达等价结构，未接真实数据库。
- 本交付不实现真实消息平台的网络接入、客服/通讯录业务处理、真实数据库或 SSO。
- `npm audit` 在未生成 lockfile 的交付目录中无法执行（返回 `ENOLOCK`）；依赖限定为 Express / React / Vite / Playwright 的固定主版本，未把在线漏洞扫描作为通过条件。
- 召回/加密指标均针对本地自建向量，不代表真实环境泛化效果。

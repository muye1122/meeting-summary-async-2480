# 会员经理交接与 CRM 同步接口

可运行交付：六个业务接口、三状态交接状态机、按角色可见范围、乐观锁并发领取、退回补充与通知、CRM 同步 outbox（1/5/30 分钟退避、5 次失败转 failed）、OpenAPI 描述、React 演示工作台与自动化测试。所有企业、人员、电话、合同号均为**虚构合成数据**，无真实个人信息或企业信息。

## 技术栈（均为 MIT / Apache-2.0 / BSD 许可）
- 业务服务：Node 22 + Express 4，**内存数据层模拟数据库**，无外部服务
- 演示前端：React 18 + Vite 6（JSX）
- 端到端测试：Playwright，复用系统 Edge（`channel: 'msedge'`，不下载 Chromium）
- 纯函数单测：Node 内置 `node:test`，无需额外框架
- 容器：Node 22 Alpine 官方镜像
- 不安装任何新的系统软件；除 `npm install` 拉取的 npm 依赖外无需外部服务

## 一键启动
```bash
# 方式 A：Docker（验收用）
docker compose up --build
#   演示页面 http://localhost:4173   Mock API http://localhost:3001/api/sales/health

# 方式 B：本机开发
npm install
npm run dev:all          # mock:3001 + Vite:5173，打开 http://localhost:5173

# 方式 C：本机生产预览（模拟容器）
npm install && npm run build && node server.js
#   演示页面 http://localhost:4173，/api 自动代理到 3001

# 测试
npm test                 # 单测 + Playwright 端到端（含并发领取与 5 次失败退避）
```

## 状态机

状态：`pending_claim`（待领取）→ `claimed`（已领取）或 `returned_for_info`（退回补充中）；`returned_for_info` → `pending_claim`（顾问补齐材料后自动回退）；`claimed` → `returned_for_info`（领取后退回，撤销领取并取消未送达的 outbox 行）。其它组合一律返回 **409 `ILLEGAL_TRANSITION`** 或对应的 409 冲突码。

## 六个业务接口

统一挂载在 `/api/sales`（同时挂载 `/api/v1/sales`）。操作人通过请求体 `actor` 或 `X-Actor` 头传入。

| # | 方法 | 路径 | 说明 |
|---|---|---|---|
| 1 | GET | `/handovers?status=` | 按角色范围列出：总监看本部全部；会员经理看本部待领取 + 自己已领取/已退回的；顾问只看自己签约的。`status` 可取三个状态值 |
| 2 | GET | `/handovers/{hid}` | 交接详情，含缺失项、版本与 CRM 同步状态 |
| 3 | PATCH | `/handovers/{hid}/package` | 签约顾问补材料；仅 `pending_claim` / `returned_for_info` 可改；重算 `missing_fields`；`returned_for_info` 补齐后自动回 `pending_claim` |
| 4 | POST | `/handovers/{hid}/assign` | 总监指定目标会员经理；指定后只有该经理可领，但状态保持 `pending_claim`，直到对方实际领取才完成 |
| 5 | POST | `/handovers/{hid}/claim` | 会员经理领取；缺失项非空返回 422 `HANDOVER_INCOMPLETE`；并发只有 1 人成功，其余 409；成功写 `claimed_by` / `claimed_at` 并入 outbox |
| 6 | POST | `/handovers/{hid}/return` | 会员经理退回补充；`reason` 至少 10 字符；状态置 `returned_for_info` 并通知签约顾问 |

关键错误码：`FORBIDDEN` / `NOT_ASSIGNED_MANAGER`（403）、`ILLEGAL_TRANSITION` / `ALREADY_CLAIMED` / `VERSION_CONFLICT`（409）、`HANDOVER_INCOMPLETE` / `REASON_TOO_SHORT` / `INVALID_TARGET_MANAGER`（422）、`ACTOR_REQUIRED`（401）、`HANDOVER_NOT_FOUND`（404）。

必填材料字段：`enterprise_name`（企业全称）、`contact_name`（联系人）、`contact_phone`（11 位手机号）、`planned_onboarding_date`（`YYYY-MM-DD`）、`contract_no`（合同号）。响应同时给出 `missing_fields`（键数组）与 `missing_labels`（中文标签）。

## 并发领取与乐观锁

`claim` 先做角色/指定/状态/完整性校验，再读取 `{version, status}` 快照，最后通过 `commitClaim` 的 compare-and-swap 提交：只有快照仍与当前行一致才写入 `claimed`，否则返回 **409 `VERSION_CONFLICT`**。单线程内存层本身串行化提交；测试辅助接口 `POST /test/claim-yield` 可在快照读取与提交之间注入延迟，让两个并发请求读到同一快照，从而确定性地验证"恰好 1 人成功"。

## CRM 同步 outbox

领取成功后写入一条 outbox 行（外部引用为 `contract_id`），异步投递给 CRM stub。失败按 **1 / 5 / 30 / 30 分钟**退避重试；第 **5** 次失败后 `crm_sync_status=failed`，outbox 行置 `failed`，并向技术负责人写一条 `crm_sync_failed` 通知。stub 按 `contract_id` 幂等 upsert，重复投递只更新同一条记录。

```bash
curl -s http://localhost:3001/api/sales/outbox
curl -s http://localhost:3001/api/sales/crm-records
curl -s http://localhost:3001/api/sales/notifications
curl -s http://localhost:3001/api/sales/events
```

测试可快进虚拟时钟，无需真实等待：`POST /test/advance {"ms":60000}` 会把模拟时间前进并立即冲刷到期行；`POST /test/crm-failures {"count":5}` 让 stub 连续失败指定次数。

投递负载包含：企业（名称、部门）、联系人（姓名、电话）、会员经理分配（`claimed_by`）、计划入驻日期、合同号，以及 `external_ref = contract_id`。

### Integration point（CRM 真实对接点）

`mock-server/outbox.js` 的默认 `defaultCrmClient` 是本地 stub，不发网络请求。接入真实会员 CRM 时**只需**在启动处调用：

```js
import { setCrmClient } from './mock-server/outbox.js';
setCrmClient(async (payload) => {
  // payload.external_ref === contract_id，用作幂等键
  // 在此处调用真实会员 CRM 的 upsert 接口（地址与凭据由买方提供），
  // 例如基于环境变量 CRM_BASE_URL / CRM_TOKEN 发起 POST；失败时 throw Error，
  // outbox 会自动按 1/5/30/30 分钟退避并在第 5 次失败后通知技术负责人。
  return { ok: true, external_ref: payload.external_ref };
});
```

真实接口地址、鉴权方式与字段映射需由买方提供；本交付不包含任何真实外部调用。

## OpenAPI

`GET /api/sales/openapi.json` 返回 OpenAPI 3.0.3 描述，覆盖六个业务接口、状态枚举、请求体、错误码与 `Handover` schema。OpenAPI 描述随代码交付，不额外生成独立文件。

## 验收对照

| # | 验收标准 | 实现位置 | 自动化测试 |
|---|---|---|---|
| 1 | 缺失项非空领取返回 422 并列出缺失项 | `validateClaim` / `recomputeMissingFields` | `flow.spec.js` acceptance 1；`handover.test.js` |
| 2 | 两会员经理并发领同一单恰好 1 人成功，其余 409 | `assertClaimSnapshot` + `commitClaim` CAS | `flow.spec.js` acceptance 2（真实并发 HTTP）；`handover.test.js` |
| 3 | 指定给 A 的单被 B 领取返回 403 | `validateClaim` 的 `NOT_ASSIGNED_MANAGER` | `flow.spec.js` acceptance 3；`handover.test.js` |
| 4 | CRM stub 连续失败 5 次后 `crm_sync_status=failed` | `outbox.js` 退避与状态回调 | `flow.spec.js` acceptance 4；`handover.test.js` |

`npm test` 单命令执行：`node --test tests/handover.test.js`（10 项纯函数单测）+ `playwright test tests/flow.spec.js`（8 项端到端测试）。

## 数据来源
- **Data sources**: only the ticket brief and the shared interface contract; every enterprise, person, phone number, date and contract identifier is synthetic fictional data, with no external datasets and no real personal or enterprise information.

## 诚实边界（演示级限制）
- 数据层是**内存模拟数据库**，服务重启即回到内置示例数据；生产环境需替换为真实数据库并加持久化 outbox 表。
- 退避与重试由定时器 + 虚拟时钟模拟，未使用真实消息队列；进程重启会丢失未投递行。
- CRM 为本地 stub，未对接真实会员 CRM；真实接口地址、鉴权与字段映射需买方提供。
- 通知为进程内记录，未接入短信/邮件/IM；无真实认证/SSO。
- 前端是功能演示界面，不是生产级工作台；无境外 LLM 调用、无真实数据传输。

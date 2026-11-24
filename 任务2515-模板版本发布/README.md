# SOP 模板版本发布、停用与实例版本隔离

可运行交付：发布端点（完整性校验 → 冻结新版本 → 生成快照 → 写审计）、停用端点（停止新实例、保留进行中实例）、按步骤对比的 diff 计算函数、实例创建时的模板快照深拷贝与版本隔离，以及一个 React 演示工作台和覆盖四项验收的自动化测试。所有模板、步骤、角色、编号与日期均为**虚构合成数据**，无真实个人信息或企业信息。

## 技术栈（均为 MIT / Apache-2.0 / BSD 许可）
- 业务服务：Node 22 + Express 4（**内存数据层，模拟数据库**）
- 演示前端：React 18 + Vite 6（JSX）
- 端到端测试：Playwright，复用系统 Edge（`channel: 'msedge'`，不下载 Chromium）
- 纯函数单测：Node 内置 `node:test`，无需额外框架
- 容器：Node 22 Alpine 官方镜像
- 不安装任何新的系统软件；除 `npm install` 拉取的 npm 依赖外无需外部服务

## 一键启动
```bash
# 方式 A：Docker（验收用）
docker compose up --build
#   演示页面 http://localhost:4173   Mock API http://localhost:3001/api/sop/health

# 方式 B：本机开发
npm install
npm run dev:all          # mock:3001 + Vite:5173，打开 http://localhost:5173

# 方式 C：本机生产预览（模拟容器）
npm install && npm run build && node server.js
#   演示页面 http://localhost:4173，/api 自动代理到 3001
```

## 核心语义

### 发布：`POST /api/sop/templates/{id}/publish`
请求体：`{ "release_notes": "收紧第三步风控时限至 24 小时" }`。

发布前按顺序校验，任一失败返回 **422** 且不写审计、不产生版本：
1. `release_notes` 去空格后非空 → `RELEASE_NOTES_REQUIRED`
2. 草稿至少包含 1 个步骤 → `TEMPLATE_NO_STEPS`
3. 每一步的必填字段 `id` / `title` / `assignee_role` / `time_limit_hours` 齐全，时限为正数，步骤 id 不重复 → `STEP_INCOMPLETE`
4. 模板已停用 → **409 `TEMPLATE_DISABLED`**

校验通过后：`version_no = 当前版本 + 1`；把当前草稿**深拷贝**冻结为新版本，计算 `snapshot_digest`；模板状态置为 `published`；写入一条审计记录，包含与前一版本对比的 diff 摘要。已冻结的版本只新增、不修改。

### 停用：`POST /api/sop/templates/{id}/disable`
- 模板状态置为 `disabled`；此后触发新实例返回 **409 `TEMPLATE_DISABLED`**。
- **进行中的实例继续执行到完成**：实例执行端点不读取模板状态，只读自己的快照，因此停用不影响它们。
- 停用同样写审计记录。停用不改动任何步骤，所以与前版本的 diff 三类列表均为空，但 `added` / `removed` / `modified` / `text` 字段齐全。
- 重复停用返回 **409 `TEMPLATE_ALREADY_DISABLED`**；停用后的模板不能再发布。

### 实例版本隔离
- `POST /api/sop/templates/{id}/instances` 从**最新已发布版本**深拷贝快照创建实例；快照含步骤的标题、角色与时限。
- 实例创建后，后续**发布、停用、草稿修改**都不会改变它：执行只读 `template_snapshot`，`template_version` 与 `template_snapshot_digest` 终身不变。
- 草稿修改在发布前也不会泄漏到新实例——新实例始终取最新**已发布**版本，而不是当前草稿。
- 执行端点：`POST /api/sop/instances/{id}/steps/{stepId}/complete` 逐步完成，`POST /api/sop/instances/{id}/complete` 整体完成；两者都不检查模板状态。
- **本阶段不提供把进行中实例迁移到新版本的能力**：没有 migrate/upgrade 端点，进行中实例永远使用创建时的版本。此为明确的范围边界，不是遗漏。

### diff 与审计
`mock-server/diff.js` 是纯函数模块：
- `diffSteps(before, after)` 按步骤 `id` 配对，返回 `{ added, removed, modified, counts }`；`modified` 含字段级 `before/after`（例如 `time_limit_hours 48 → 24`）。
- `summarizeDiff(diff)` 生成同时包含「新增 / 删除 / 修改」三类的单行文本。
- `diffSummary(diff, meta)` 生成结构化摘要，供审计记录使用。

审计记录同时保存原始 `diff` 与结构化 `diff_summary`（含 `added` / `removed` / `modified` 三个列表和 `text`）。演示中的审计是进程内 append-only 数组，按 stub/mock 方式提供，未对接真实审计服务。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/sop/health` | 健康检查 |
| GET | `/api/sop/meta` | 状态字典、必填步骤字段、迁移能力声明 |
| POST | `/api/sop/test/reset` | 重置内存数据（测试辅助） |
| GET | `/api/sop/templates` `/templates/{id}` | 模板清单 / 详情（含草稿） |
| GET | `/api/sop/templates/{id}/versions` | 已冻结版本列表（按版本倒序） |
| PUT | `/api/sop/templates/{id}/draft` | 替换草稿步骤（不影响已发布版本与实例） |
| POST | `/api/sop/templates/{id}/publish` | 发布新版本 |
| POST | `/api/sop/templates/{id}/disable` | 停用模板 |
| POST | `/api/sop/templates/{id}/instances` | 从最新已发布版本触发实例 |
| GET | `/api/sop/instances` `/instances/{id}` | 实例清单 / 详情 |
| POST | `/api/sop/instances/{id}/complete` | 整体完成实例 |
| POST | `/api/sop/instances/{id}/steps/{stepId}/complete` | 完成实例中的某一步 |
| GET | `/api/sop/audit` | 审计日志，支持 `?template_id=` / `?category=` |
| GET | `/api/sop/openapi.json` | OpenAPI 3.0 摘要 |

所有路由同时挂载在 `/api/v1/sop/...`。

## 验收对照

| # | 验收标准 | 实现位置 | 自动化测试 |
|---|---|---|---|
| 1 | v1 实例启动后发布 v2 修改第 3 步时限；v1 实例仍用旧时限，新实例用 v2 | `triggerInstance` 的深拷贝快照 + `publishTemplate` 的版本冻结 | `tests/flow.spec.js` acceptance 1（含「草稿修改不泄漏」与 digest 断言） |
| 2 | 停用后新触发被拒，现有实例能完成 | `disableTemplate` + `triggerInstance` 的 409 + 实例执行不读模板 | `tests/flow.spec.js` acceptance 2 |
| 3 | `release_notes` 为空发布返回 422 | `validateReleaseNotes` | `tests/flow.spec.js` acceptance 3 + `tests/version.test.js` |
| 4 | 审计记录含新增/删除/修改步骤的 diff 摘要（stub 断言） | `diffSteps` / `diffSummary` + `writeAudit` | `tests/flow.spec.js` acceptance 4 + `tests/version.test.js` |

`npm test` 单命令执行：`node --test tests/version.test.js`（6 项纯函数单测）+ `playwright test tests/flow.spec.js`（7 项端到端测试，含页面冒烟与文件清单）。

## 数据来源
- **Data sources**: only the ticket brief and the shared interface contract; every template, step, role, date and identifier is synthetic fictional data, with no external datasets and no real personal or enterprise information.

## 诚实边界（演示级限制）
- 数据层是**内存模拟数据库**，服务重启即回到内置示例数据；生产环境需替换为真实数据库，快照与版本表需落库。
- 发布/版本冻结/审计写入在单个同步块内完成（本进程内原子）；生产环境需要真正的事务，尤其是快照与审计的一致性。
- 审计日志为进程内 append-only 数组，diff 摘要按 **stub/mock** 方式提供，未对接真实审计服务；验收 4 是对该 stub 结构的断言。
- 不提供进行中实例迁移到新版本的能力；本阶段也不提供版本回滚、删除草稿或并发发布锁。
- 前端是功能演示界面，不是生产级工作台；无真实认证/SSO、无外部 LLM 调用。
- 无真实个人信息、无真实企业名、无境外数据传输。
- 拟用源码仓库名：`template-version-release-2515`（投标阶段未创建远端仓库，中标后按此名称提供可运行源码）。

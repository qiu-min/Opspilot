# Day 6：工具网关与三场景模拟数据任务清单

## 目标

建立 Agent 在 Day 7–9 能够调用的最小只读工具边界，并提供三个可重复运行的模拟故障场景。Day 6 的交付不是 Agent Loop，也不调用 OpenAI；它解决的是“Agent 可以调查什么、每种调查返回什么证据”。

目标链路：

```text
未来 Agent Runtime
  → ToolGateway.execute(ToolCall)
  → Zod 校验工具名与参数
  → 本地 JSON / Markdown fixture
  → 结构化 ToolResult（callId、data、summary、sourceUri、时间范围）
  → Day 8 的 Agent 上下文 / Day 9 的 Evidence 持久化
```

本日工具只在内存中返回结果。它们不访问 PostgreSQL、Redis、BullMQ、Prometheus、Loki 或 Kubernetes，也不写入 `Evidence`、`RunEvent` 或任何数据库表。

## 固定边界

### 四个只读工具

| 工具名 | 输入 | 返回的调查信息 | Evidence kind |
| --- | --- | --- | --- |
| `queryLogs` | `service`、`startTime`、`endTime`、可选 `query` | 匹配日志、数量和摘要 | `LOGS` |
| `queryMetrics` | `service`、`metric`、`startTime`、`endTime` | 指标时间序列、单位和摘要 | `METRICS` |
| `searchRunbook` | `service`、`query` | 匹配的 Runbook 标题、片段和摘要 | `RUNBOOK` |
| `getServiceTopology` | `service` | 上游、下游与关键依赖 | `TOPOLOGY` |

每个工具的定义都必须包含名称、面向模型的描述、严格的输入/输出 Zod schema、`evidenceKind` 和 `readOnly: true`。Zod schema 是公开、供应商无关的工具契约；Day7 的 `model-gateway` 负责将其转换为 OpenAI function schema，工具包不得依赖 OpenAI SDK。`ToolGateway` 提供 `listTools()` 和 `execute(call)`；未知工具、非法参数、未知服务和无匹配结果均返回结构化失败结果，不能产生未处理异常。

### 统一调用与结果契约

- `ToolCall` 为 `{ callId, name, arguments }`；`callId` 是非空、不透明字符串。Day6 测试可传入固定值；Day7–8 使用模型返回的 tool call ID。`arguments` 先由对应工具的输入 schema 校验，拒绝额外字段。
- 成功 `ToolResult` 至少含 `ok: true`、与请求相同的 `callId`、`name`、`data`、`summary`、`sourceUri` 和可选 `timeRangeStart` / `timeRangeEnd`。
- 失败 `ToolResult` 至少含 `ok: false`、与请求相同的 `callId`、`name`、稳定的机器可读 `errorCode`、安全的 `message`；不返回完整 fixture 内容或堆栈。
- `summary` 是下一轮模型可消费的短摘要；`data` 保留本工具本次命中的结构化事实，供未来转换为 Evidence。二者均为纯 JSON 数据。
- 本日不并行调度工具、不设重试策略、不持久化调用历史；这些属于 Day 8–9。

### 与 Agent 上下文、长期证据和未来会话树的边界

`tool-gateway` 只定义和执行工具，输出纯数据 `ToolResult`；它不得导入 `agent-runtime`、`application`、`db` 或 Prisma，不创建 `AgentContext`、`AgentMessage`、会话树节点，也不写数据库。

```text
ToolCall(callId) → ToolGateway → ToolResult(callId)
                                      ├─ Day8：agent-runtime 转为内存中的 tool-result message
                                      ├─ Day9：application 转为 RunEvent 与被采纳的 Evidence
                                      └─ 未来：会话树将 assistant toolCall 与 tool-result message 以 callId 关联
```

`ToolResult`、领域 `Evidence` 和未来的 `ToolResultMessage` 是三个不同模型：前者描述一次工具调用的即时结果；Evidence 是可审计的长期业务事实；ToolResultMessage 是模型上下文中的会话消息。后两者只能在各自的上层转换，不反向污染 Tool Gateway 契约。

## 模拟故障数据

在 `packages/tool-gateway/src/fixtures/` 建立下列版本化数据集：

```text
connection-pool/
  logs.json
  metrics.json
  topology.json
  runbook.md
error-rate/
  logs.json
  metrics.json
  topology.json
  runbook.md
latency/
  logs.json
  metrics.json
  topology.json
  runbook.md
```

JSON 存日志、指标和拓扑；Markdown 存给 Agent 搜索和给用户展示的 Runbook。fixture loader 使用相对于自身模块的受控路径读取 Markdown；构建脚本会将整组 fixture 复制到 `dist/fixtures`，因此源代码与构建产物均读取同一份版本化数据，不依赖工作目录或外部文件系统路径。

| 场景 | 服务 | 必须能查询到的证据 |
| --- | --- | --- |
| `connection-pool` | `billing-api` | 获取连接超时日志；`active`、`idle`、`max` connections 指标；`billing-api → PostgreSQL` 依赖；连接池排查 Runbook。 |
| `error-rate` | `checkout-api` | 5xx/异常日志；错误率与请求量指标；关键下游依赖；错误率排查 Runbook。发布相关线索可放在日志或 Runbook，不新增第五个工具。 |
| `latency` | `orders-api` | 慢请求日志；P95/P99 与下游耗时指标；高延迟依赖；延迟排查 Runbook。 |

所有记录使用 ISO 8601 UTC 时间戳、统一服务名和可追溯的 URI（例如 `fixture://connection-pool/logs`）。fixture 只提供可调查的事实，不能包含“最终根因”“推荐诊断路径”或 Agent 标准答案字段。

## 任务清单

### 1. 建立公开工具契约

- [x] 新增 `packages/tool-gateway/src/contracts.ts`，定义 `ToolDefinition`、带 `callId` 的 `ToolCall`、成功/失败 `ToolResult`、`ToolGateway` 以及四个工具的输入/输出 schema。
- [x] 工具参数均采用严格对象 schema；时间使用 ISO 8601 UTC 字符串，且开始时间不得晚于结束时间。
- [x] `queryMetrics.metric` 仅接受 fixture 实际支持的指标名；不接受任意 PromQL 或 LogQL。
- [x] 定义四项工具元数据，并确保名称唯一、只读标记为真、Evidence kind 正确。
- [x] 确认公开 Zod schema 不依赖 OpenAI、AgentContext、数据库或 fixture 实现；Day7 可将其转换为模型 function schema，Day8 可将 ToolResult 转为会话消息。
- [x] 用新的公开导出替换 `packages/tool-gateway/src/index.ts` 中 Day5 的占位接口。

验收：调用方只需依赖 `@opspilot/tool-gateway` 的公开类型，即可列出工具、构造调用并理解成功/失败结果；不依赖任何具体 fixture 文件。

### 2. 建立三组本地 fixture

- [x] 新增三个场景目录及各自的 `logs.json`、`metrics.json`、`topology.json`、`runbook.md`。
- [x] 日志包含时间、服务、级别、消息和可选结构化属性；同一服务在时间窗内有正常与异常记录，支持关键词筛选。
- [x] 指标包含服务、指标名、单位、带时间戳的样本；每个场景至少包含一个异常指标和一个用于交叉验证的指标。
- [x] 拓扑包含目标服务、上游、下游和依赖类别；依赖名称与日志/指标中出现的服务名称一致。
- [x] Runbook 使用 Markdown 标题和短段落，以便关键词匹配后返回片段；不包含最终根因结论。
- [x] 新增 `packages/tool-gateway/src/fixtures.ts`，集中加载和校验 fixture，按服务解析到唯一场景。

验收：三组数据在不访问网络和数据库的情况下可被稳定加载；每个场景的四类数据均可通过对应工具查询。

### 3. 实现确定性的模拟 Tool Gateway

- [x] 新增 `packages/tool-gateway/src/tool-gateway.ts`，实现 `FixtureToolGateway`。
- [x] `listTools()` 按固定顺序返回四个工具定义。
- [x] `queryLogs` 按服务、闭区间时间范围和可选不区分大小写关键词过滤，返回命中记录、数量与安全摘要。
- [x] `queryMetrics` 仅返回请求的服务、metric 和闭区间时间范围内的样本，并保留单位和摘要。
- [x] `searchRunbook` 按服务和不区分大小写关键词找出匹配 Markdown 段落，返回标题、片段和摘要；无命中是结构化失败。
- [x] `getServiceTopology` 只返回请求服务的拓扑记录和对应 `sourceUri`。
- [x] 对未知工具、非法参数、未知服务和无匹配数据统一返回稳定失败结构，并始终回显原始 `callId`；不泄露不相关场景的原始数据。

验收：相同 `ToolCall` 总是获得相同结果；工具只读，不访问数据库、网络或文件系统外部资源。

### 4. 依赖、构建与测试配置

- [x] 修改 `packages/tool-gateway/package.json`，添加运行时 `zod` 依赖和 Node 类型；保留现有 `build`、`test`、`typecheck` 命令，并在构建后复制 fixture。
- [x] 修改 `packages/tool-gateway/tsconfig.json`，启用 JSON fixture 的类型化导入和 Node 类型；保持严格 TypeScript 检查。
- [x] 确认 `tsconfig.build.json` 会编译所有 `src/**/*.ts`，但不把测试目录写入 `dist`。

验收：工具包可以独立执行构建、测试和类型检查，不新增 OpenAI、Redis、BullMQ、数据库或云 SDK 依赖。

### 5. 编写测试

- [x] 新增 `packages/tool-gateway/test/contracts.test.ts`。
- [x] 新增 `packages/tool-gateway/test/fixtures.test.ts`。
- [x] 新增 `packages/tool-gateway/test/tool-gateway.test.ts`。

验收：见下方测试计划；Day6 结束时根目录测试与类型检查仍通过。

### 6. 更新计划状态

- [x] Day6 的代码、fixture 与测试均已通过；已更新 `WorkPlan.md` 标记 Day6 完成，并说明四个只读工具、三场景 fixture，以及“Day6 不持久化 Evidence”的边界。

## 具体文件列表

### 新增

```text
docs/Day6TaskList.md
packages/tool-gateway/src/contracts.ts
packages/tool-gateway/src/fixtures.ts
packages/tool-gateway/src/tool-gateway.ts
packages/tool-gateway/src/fixtures/connection-pool/logs.json
packages/tool-gateway/src/fixtures/connection-pool/metrics.json
packages/tool-gateway/src/fixtures/connection-pool/topology.json
packages/tool-gateway/src/fixtures/connection-pool/runbook.md
packages/tool-gateway/src/fixtures/error-rate/logs.json
packages/tool-gateway/src/fixtures/error-rate/metrics.json
packages/tool-gateway/src/fixtures/error-rate/topology.json
packages/tool-gateway/src/fixtures/error-rate/runbook.md
packages/tool-gateway/src/fixtures/latency/logs.json
packages/tool-gateway/src/fixtures/latency/metrics.json
packages/tool-gateway/src/fixtures/latency/topology.json
packages/tool-gateway/src/fixtures/latency/runbook.md
packages/tool-gateway/test/contracts.test.ts
packages/tool-gateway/test/fixtures.test.ts
packages/tool-gateway/test/tool-gateway.test.ts
```

### 修改

```text
packages/tool-gateway/src/index.ts
packages/tool-gateway/package.json
packages/tool-gateway/tsconfig.json
WorkPlan.md                     # 仅在 Day6 代码完成与验证后更新
```

### 不修改

```text
apps/api/
apps/api-runtime/
apps/worker/
packages/application/
packages/db/
packages/domain/
packages/model-gateway/
packages/agent-runtime/
packages/observability/
packages/db/prisma/schema.prisma
```

## 测试计划

### `contracts.test.ts`

- 四个定义的名称唯一，均为只读，且 `evidenceKind` 分别为 `LOGS`、`METRICS`、`RUNBOOK`、`TOPOLOGY`。
- 每个定义均有非空描述、输入 schema、输出 schema。
- `queryLogs` / `queryMetrics` 拒绝缺失服务、非法日期、开始时间晚于结束时间和多余字段。
- `queryMetrics` 拒绝未支持的 metric；`searchRunbook` 拒绝空查询；`getServiceTopology` 拒绝多余字段。
- 未知工具或非法参数经 `execute()` 返回结构化失败，而不是抛出异常；成功和失败结果均回显调用的 `callId`。

### `fixtures.test.ts`

- 三个场景均可加载，且每个场景都有非空日志、指标、拓扑和 Runbook。
- JSON 结构符合 fixture schema，Markdown 非空；服务名、时间戳、指标名和拓扑依赖一致。
- `billing-api` 有连接池相关指标/日志，`checkout-api` 有错误率相关指标/日志，`orders-api` 有 P95/P99 和慢请求相关证据。
- 每个 fixture 具备可追溯、稳定的 `fixture://` URI。

### `tool-gateway.test.ts`

- `queryLogs` 的关键词和时间范围会影响命中集，且返回 `LOGS` 结果的稳定摘要和 URI。
- `queryMetrics` 只返回请求 metric 与时间范围内的样本，带单位、摘要和 `METRICS` URI。
- `searchRunbook` 只返回匹配片段，不返回整份 Markdown；`getServiceTopology` 返回目标服务的上下游关系。
- 未知服务、无命中和非法调用返回预期错误码，且不泄露其他场景的数据。
- 每个场景至少运行两种工具：连接池场景可区分连接上限与超时；错误率场景可区分 5xx/异常；延迟场景可区分 P95/P99 与下游耗时。
- 同一调用重复执行结果相同，证明 fixture gateway 是确定性的；`callId` 只用于关联，不影响查询或结果内容。

### 验收命令

```text
pnpm --filter @opspilot/tool-gateway build
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway typecheck
pnpm test
pnpm typecheck
```

## 完成定义

- [x] 四个只读工具有公开、Zod 校验的稳定契约。
- [x] 三个场景的 JSON + Markdown fixture 能提供四类可调查证据。
- [x] `FixtureToolGateway` 对成功、无结果、未知服务与非法调用均有确定性行为。
- [x] 每次调用及其结果通过 `callId` 可关联，且 Tool Gateway 未依赖 Agent 上下文或数据库模型。
- [x] 工具包和根目录测试、类型检查均通过。
- [x] 未接入 OpenAI、Agent Loop、PostgreSQL 持久化、BullMQ 或任何真实监控系统。

## Day 6 对项目的作用

Day6 为真实 Agent 提供“眼睛”和可控实验环境：模型在 Day7–8 将不是根据预设流程输出结论，而是根据告警和工具返回的证据选择下一步调查。三组数据使项目能够展示同一个 Agent 在不同告警下采用不同工具路径，同时保持结果可复现、可测试。未来接入 Prometheus、Loki 和 Kubernetes 时，只替换 Tool Gateway 内部的数据源，工具契约和 Agent Loop 不需要重写。

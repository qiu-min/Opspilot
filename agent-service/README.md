# OpsPilot Agent Service

## Positioning

`agent-service/` 是 OpsPilot 的 TypeScript / Node.js Agent 基础设施和运行服务，提供与具体业务领域解耦的模型访问、Agent Runtime、工具调用和执行编排能力。

它不是 OpsPilot 的传统业务后端，也不拥有用户、文件、权限或 Excel 业务数据。整体产品边界如下：

```text
Web（Vue 3 + TypeScript）
        ↓ HTTP
Backend（ASP.NET Core）
        ↓ HTTP
Agent Service（Node.js + TypeScript）
        ↓
Agent Runtime → Tool Gateway → Backend Internal Tool API
```

## Responsibilities

Agent Service 当前和未来负责：

- Model Gateway：Provider 适配、统一模型请求、消息与 Tool Declaration、流式事件和模型错误归一化
- Agent Runtime：Agent 生命周期、Agent Loop、Agent State、Turn、Tool Call、Tool Result 和终止控制
- Agent Events：Agent、Turn、Message、Tool Execution 的生命周期事件
- Streaming：模型增量消息和工具调用进度的事件化传递
- Cancellation：将取消信号传递给模型请求和工具执行
- Context：在每轮调用前转换上下文、转换为 LLM 消息并准备下一轮
- Tool Gateway：工具契约、参数验证、工具适配器和外部能力的执行边界
- Observability：为结构化日志、Trace、模型调用和工具调用预留边界

未来规划包括 RAG integration、Eval、Trace、Context compaction、长运行恢复和 Agent execution API。

## What Agent Service Does Not Own

以下能力属于 `backend/` 或 `web/`，不属于 Agent Service：

- User、JWT、RBAC 和身份权限
- File Management、文件存储和下载
- AnalysisTask 业务生命周期
- Excel 文件持久化、Excel domain logic 和 ClosedXML / Open XML SDK
- PostgreSQL 中的传统业务数据和 EF Core
- ASP.NET Core 业务逻辑
- Vue Web UI

Agent Service 可以通过 API 调用 Backend 的业务 Tool，但不会直接引用 .NET Infrastructure，也不实现 Excel 领域逻辑。

## Package boundaries

下面是职责关系，不是把所有包简化成一条机械的代码依赖链：

```text
model-gateway   ← 模型 Provider、消息、模型 Tool 声明和模型事件
       ↑
agent-runtime   ← Agent 生命周期、Loop、状态、事件、工具编排
       ↑
tool-gateway    ← 工具契约验证、适配器和外部能力执行边界
```

### `packages/model-gateway`

当前实现包括：

- Provider 与模型描述、模型查询和 Model Gateway 接口
- `Context`、消息、`Options`、Tool Declaration 和响应契约
- OpenAI Completions 适配器与工具声明转换
- 流式模型事件和 Provider 错误的统一表达
- Thinking / reasoning level 能力判断、映射和回退

`model-gateway` 只负责模型访问边界，不负责 Agent Loop、Agent State 或业务 Tool 执行。

### `packages/agent-runtime`

当前实现包括：

- 有状态的 `Agent` 包装器和 Agent 生命周期
- `runAgentLoop`：模型回合、工具调用、工具结果回填和后续回合
- Agent State、Turn、Message 和 Tool Execution 事件
- Streaming message、工具并发模式、steering/follow-up 消息
- Context transform、LLM message conversion 和下一轮准备 Hook
- AbortSignal 取消、错误来源分类和正常/错误/中止终止

`agent-runtime` 不感知 Excel、运维、ERP、Incident 等领域知识。

### `packages/tool-gateway`

当前实现包括工具输入输出 Zod schema、Connector 契约和 Fixture Connector。现有 Fixture 主要用于早期 Demo 的日志、指标、Runbook 和服务拓扑查询；这不代表 Tool Gateway 只服务生产故障运维。

Tool Gateway 的通用边界是：

```text
Agent Runtime
      ↓ Tool contract
Tool Gateway
      ↓ adapter / connector
External or business capability
```

未来 Excel Tool 可以通过同一边界接入：

```text
Agent Runtime
      ↓
Tool Gateway
      ↓ HTTP
ASP.NET Core Internal Tool API
      ↓
Excel Service
      ↓
ClosedXML / Open XML SDK
```

Excel 是未来业务 Tool 的示例，不属于 Agent Runtime 本身。

### Other packages

- `packages/observability`：当前只有结构化日志与追踪边界的 marker interface；完整 Trace 能力仍是 Planned。
- `packages/application`、`packages/domain`、`packages/db`、`packages/shared`：保留早期 Incident / Alert Demo 的应用用例、领域模型、Prisma 持久化和 DTO；它们不定义未来 ASP.NET Core Backend 的边界。

## Workspace layout

以下目录来自当前 Workspace：

```text
agent-service/
├── apps/
│   ├── api/             # 旧 Demo 的 NestJS HTTP 接口
│   ├── api-runtime/     # 旧 Demo 的 API 组合根
│   ├── worker/          # 旧 Demo 的后台运行入口
│   └── web/             # 旧 Demo / 嵌套 Git 内容，不是未来正式 Web
├── packages/
│   ├── model-gateway/
│   ├── agent-runtime/
│   ├── tool-gateway/
│   ├── observability/
│   ├── application/
│   ├── domain/
│   ├── db/
│   └── shared/
├── config/
├── docs/
├── README.md
└── PROJECT.md
```

`apps/api`、`apps/api-runtime` 和 `apps/worker` 包含早期 OpsPilot 故障响应 Demo 阶段留下的应用组合和运行入口，目前仍保留用于已有功能、测试或参考。它们不再定义未来 OpsPilot 的传统业务 Backend；未来主业务后端位于 `/backend`，使用 ASP.NET Core。

`apps/web` 不代表未来 OpsPilot Web UI。正式前端边界是仓库根目录的 `/web`，技术方向为 Vue 3 + TypeScript；`agent-service/apps/web` 仅在 Legacy / Existing demo 范围内保留。

旧 Incident、AnalysisRun、Evidence、Approval、Execution、Runbook 和 Alert 设计已归档至 [Legacy Incident Response Demo Design](docs/legacy/incident-response-demo.md)。

## Development commands

在仓库根目录执行 Agent Service 命令前，先进入本目录：

```powershell
cd agent-service
pnpm install
```

当前实际存在的验证命令：

```powershell
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

其中 `pnpm build` 和 `pnpm lint` 当前执行 Workspace 中的 `web` package 脚本；`pnpm test` 和 `pnpm typecheck` 递归执行已有 Workspace package。也可以执行 API / Worker 的专用构建：

```powershell
pnpm build:api
pnpm build:worker
```

当前已有的开发入口：

```powershell
pnpm dev         # 旧 apps/web Demo
pnpm dev:api     # 旧 NestJS api-runtime
pnpm dev:worker  # 旧 Worker 入口
```

这些命令属于现有 Demo 应用，不是未来 ASP.NET Core Backend 的启动方式。PostgreSQL 和 Redis 可由仓库根目录的 Compose 文件提供：

```powershell
docker compose -f ../docker-compose.yml up -d
```

## Backend integration

未来 Backend 启动 Agent Run 时调用 Agent Service 的 HTTP API：

```text
Backend → Agent Service
```

未来 Agent Service 调用 Excel 等业务能力时，通过 Tool Gateway 调用 Backend Internal Tool API：

```text
Agent Service → Tool Gateway → Backend Internal Tool API
```

以上是两个独立服务之间的 API 通信。当前 Agent Service HTTP Run API 尚未作为产品级公共接口完成，具体规划见 [PROJECT.md](PROJECT.md)。

## Related documents

- [PROJECT.md](PROJECT.md)：Agent Service 的设计目标、当前能力、状态和 Roadmap
- [Legacy Incident Response Demo Design](docs/legacy/incident-response-demo.md)：早期故障响应业务设计，仅作历史参考
- [根目录产品 README](../README.md)：OpsPilot、Backend 和 Web 的整体边界

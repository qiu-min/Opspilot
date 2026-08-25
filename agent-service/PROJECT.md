# OpsPilot Agent Service

Agent Service 是 OpsPilot 中独立的 TypeScript / Node.js Agent Runtime Service。它从早期的故障响应 Agent Demo 演进而来，当前目标是提供业务无关、模型供应商无关、Tool 实现无关的 Agent 基础设施。

Agent Service 应能够服务未来的 Excel Data Agent、RAG Agent、ERP Agent 和其他业务 Agent，而不是绑定 Incident Agent 或运维故障领域。

## 1. Positioning

OpsPilot 的整体调用关系是：

```text
Web（Vue 3 + TypeScript）
        ↓ HTTP
Backend（ASP.NET Core）
        ↓ HTTP
Agent Service（Node.js + TypeScript）
```

Agent Service 只负责 AI Agent Runtime 及其模型、工具和运行时边界。用户、权限、文件、任务、数据库和 Excel 业务基础设施属于 Backend；用户交互属于 Web。

## 2. Architecture Principles

- **Provider-independent**：Agent Runtime 不绑定某个模型 Provider，Provider 差异收敛在 Model Gateway。
- **Business-independent**：Runtime 不感知 Excel、Incident、ERP 或其他业务领域对象。
- **Tool-implementation-independent**：Runtime 只消费 Tool 契约，不直接引用外部连接器或 .NET Infrastructure。
- **Event-driven**：Agent、Turn、Message 和 Tool Execution 通过生命周期事件表达进度与状态。
- **Observable**：模型调用、工具调用、耗时、token、错误来源和 Agent 事件应有可追踪边界。
- **Cancelable**：模型请求与工具执行接收上游 AbortSignal，并能在取消时结束运行。
- **Recoverable**：为上下文管理、检查点和长运行 Agent 恢复预留扩展边界。
- **Explicit boundaries**：Backend → Agent Service 与 Agent Service → Backend Tool API 是两条独立的服务通信路径。

## 3. Core Architecture

```text
model-gateway   ← 模型 Provider、消息、模型 Tool 声明和模型事件
       ↑
agent-runtime   ← Agent 生命周期、Loop、状态、事件和工具编排
       ↑
tool-gateway    ← Tool 契约验证、适配器和外部能力执行边界
```

这表示能力边界和协作关系，不是把所有实现简化为单向的机械依赖链：Model Gateway 负责模型访问，Agent Runtime 负责运行 Agent，Tool Gateway 负责执行工具及其外部能力适配。

## 4. Model Gateway

当前 `packages/model-gateway` 已有以下能力：

- Provider 和 Model 描述、模型查询与 `ModelGateway` 接口
- `Context`、Message、`Options`、Tool Declaration 和响应契约
- OpenAI Completions 模型适配器与工具声明转换
- Provider 流式事件归一化为统一的模型事件流
- Provider 错误和响应结束原因的统一表达
- Thinking / reasoning level 的能力判断、Provider 映射和等级回退
- 配置文件和环境变量驱动的模型 Provider 配置

Model Gateway 不负责 Agent Loop、Agent State、工具执行、业务 DTO 或业务领域持久化。

## 5. Agent Runtime

当前 `packages/agent-runtime` 已有以下能力：

- 有状态 `Agent` 包装器和 Agent 生命周期
- Agent Loop：模型回合、工具调用、工具结果回填和后续回合
- Agent State：模型、工具、消息、运行状态、流式消息、错误和待执行 Tool Call
- Agent Event：Agent、Turn、Message 和 Tool Execution 生命周期事件
- Streaming：消费模型增量事件并更新消息生命周期
- Tool Calling：校验后的 Tool Call 执行、串行/并行模式和结果回填
- Cancellation：AbortSignal 向模型和工具执行传播
- Context commit：在调用模型前转换上下文和消息，并支持下一轮 Context 更新
- Steering / Follow-up：在当前运行中插入下一轮消息
- Termination：正常完成、模型错误、运行时错误和 aborted 结束原因
- Hook：`transformContext`、`convertToLlm`、`prepareNextTurn`、`shouldStopAfterTurn`、`beforeToolCall` 和 `afterToolCall`

Agent Runtime 不感知 Excel、运维、ERP、Incident、Runbook 或其他业务领域知识。

## 6. Tool Gateway

Tool Gateway 的通用定位是：

```text
Agent-facing Tool Contract
        ↓
Tool Gateway
        ↓
Business / External Tool Adapter
```

当前 `packages/tool-gateway` 已有：

- 工具输入输出 Zod schema
- 日志、指标、Runbook 和服务拓扑 Connector 契约
- Fixture Connector 实现
- Connector 输入输出边界的再次验证
- AbortSignal 取消传播

当前 Fixture 是早期 Demo 的实现，不应把 Tool Gateway 永久限定为生产故障运维 Connector。未来 Excel Tool 可以通过同一边界接入：

```text
excel.read_range
        ↓
Tool Gateway
        ↓ HTTP
ASP.NET Core Internal Tool API
        ↓
Excel Service
        ↓
ClosedXML / Open XML SDK
```

Excel 是未来业务 Tool 示例，不属于 Agent Runtime 本身。

## 7. Agent Service API（Planned）

未来 Agent Service 应为 Backend 提供启动和管理 Agent Run 的 HTTP API：

```text
ASP.NET Core Backend
        ↓ HTTP
Agent Service
```

概念性接口如下，当前尚未作为产品级公共 API 实现：

```text
POST /runs
GET /runs/{id}
POST /runs/{id}/cancel
GET /runs/{id}/events
```

接口应能表达 Agent Run 的创建、状态查询、取消和事件流；具体认证、用户权限和业务任务归属由 Backend 负责。

## 8. Backend Tool Integration

Backend 与 Agent Service 存在两个方向不同的服务调用：

```text
Backend → Agent Service
```

用于启动和管理 Agent Run。

```text
Agent Service → Tool Gateway → Backend Internal Tool API
```

用于调用 Excel 等业务 Tool。

这两条路径是独立服务之间的 API 通信。Agent Service 不直接引用 EF Core、ClosedXML 或其他 .NET Infrastructure；Tool Gateway 只通过明确的 Tool/HTTP 边界访问业务能力。

## 9. Observability

`packages/observability` 当前只有 `ObservabilityBoundary` marker interface，表示结构化日志与追踪的包边界已经预留；完整可观测实现仍是 Planned。

未来至少需要覆盖：

- AgentRun Trace
- Model call
- Tool call
- Latency
- Token usage
- Error source
- Agent events

敏感信息边界仍需保持：不记录完整 Prompt、原始业务文件、凭据或未脱敏的 Tool 参数。

## 10. Context Management

当前 Agent Runtime 已支持在模型调用前执行：

- 消息和上下文转换
- 转换为 LLM 消息
- Tool 声明附加
- 下一轮 Context 和 Model 更新
- 取消信号传递

以下能力尚未形成通用持久化实现，属于 Planned：

- Context window management
- Context compaction
- 通用 checkpoint
- Long-running Agent recovery

这些能力应保持通用，不直接复制旧 Incident-specific `ContextCheckpoint` 领域模型。

## 11. RAG（Planned）

RAG 属于未来 Agent Tool / capability，不属于 Model Gateway 的职责。概念调用关系为：

```text
Agent
  ↓
rag.search
  ↓
Tool Gateway
  ↓
RAG Service
```

当前仓库没有完成通用 RAG Service 或 `rag.search` Tool 实现。

## 12. Eval（Planned）

未来 Agent Eval 可覆盖：

- Tool selection correctness
- Task success
- Trajectory evaluation
- Regression tests
- Latency
- Token cost
- Failure classification

当前仓库尚未形成独立 Eval Pipeline 或评测数据集。

## 13. Current Status

### Completed

- Model Gateway 基础契约、模型配置和 OpenAI Provider 适配
- Model streaming event、tool declaration 和 reasoning 处理
- Agent Runtime 生命周期、Loop、State、Event、Tool Call、Streaming 和 Cancellation
- Agent Runtime 的 Context 转换与 Loop Hook
- Tool Gateway 的 Fixture Tool contract、Connector schema 和 Fixture Connector
- 以上核心包的类型检查与已有单元测试

### In Progress

- 早期故障响应 Demo 的 API、Worker、Prisma 和 Fixture 数据仍保留在 Workspace 中，用于已有功能、测试或参考
- 通用 Agent Service 与未来 Backend 之间的产品级 HTTP 边界尚在规划

### Planned

- Agent Service HTTP Run API
- Backend adapter 与 Internal Tool API 集成
- 完整 Observability / Trace
- 通用 Context compaction、checkpoint 和恢复
- RAG Tool / Service 集成
- Agent Eval Pipeline
- 生产级鉴权、限流、幂等和部署加固

## 14. Workspace Layout

```text
agent-service/
├── apps/
│   ├── api/             # 旧 Demo 的 NestJS HTTP 接口
│   ├── api-runtime/     # 旧 Demo 的 API 组合根
│   ├── worker/          # 旧 Demo 的后台运行入口
│   └── web/             # 旧 Demo / 嵌套 Git 内容
├── packages/
│   ├── model-gateway/
│   ├── agent-runtime/
│   ├── tool-gateway/
│   ├── observability/
│   ├── application/     # 旧 Demo 应用用例
│   ├── domain/          # 旧 Demo Incident 领域模型
│   ├── db/              # 旧 Demo Prisma 持久化
│   └── shared/          # 旧 Demo DTO
├── config/
├── docs/
├── README.md
└── PROJECT.md
```

旧故障响应设计保留在 [Legacy Incident Response Demo Design](docs/legacy/incident-response-demo.md)，不再作为当前 Agent Service 的产品边界。

## 15. Development and Verification

从仓库根目录进入 Agent Service 后执行：

```powershell
cd agent-service
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
```

当前真实存在的开发入口为：

```powershell
pnpm dev
pnpm dev:api
pnpm dev:worker
```

这些入口对应现有旧 Demo 应用；它们不代表未来 ASP.NET Core Backend 的启动命令。

## 16. Roadmap

### Phase 1 — Core Runtime

- Model Gateway
- Agent Runtime
- Agent Loop
- Tool contract
- Agent events

当前核心代码已基本覆盖本阶段；持续工作集中在边界稳定性和错误/取消测试。

### Phase 2 — Service Integration

- Tool Gateway integration
- Agent Service HTTP contract
- Backend adapter
- Backend Internal Tool API 协议

### Phase 3 — Context and Operations

- Context management
- Compaction and recovery
- RAG integration
- Observability / Trace

### Phase 4 — Evaluation and Hardening

- Eval
- Regression dataset
- Failure classification
- Production hardening

## 17. Explicit Non-goals

Agent Service 不实现：

- Excel domain logic
- ClosedXML / Open XML SDK
- User management、JWT 和 RBAC
- File upload、File Management 和 File Storage
- AnalysisTask business model
- EF Core
- ASP.NET Core business logic
- Vue UI
- 直接持久化 Backend 的传统业务数据
- 把旧 Incident / 运维故障领域升级为 Agent Service 的核心产品模型

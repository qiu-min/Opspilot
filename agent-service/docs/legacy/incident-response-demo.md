# Legacy Incident Response Demo Design

> 这是 OpsPilot 早期故障响应业务 Demo 的设计文档，仅作为历史设计和参考，不再定义当前 OpsPilot Agent Service 的产品边界。

OpsPilot 是一个使用 TypeScript 构建的生产故障响应智能体，面向后端与 AI 智能体应用岗位展示。

它将告警、日志、指标、历史事故和 Runbook 串联为一个可追踪的处理闭环：模型负责分析和提出建议；策略层负责授权；人工负责高风险操作审批；Worker 负责可靠执行；事件层负责证据、恢复和复盘。

```text
告警 → 创建事件与运行记录 → Agent 分析 / 调用只读工具 → 生成行动建议
     → 人工审批高风险行动 → 受控执行 → 写入审计与复盘材料
```

项目的 Agent 架构参考 `../dg-ai-notes/pi-agent/docs/typescript/` 下的 Pi TypeScript 分层笔记，重点包括：[第 2 章：三层架构](../dg-ai-notes/pi-agent/docs/typescript/第2章-三层架构-Pi-Agent项目的骨骼.md)、[第 3 章：Agent Loop](../dg-ai-notes/pi-agent/docs/typescript/第3章-Agent-Loop-让模型转动起来的引擎.md)、[第 4 章：模型调用](../dg-ai-notes/pi-agent/docs/typescript/第4章-模型调用-一行代码驾驭多个模型.md)、[第 5 章：工具系统](../dg-ai-notes/pi-agent/docs/typescript/第5章-工具系统-Agent的手脚是怎么被管住的.md)、[第 7 章：事件驱动](../dg-ai-notes/pi-agent/docs/typescript/第7章-事件驱动-Agent的神经系统.md) 与 [第 8 章：上下文工程](../dg-ai-notes/pi-agent/docs/typescript/第8章-上下文工程-让有限窗口装下无限对话.md)。借鉴其单向分层、状态化 Agent、事件流、工具调用闸门、上下文检查点和类型化遥测；不照搬多模型目录、通用插件市场或完整会话树等超出 MVP 范围的复杂度。

## 技术组合

- **后端：Node.js + NestJS**：HTTP API、鉴权、事件命令、审批流与 SSE 网关。
- **数据库：PostgreSQL + Prisma + pgvector**：领域数据、不可变运行事件、审计、RAG 向量检索。
- **异步任务：Redis + BullMQ**：分析运行、重试、延迟任务和已审批行动执行。
- **智能体：OpenAI Node SDK + 工具调用**：模型仅提出工具意图；工具网关校验和执行。
- **前端：Next.js + React + Tailwind CSS**：告警列表、事故时间线、证据、分析进度和审批页面。
- **实时通信：SSE**：向页面推送持久化的领域事件，支持按事件 ID 断线回放。
- **验证与测试：Zod + Vitest + Supertest**：共享事件/API schema、工具契约测试与关键链路集成测试。
- **可观测性：Pino + OpenTelemetry**：请求、模型、工具、审批和执行的 trace；遵循脱敏规则。
- **部署：Docker Compose**：一键启动 Web、API、Worker、PostgreSQL 与 Redis。

## 核心领域模型

一次故障不是一段聊天记录。OpsPilot 将故障本身和诊断尝试分开保存：

```text
Incident（一次故障事件）
  └─ AnalysisRun（一次诊断尝试，可重试或重新发起）
       ├─ RunEvent（模型、工具、审批、执行的不可变事件）
       ├─ ToolInvocation（工具调用及其输入输出摘要）
       ├─ ProposedAction（模型提出的操作建议）
       │  └─ Approval / Execution（人工决策与实际执行）
       └─ ContextCheckpoint（可恢复的诊断摘要）
  └─ Evidence（可跨多次诊断复用的证据）
```

### 业务归属与查询关系

业务对象按主归属形成下列树；这是领域所有权，而不是限制数据库只能存在树状外键。

```text
Incident
├─ AnalysisRun
│  ├─ RunEvent
│  ├─ ProposedAction
│  │  ├─ Approval
│  │  └─ Execution
│  └─ ContextCheckpoint
└─ Evidence
```

Evidence 归属于 Incident，并可记录首次产生它的 `AnalysisRun`；后续诊断通过 `evidenceId` 引用既有证据。ContextCheckpoint 归属于产生它的 AnalysisRun。`RunEvent` 和 `ProposedAction` 同时保存 `incidentId` 与 `runId`，这是为了按 Incident 回放时间线、查询待审批 Action 和实施动作锁的有意冗余，而非双重业务所有权。仓储层创建它们时必须校验两个 ID 指向同一 Incident。

推荐状态机：

```text
Incident: OPEN → INVESTIGATING → MITIGATING → RESOLVED / CLOSED
AnalysisRun: QUEUED → RUNNING → WAITING_APPROVAL → COMPLETED / FAILED / CANCELLED
Action: PROPOSED → PENDING_APPROVAL → APPROVED / REJECTED → EXECUTING → SUCCEEDED / FAILED
```

`RunEvent` 是系统事实，页面上的时间线与当前状态是它的投影。Worker 写入事件后再通过 Redis 发布，SSE 网关据此推送；浏览器断线后从最后一个事件 ID 回放。

```ts
type RunEventType =
  | 'run.started'
  | 'model.response.delta'
  | 'model.response.completed'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.progressed'
  | 'tool.completed'
  | 'action.proposed'
  | 'approval.requested'
  | 'approval.decided'
  | 'execution.started'
  | 'execution.completed'
  | 'run.completed'
  | 'run.failed';
```

## 诊断分支与长期存储

借鉴 Pi 的会话树，OpsPilot 将一次 Incident 的诊断过程保存为**可追加、可回放、可分支**的长期记录，而不是在分析完成后只留下最终结论。

```text
Incident
  └─ AnalysisRun A：连接池耗尽假设
       ├─ 证据：5xx 指标、连接错误日志、相关 Runbook
       ├─ 建议：扩容连接池
       └─ 分支 AnalysisRun B：发布回归假设
            ├─ 证据：发布记录、版本差异、错误日志
            └─ 建议：回滚版本
```

### 长期记录策略

- `run_events` 采用追加式不可变记录：包含 `id`、`incidentId`、`runId`、`parentEventId`、`type`、`payload`、`createdAt` 与 schema version。
- `parentEventId` 将关键诊断节点组织成轻量树；同一 Incident 可以从任一证据或结论发起新的 `AnalysisRun`，保留原诊断路径。
- 原始日志、指标快照和大工具输出不直接塞入事件 payload；保存到受访问控制的 Evidence 存储，事件只引用 `evidenceId`、摘要、时间范围与内容哈希。
- `analysis_runs` 保存运行配置快照：模型、提示词/Playbook 版本、工具权限快照、发起人、起止时间和最终状态，确保之后可以解释或复跑。
- 审批、执行与策略决策作为独立事件永久保留，不能被新的分析结果覆盖。

### 检查点与上下文恢复

长时间故障会积累大量证据。每个关键阶段创建 `ContextCheckpoint`：持久化结构化工作摘要和最近保留的上下文。恢复或重新运行时，Agent 从最近检查点、近期事件和关联证据引用重建上下文，不必重放所有原始日志。

检查点至少记录：已确认事实、已排除/待验证假设、证据 ID、未解决问题、行动建议与审批状态。它类似 Pi 的 compaction checkpoint，但 OpsPilot 的原始事件和证据始终保留，因此摘要可重新生成并被审计。

### MVP 范围

第一版实现“一个 Incident 下可多次运行分析 + 保留每次运行的完整事件时间线 + 从上一运行的检查点重新分析”。不需要实现通用聊天树选择器；控制台只需提供“基于此证据重新分析”和“查看历史诊断运行”两个入口。

## 工具与安全边界

模型不能直接执行生产操作。每个工具调用均通过工具网关：

```text
LLM tool call
  → Zod 参数校验
  → Tool Policy Gate（身份、环境、风险、幂等、变更窗口）
  → 只读操作：执行并保存证据
  → 高风险写操作：创建 ProposedAction 和 Approval
  → 审批通过：Worker 使用受限服务身份执行并写审计
```

| 工具类别          | 示例                              | 默认执行方式                               |
| ----------------- | --------------------------------- | ------------------------------------------ |
| `read`            | 查询日志、指标、服务依赖、Runbook | 自动执行；可并行；短超时与结果上限         |
| `write-low-risk`  | 创建工单、发送通知                | 可配置自动执行；必须有审计和幂等键         |
| `write-high-risk` | 重启、扩容、回滚、切流            | 必须人工审批；单 Incident 串行执行与动作锁 |

每个工具元数据应包含 `riskLevel`、`executionMode`、`requiredPermission`、`timeoutMs` 和 `idempotency` 策略。记录策略决策、审批人、执行身份和关联的 Incident/Run ID。

### 模型 Tool 与运行时 Tool

模型只需要知道工具能做什么，不应获知连接器、权限、超时或执行实现。参照 Pi，将同一个工具按消费方分成两个递进的契约：

```ts
// packages/model-gateway：发给 LLM 的最小声明
export interface ToolDeclaration<TParameters> {
  readonly name: string;
  readonly description: string;
  readonly parameters: TParameters;
}

// packages/agent-runtime：Loop 使用的可执行工具
export interface RuntimeTool<TParameters, TResult>
  extends ToolDeclaration<TParameters> {
  readonly executionMode?: 'sequential' | 'parallel';
  execute(
    callId: string,
    parameters: TParameters,
    signal?: AbortSignal,
    onProgress?: (result: Partial<TResult>) => void,
  ): Promise<TResult>;
}
```

`model-gateway` 仅序列化 `ToolDeclaration` 并归一化 Provider 的 tool call；`agent-runtime` 用 `RuntimeTool` 进行参数准备、并发控制、取消和进度处理。`incident-agent` 直接依赖这两个层的原子类型，并定义 `IncidentTool extends RuntimeTool`，补充 `evidenceKind`、诊断语义及 `execute` 的业务实现；该实现委托 `tool-gateway` 完成模型不可见的 Zod 校验、Policy Gate、权限、超时、连接器调用和结果校验。`riskLevel`、`requiredPermission`、`timeoutMs`、输出 schema 与连接器配置属于 `tool-gateway`；`evidenceKind` 以及将结果持久化为 Evidence 的领域映射属于 `incident-agent`。因此 LLM 只能请求某个工具及其参数，不能绕过策略直接执行生产操作。

## 上下文与证据

不将所有日志与工具输出无限追加到模型上下文。上下文分为：

1. 稳定上下文：系统提示词、工具权限、服务目录和 Incident 基础信息。
2. 证据索引：原始工具输出保存到数据库或对象存储；模型获取截断摘要、时间范围和证据 ID。
3. 工作检查点：保存已验证事实、假设、待确认项和当前行动建议的结构化摘要。
4. 近期窗口：保留最近几轮关键工具结果和审批状态。

这既控制 token 成本，也保证结论可回溯到证据。

## 项目结构

```text
opspilot/
  apps/
    web/                    # Next.js：事故时间线、证据、审批
    api/                    # NestJS HTTP 模块：HTTP、鉴权、SSE、命令入口
    api-runtime/            # API 组合根：装配 application 用例与 Prisma 仓储后启动 API
    worker/                 # BullMQ：分析与已审批行动执行
  packages/
    agent-runtime/          # 通用 Agent loop；不包含故障领域知识
    incident-agent/         # 故障诊断业务 Agent：提示词、工具集、完成条件和领域映射
    application/            # 业务用例与仓储接口（计划新增）
    tool-gateway/           # 工具 schema、连接器、策略闸门、执行器
    domain/                 # 状态机、领域事件、Zod schema
    db/                     # Prisma schema、仓储、事务 outbox
    model-gateway/          # OpenAI 适配器与流事件归一化
    observability/          # Pino、OpenTelemetry、脱敏规则
    shared/                 # 前端可用 DTO 与客户端事件类型
  infra/
    docker-compose.yml
```

`apps` 是可独立启动的应用：`web` 提供浏览器控制台，`api` 提供 HTTP/SSE 接口，`worker` 消费后台分析与执行任务。`packages` 是这些应用复用的模块；`infra` 存放 Docker、数据库、Redis 与后续部署/监控配置，而不放业务代码。

```text
浏览器 → apps/web
             ↓
apps/api-runtime → apps/api → packages/application → packages/domain
       │                                      ↑
       └──────────── packages/db（Prisma）────┘
                              ↓
                         PostgreSQL

apps/worker → packages/incident-agent → packages/agent-runtime
                    ↓
               PostgreSQL、Redis
```

依赖方向遵循“底层不反向依赖上层”的原则：`model-gateway`、`observability` 可独立存在；`agent-runtime → model-gateway, observability`，但不依赖 `domain`、`application`、`shared` 或任何 app；`tool-gateway → model-gateway`，只使用模型层的原子 ToolDeclaration 类型，不依赖 Agent Loop 或业务领域；`incident-agent → model-gateway, agent-runtime, tool-gateway, application, domain`，它与 Pi 的 `pi-coding-agent` 一样可直接依赖底层原子类型和中层循环；`web → shared`；`api → application`；`api-runtime → api, incident-agent, application, db`，并作为唯一组合根绑定仓储实现和应用用例；`worker → incident-agent, application, db, observability`；`application → domain` 并声明仓储接口；`db → application, domain` 并用 Prisma 实现仓储接口。`domain` 不依赖 NestJS、BullMQ、Prisma 或模型 SDK。

### Agent 的三层结构

参考 Pi 的 `pi-ai → pi-agent-core → pi-coding-agent`，OpsPilot 将 Agent 能力分为三层：

```text
model-gateway                 # 模型 Provider、模型配置、消息与 ToolDeclaration 原子类型
        ↑                 ↑
agent-runtime             tool-gateway
        ↑                 ↑
        └── incident-agent ──┘ # 故障响应业务：IncidentTool、上下文、提示词、完成条件
        ↑
apps/api-runtime / apps/worker # 仅作组合根或任务宿主，不拥有诊断业务流程
```

`model-gateway` 不了解 Incident、Evidence、API DTO 或连接器；`agent-runtime` 不了解故障诊断领域；`tool-gateway` 不依赖 Agent Loop，只提供安全的工具执行能力；`incident-agent` 如同 Pi 的 `pi-coding-agent`，直接依赖 `model-gateway` 的原子类型和 `agent-runtime` 的循环类型，并且是唯一知道 Incident、Runbook、Evidence 与诊断策略的业务 Agent。当前 API 直跑和未来 Worker 异步运行都使用同一个 `incident-agent`，因此该包是有明确共同业务语义的边界，而不是泛化的公共包。

### 分层职责

- `domain`：定义 Incident、Run、状态机和领域错误；不负责数据库访问，也不负责编排调用流程。
- `application`：提供应用服务和仓储接口。仓储接口放在应用层，因为它们是应用用例所需的持久化能力。
- `db`：作为基础设施适配器，实现 `application` 的仓储接口；允许依赖 `application` 与 `domain`。
- `incident-agent`：故障响应业务 Agent。负责构造 Incident 上下文、配置系统提示词与允许的工具集合、定义诊断完成条件，并把通用 Loop 的结果映射为领域诊断和 Evidence；它是 API/Worker 共同调用的业务边界。
- `apps/api`：仅调用 `application` 服务；Controller 不直接访问 Prisma、仓储实现或数据库表。
- `apps/api-runtime`：唯一的 API 组合根，负责将 db 的仓储实现和 application 用例注入 Nest API，并管理数据库连接生命周期。
- `infra/`：仅存放 `docker-compose`、镜像、部署和监控配置，不放业务代码。

## 告警到 Agent 分析完成的处理流程

下面描述的是项目完成后的目标链路。它覆盖从外部告警提交，到 Agent 形成带证据诊断结果并完成一次 `AnalysisRun`；高风险 Action 的人工审批与实际执行属于后续链路。

```text
告警系统 / 用户
  → apps/api-runtime + apps/api
  → packages/application → packages/domain
  → packages/db → PostgreSQL
  → Outbox publisher → Redis / BullMQ
  → apps/worker
  → packages/agent-runtime
      ├─ packages/model-gateway
      └─ packages/tool-gateway → 日志 / 指标 / Runbook 等连接器
  → packages/application → packages/db → PostgreSQL
  → AnalysisRun COMPLETED、Evidence、RunEvent、ProposedAction
```

### 各模块职责

| 模块                     | 在“告警 → Agent 分析完成”中的职责                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`               | 供值班人员查看 Incident、分析进度、证据和诊断结果；经 HTTP/SSE 调用或订阅 API，不参与分析执行。                                                      |
| `apps/api-runtime`       | API 的组合根，类似 ASP.NET Core 的 `Program.cs`：创建数据库仓储、装配 application 用例和 Nest API，并管理数据库连接生命周期。                        |
| `apps/api`               | HTTP 接口层：接收 `POST /alerts`、校验请求、返回查询结果；Controller 只调用 application 用例，不直接访问 Prisma。                                    |
| `packages/shared`        | 前后端共享的告警请求/响应 DTO 与 Zod schema。                                                                                                        |
| `packages/application`   | 业务用例和仓储接口：创建 Incident、AnalysisRun、初始事件与 outbox 消息；后续推进 Run 生命周期并保存分析结果。                                        |
| `packages/domain`        | 核心业务规则：Incident/Run/Action 状态机、事件类型、领域 DTO，以及非法状态转换校验。                                                                 |
| `packages/db`            | 基础设施适配层：Prisma schema、仓储实现、数据库事务和 outbox 持久化；将业务事实保存到 PostgreSQL。                                                   |
| PostgreSQL               | 最终事实来源：保存 Incident、AnalysisRun、RunEvent、Evidence、Action、审批/执行审计和 OutboxMessage。                                                |
| Redis + BullMQ           | 异步任务调度：传递“分析此 Run”的后台 Job，并提供重试、延迟和并发控制；不作为审计事实的唯一来源。                                                     |
| `apps/worker`            | 独立的服务端后台进程：消费分析 Job、处理超时/重试/幂等，调用 Agent，并通过 application 用例持久化状态与结果。它不提供 HTTP 接口，也不是 Web 客户端。 |
| `packages/agent-runtime` | 通用 Agent Loop：管理模型回合、工具调用、并发、取消、进度和失败边界；不包含 Incident、Evidence 或诊断策略等领域知识。                              |
| `packages/incident-agent` | 故障诊断业务 Agent：直接使用模型层原子类型和通用 Loop，定义 `IncidentTool extends RuntimeTool`，提供 Incident 上下文、提示词、工具集、完成条件，并映射领域诊断与 Evidence。 |
| `packages/model-gateway` | 独立的模型适配层：仅处理 Provider、模型配置、模型消息和最小 ToolDeclaration；不依赖故障领域、工具执行或 API DTO。                                 |
| `packages/tool-gateway`  | 独立工具执行适配层：校验、策略闸门、权限、超时与日志/指标/Runbook 连接器；由 `incident-agent` 的 IncidentTool 委托调用，模型不可直接访问其执行细节。 |
| `packages/observability` | 记录脱敏后的结构化日志、trace、耗时、token 与成本；不记录完整提示词、原始日志、工具参数或密钥。                                                      |

### 一次分析的顺序

1. 告警系统或用户调用 `POST /alerts`。
2. `apps/api` 调用 `packages/application`；应用层按 `packages/domain` 的规则创建 `Incident(OPEN)`、`AnalysisRun(QUEUED)` 和 `alert.received` 事件。
3. `packages/db` 在同一 PostgreSQL 事务写入上述事实以及一条“分析此 Run”的 `OutboxMessage`。
4. Outbox publisher 将消息投递到 Redis/BullMQ；若 Redis 暂时故障，消息仍保留在 PostgreSQL 中等待重试。
5. `apps/worker` 消费 Job，将 Run 推进为 `RUNNING` 并追加 `run.started`；它负责重试、超时和幂等，而不包含模型或工具的具体实现。
6. Worker 调用 `packages/incident-agent`；它配置故障诊断上下文、创建 IncidentTool 后调用 `agent-runtime`。Loop 通过 `model-gateway` 获取模型决策；IncidentTool 将执行委托给 `tool-gateway`。
7. `incident-agent` 将工具结果映射为 Evidence；`packages/db` 持久化 Evidence，Agent 使用证据 ID 和摘要形成根因假设、置信度与行动建议。
8. Worker 经 `packages/application` 追加结果事件、保存 Evidence 引用和 ProposedAction，写入 `run.completed`，并将 Run 推进为 `COMPLETED`。

Worker 是后台任务执行宿主，Tool Gateway 才是具体工具执行与安全校验的边界：Worker 决定任务如何可靠运行，Agent 决定查什么，Tool Gateway 决定能否查以及如何调用连接器。

## 实现原则

- 使用 TypeScript 全栈与 Zod schema，保持 API、领域事件、工具输入输出的类型安全。
- 保持模块化单体架构；不急于拆分微服务或引入 Kubernetes。
- 先实现一个 OpenAI 适配器；用 `ModelGateway` 隔离供应商差异，但不做多 Provider 平台。
- 进度展示使用工具和业务事件，不显示或持久化模型思维链。
- trace 只记录 ID、名称、耗时、状态、token 与成本；不记录完整提示词、日志、工具参数、凭据或自由格式敏感信息。
- 维护故障案例评测集，衡量根因 Top-3 命中率、Runbook 引用正确率、平均分析耗时、工具调用成功率和人工审批响应时间。

## 迭代计划

1. **事件与状态机**：建立 Incident、AnalysisRun、RunEvent、ProposedAction、Approval 的 Prisma 模型与迁移。
2. **只读分析闭环**：接入模拟日志、指标与 Runbook；Agent 并行调用查询工具，保存证据与时间线。
3. **实时控制台**：用 SSE 展示运行进度、工具状态、最终结论和断线回放。
4. **审批与受控执行**：将高风险建议转为待审批 Action；批准后由 Worker 执行模拟重启/扩容并审计。
5. **上下文检查点与评测**：加入结构化摘要、token/成本统计和故障案例评测集。
6. **真实连接器与遥测**：最后接入 Prometheus/Loki/Kubernetes，并补充 OpenTelemetry。

## 首个可演示闭环

1. 接收一条“数据库连接池耗尽”告警，创建 Incident 与 AnalysisRun。
2. Worker 并行查询过去 15 分钟日志、指标和 Runbook，事件实时推送到控制台。
3. Agent 输出带证据引用的根因假设与“扩容或重启”建议。
4. 系统将建议创建为 `ProposedAction`，而非直接执行。
5. 值班工程师在审批页批准后，Worker 以受限身份执行模拟操作，记录审计和最终结果。

这个闭环能同时展示后端的状态机、异步可靠性、权限与审计设计，以及 AI 应用的 RAG、工具调用、流式交互和评测能力。

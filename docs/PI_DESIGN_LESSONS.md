# 从 Pi 项目借鉴的 OpsPilot 设计要点

## 结论

Pi 的价值不在于“支持很多模型”，而在于把 Agent 设计成了一个**有明确状态、可持久化、可观察、可受控扩展的运行时**。OpsPilot 应借鉴这套运行时思路，但不要照搬 Pi 作为通用编码 Agent 的复杂度。

对于运维故障响应场景，优先实现以下闭环：

```text
告警 → 创建事件与运行记录 → Agent 分析 / 调用只读工具 → 生成行动建议
     → 人工审批高风险行动 → 受控执行 → 写入审计与复盘材料
```

## Pi 的设计解读

| Pi 的设计 | 解决的问题 | 对 OpsPilot 的启发 |
| --- | --- | --- |
| 状态化 Agent 与显式事件流 | 前端、存储和运行逻辑不必轮询或猜测运行状态 | 将一次故障分析建模为 `incident run`，通过 SSE 推送状态和增量事件 |
| `beforeToolCall` / `afterToolCall` 钩子 | 模型有工具调用意图不代表可直接执行 | 把策略校验、审批创建、审计落库放在模型之外的工具网关 |
| 工具并行 / 串行执行策略 | 兼顾效率与有副作用操作的正确顺序 | 日志、指标、Runbook 查询可并行；重启、扩容、流量切换必须串行且审批后执行 |
| 会话树与分支摘要 | 支持从历史节点探索替代方案，不丢失上下文 | 为同一 Incident 保存多个诊断假设或行动方案；不必在 MVP 做完整聊天树 |
| JSONL 追加式会话记录与上下文压缩 | 长任务可恢复，且不会无限堆积模型上下文 | 用 PostgreSQL 的不可变事件记录替代 JSONL；将分析摘要作为上下文检查点 |
| Provider / Agent / UI 分层 | 模型供应商和交互界面不污染核心运行逻辑 | 用独立 `model-gateway` 和 `agent-runtime` 包隔离 OpenAI、DeepSeek 等模型差异 |
| 严格的协议和事件契约 | 流式客户端、服务端与持久化之间可以独立演进 | 将 REST 命令与 SSE 事件写为 Zod Schema，并在前后端共享类型 |
| 供应商无关的遥测契约 | 请求、工具、会话的诊断数据口径一致 | 建立 Agent、工具、审批和执行的 trace/span 规范；禁止记录敏感原始内容 |

Pi 的直接参考来源：

- `docs/pi/packages/agent/README.md`：Agent 事件序列、工具调用前后钩子、并行/串行工具策略。
- `docs/pi/packages/coding-agent/docs/session-format.md`：树状追加式记录、上下文构建与压缩检查点。
- `docs/pi/packages/coding-agent/docs/rpc.md`：增量事件、终态事件和工具进度的协议表达。
- `docs/pi/packages/telemetry/README.md`：类型化遥测 schema 与敏感数据边界。

## 应借鉴的具体设计

### 1. 将 Incident 和 Agent Run 分开建模

Pi 区分了会话、运行、轮次和消息。OpsPilot 也不应把一次“故障”简单做成一段聊天记录。

建议的层次：

```text
Incident（一次故障事件）
  └─ AnalysisRun（一次诊断尝试，可重试或重新发起）
       ├─ RunEvent（模型、工具、审批、执行的不可变事件）
       ├─ ToolInvocation（一次工具调用及其输入输出摘要）
       ├─ ProposedAction（模型提出的操作建议）
       └─ Approval / Execution（人工决策与实际执行）
```

好处是：同一个告警可以重跑分析、切换模型、让人工补充信息，而不会覆盖原先的证据和决策过程。

推荐状态：

```text
Incident: OPEN → INVESTIGATING → MITIGATING → RESOLVED / CLOSED
AnalysisRun: QUEUED → RUNNING → WAITING_APPROVAL → COMPLETED / FAILED / CANCELLED
Action: PROPOSED → PENDING_APPROVAL → APPROVED / REJECTED → EXECUTING → SUCCEEDED / FAILED
```

### 2. 事件优先：事件是事实，页面状态是投影

Pi 用细粒度事件描述 `message_start`、`message_update`、`tool_execution_start`、`tool_execution_end` 和最终完成。OpsPilot 应采用相同原则：先持久化事实事件，再由 API 和页面组装当前视图。

建议的事件类型：

```ts
type RunEventType =
  | "run.started"
  | "model.response.delta"
  | "model.response.completed"
  | "tool.requested"
  | "tool.started"
  | "tool.progressed"
  | "tool.completed"
  | "action.proposed"
  | "approval.requested"
  | "approval.decided"
  | "execution.started"
  | "execution.completed"
  | "run.completed"
  | "run.failed";
```

实现方式：Worker 每产生一个关键事件，先在数据库事务中写入 `run_events`，再发布 Redis 事件；SSE 网关将事件转发给对应 Incident 的订阅者。客户端断线后按最后收到的事件 ID 回放，而不是依赖内存中的流。

这比只把“最终回答”存入数据库更适合面试展示：可追踪、可恢复、可解释。

### 3. 模型只能提出工具意图；策略层决定是否执行

Pi 的 `beforeToolCall` 在参数通过校验后、工具真正执行前仍可阻断调用。这是 OpsPilot 最应该借鉴的安全边界。

不要让 LLM 直接调用 `restartService()`。应设计为：

```text
LLM tool call
  → Zod 参数校验
  → Tool Policy Gate（身份、环境、风险、幂等、变更窗口）
  → 低风险只读：执行
  → 高风险写操作：创建 ProposedAction 和 Approval，停止自动执行
  → 审批通过后：由 Worker 使用受限服务身份执行
```

建议工具按能力而非提示词分类：

| 类别 | 例子 | 默认策略 |
| --- | --- | --- |
| `read` | 查询日志、指标、服务依赖、Runbook | 自动执行，可并行 |
| `write-low-risk` | 创建工单、发送通知 | 可配置自动执行，写审计 |
| `write-high-risk` | 重启、扩容、回滚、切流 | 必须人工审批，串行执行 |

同时记录 `policyDecision`、审批人、执行身份、幂等键和关联的 Incident/Run ID。模型输出只是建议，审计记录才是系统事实。

### 4. 明确工具的并发语义与副作用

Pi 默认并行执行互不依赖的工具，但允许单个工具要求串行，从而把吞吐与安全区分开。

OpsPilot 可采用：

- `queryLogs`、`queryMetrics`、`searchRunbook`、`getServiceTopology`：并行；设置短超时和结果大小上限。
- `createTicket`、`sendIncidentUpdate`：可并行，但使用幂等键避免重复发送。
- `restartService`、`scaleDeployment`、`rollbackRelease`：单 Incident 串行；获取动作锁；审批批准后才允许调度。

不要只用“工具名称黑名单”控制风险。工具元数据应包含 `riskLevel`、`executionMode`、`requiredPermission`、`timeoutMs` 与 `idempotency` 策略，并由网关执行。

### 5. 用上下文检查点控制成本，而不是无限追加消息

Pi 将旧消息压缩为摘要，并连同保留的近期上下文形成可恢复的检查点。运维任务也会积累大量日志、指标和工具输出，若全部塞回模型，上下文会失控。

OpsPilot 的上下文应分层：

1. **稳定上下文**：系统提示词、工具权限、服务目录、当前 Incident 基础信息。
2. **证据索引**：工具原始输出放对象存储或数据库，只向模型提供截断摘要、时间范围和证据 ID。
3. **工作摘要**：每个关键阶段后生成结构化摘要，例如已验证事实、被排除假设、待确认项、当前行动建议。
4. **近期窗口**：保留最近几轮关键工具结果和审批状态。

结构化摘要优于纯自然语言摘要，例如：

```json
{
  "confirmedFacts": ["api-gateway 5xx 从 1.2% 升至 18.4%"],
  "hypotheses": [{"name": "连接池耗尽", "confidence": 0.82}],
  "evidenceIds": ["evt_01", "evt_02"],
  "actions": [{"id": "act_01", "status": "PENDING_APPROVAL"}],
  "openQuestions": ["数据库 CPU 是否在变更窗口后升高？"]
}
```

### 6. 将“可见进度”设计为领域事件，而非前端附属功能

Pi 的流式增量和工具进度事件使 UI 能展示 Agent 正在做什么。OpsPilot 的控制台应展示可审计的领域进度，而不是暴露模型思维链。

适合展示：

- “正在查询过去 15 分钟 API Gateway 日志”；
- “发现 3 条相关 Runbook，正在比对”；
- “已提出扩容建议，等待值班工程师审批”；
- 工具耗时、成功/失败、证据链接和最终决策。

不应展示或持久化：模型内部思维链、密钥、完整敏感日志、未经脱敏的用户/客户数据。

### 7. 为扩展预留受控契约，而不是把集成写进 Agent Prompt

Pi 将自定义消息、技能、模板和扩展状态分开；其中只有明确标记的消息进入 LLM 上下文。OpsPilot 可以对应为：

- **Connector 接口**：Prometheus、Loki/ELK、Kubernetes、Jira/飞书等；每个连接器只暴露受控工具。
- **Runbook/Playbook**：可版本化的知识与操作模板，而不是散落在系统提示词中。
- **Policy Plugin**：按环境、服务等级、用户角色和变更窗口判断工具调用是否允许。
- **Projection/UI Plugin**：把事件投影为时间线、事故报告、值班通知，不进入模型上下文。

MVP 不需要通用插件市场。先把 `ToolDefinition`、`Connector`、`PolicyDecision` 定义为清晰的 TypeScript 接口，未来再扩展。

### 8. Provider 抽象要轻，业务模型要稳定

Pi 将 Provider 适配与 Agent 核心隔离，因而可以更换模型而不重写会话或 UI。OpsPilot 可提供一个很小的接口：

```ts
interface ModelGateway {
  run(input: AgentInput, options: RunOptions): AsyncIterable<AgentModelEvent>;
}
```

`AgentInput` 和 `AgentModelEvent` 使用本项目的稳定类型；OpenAI、Anthropic 或其他供应商的请求格式只存在于适配器内部。第一版只实现 OpenAI 适配器即可，接口的目的在于隔离，而不是为了过早支持十几个供应商。

### 9. 遥测从第一天开始，但采用最小且安全的字段集

Pi 的 telemetry 包将 span 名称和属性做成类型化 schema，并明确提醒不要采集提示词、工具参数/输出、凭据及自由格式错误。这对运维系统尤其重要。

OpsPilot 第一版建议有以下 span：

```text
opspilot.incident.analysis
opspilot.model.request
opspilot.tool.execute
opspilot.approval.wait
opspilot.action.execute
```

建议属性：`incident.id`、`run.id`、`tool.name`、`risk.level`、`outcome`、`duration_ms`、`model.name`、token 用量与成本。避免将完整日志、用户输入、工具参数或 API key 放进 trace 属性；敏感证据只保存引用 ID 和访问控制信息。

## 建议的 TypeScript 模块调整

此前的 Monorepo 可以进一步明确为：

```text
apps/
  web/                    # Next.js：事故时间线、证据、审批
  api/                    # NestJS：HTTP、鉴权、SSE、命令入口
  worker/                 # BullMQ：分析与已审批行动执行
packages/
  agent-runtime/          # Agent loop、上下文构建、事件生成
  tool-gateway/           # 工具 schema、连接器、策略闸门、执行器
  domain/                 # Incident/Run/Action 状态机、领域事件、Zod schema
  db/                     # Prisma schema、仓储、事务 outbox
  model-gateway/          # OpenAI 适配器与流事件归一化
  observability/          # Pino、OpenTelemetry、脱敏规则
  shared/                 # 前端可用 DTO 与客户端事件类型
infra/
  docker-compose.yml
```

关键依赖方向：`web → shared`；`api/worker → domain, db, agent-runtime, tool-gateway, observability`；`agent-runtime → model-gateway, tool-gateway, domain`。`domain` 不依赖 NestJS、BullMQ、Prisma 或任何模型 SDK。

## 迭代顺序

1. **事件和状态机**：实现 Incident、AnalysisRun、RunEvent、ProposedAction、Approval 的数据库模型与迁移。
2. **只读分析闭环**：用模拟日志/指标连接器；Agent 并行调用查询工具；保存证据引用与时间线。
3. **SSE 与控制台**：支持运行进度、工具状态、最终结论及断线重连回放。
4. **审批与受控执行**：高风险建议只创建 `ProposedAction`；审批后由 Worker 执行模拟重启/扩容并审计。
5. **上下文检查点与评测**：加入结构化摘要、token/成本统计和故障案例评测集。
6. **真实连接器与可观测性**：最后再接 Prometheus/Loki/Kubernetes，并补充 OpenTelemetry。

## 不应在第一版照搬的部分

- 不做多 Provider 模型目录、OAuth、模型市场；一个 OpenAI 适配器足够。
- 不做完整会话树导航与跨分支摘要；用“重新运行分析 + 保存备选方案”替代。
- 不做二进制 RPC/CBOR 协议；REST + SSE + Zod 事件契约更符合 Web 控制台。
- 不做通用扩展加载器；先用内部 TypeScript 接口和显式注册表。
- 不做任意 Shell 工具。真实集群操作必须经 API/受限执行器，并受审批、RBAC、环境和幂等策略控制。

这样借鉴 Pi 的结果不是复刻一个编码 Agent，而是构建一个更符合生产运维特点的 Agent Runtime：**模型负责推理，策略层负责授权，事件层负责证据与恢复，Worker 负责可靠执行。**

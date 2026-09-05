# OpsPilot Agent Service

`agent-service/` 是 OpsPilot 的 TypeScript / Node.js Agent Service。当前业务层方向是 Conversation / Session；底层继续提供业务无关的 Agent Runtime、Model Gateway、Tool Gateway 和 Observability 基础设施。

## Current Direction

```text
Conversation / Session
          ↓
Application Use Case
          ↓
Agent Runtime
          ↓
Tool Gateway
```

当前 Agent Service 的结构：

```text
Agent Service
├── Application
│   ├── Conversations
│   └── Sessions
├── Agent Runtime
├── Model Gateway
└── Tool Gateway
```

Application 是业务编排边界，可以理解 OpsPilot 的 `Conversation`、`Session` 和 `FileReference` 等概念，并负责把这些概念转换为 Runtime 可消费的输入。

Agent Runtime 必须保持业务无关。Runtime 不允许出现 `FileId`、`Excel`、`OpsPilot Session`、`Conversation` 等业务概念，也不直接依赖 Application 的业务模型。Model Gateway 负责模型 Provider 边界，Tool Gateway 负责 Tool Contract、输入校验和外部能力适配。

## Application

Application 当前提供 SessionManager、JSONL session tree、最小 AgentSession、createAgentSession 及 RunConversationTurn 组合入口。

Conversation 当前通过 `RunConversationTurn` 编排一次用户 Conversation Turn：接收 `sessionId` 和用户消息，加载或创建 Session，调用 Agent Runtime，接收 Runtime 结果与事件，并更新 filesystem JSONL Session。

Session 负责生命周期和会话树语义。消息树不使用 PostgreSQL 保存，使用 JSONL / filesystem 持久化；更完整的 Session switching、分支管理扩展和上层业务用例仍待实现。

## Core Packages

- `packages/agent-runtime`：业务无关的 Agent 生命周期、Loop、State、Context、Tool Execution 和事件能力。
- `packages/model-gateway`：模型调用、Provider 适配、消息和流式响应契约。
- `packages/tool-gateway`：Tool Contract、运行时校验、Connector / Adapter 和外部能力边界。
- `packages/observability`：Agent Service 可观测性边界。

这些核心 package 的实现和公开契约保持独立，Application 通过明确边界使用它们。

## API Boundary

`apps/api` 提供当前 Conversation API；`apps/api-runtime` 负责 composition root 和 bootstrap。Backend 通过 HTTP 调用普通 Conversation endpoint。

当前接口：

- `POST /conversations/turns`：执行一次普通 JSON Conversation Turn。
- `POST /conversations/turns/stream`：以 SSE 透传 AgentEvent，并发送最终 `done` 事件。
- `GET /sessions/{sessionId}/history`：供 Backend 读取当前 active branch 的 UI-safe 历史 projection。

普通 Conversation 请求可以携带相对共享存储根目录的 Excel `storagePath`。`api-runtime` 将其安全解析为 Application 使用的绝对 `filePath`；SSE 和普通入口使用同一请求契约。

Session 使用 filesystem JSONL 持久化；API 通过 Application 的 `RunConversationTurn` 访问，不直接操作 SessionManager 或 Model Gateway。
历史恢复使用独立的 `buildConversationHistoryProjection()`，基于 `SessionManager.getBranch()` 读取完整原始消息；它不复用会受 Compaction 影响的 `buildSessionContext()`，也不改变 JSONL persistence format。

## Development

```bash
cd agent-service
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

启动 Agent Service：

1. `pnpm install`
2. 复制 `.env.example` 为 `.env`
3. 在 `.env` 中配置 `MOONSHOT_API_KEY`
4. 配置 `OPS_PILOT_SHARED_STORAGE_ROOT` 为 Backend 共享文件存储根目录
5. 根据需要设置 `DEFAULT_MODEL_PROVIDER` 和 `DEFAULT_MODEL_ID`
6. 执行 `pnpm dev:api`
7. 手动验证真实 Excel Tool Calling 可执行 `pnpm --filter @opspilot/application smoke:excel:kimi`

本地 Backend → Agent Service 联调时，`FileStorage:RootPath` 与
`OPS_PILOT_SHARED_STORAGE_ROOT` 必须指向同一个实际目录；Backend 保存的
`uploads/<file>.xlsx` 才能被 Agent Service 通过同一相对路径读取。

默认模型由 `DEFAULT_MODEL_PROVIDER` 和 `DEFAULT_MODEL_ID` 显式指定。`api-runtime` 会加载 `agent-service/.env`，并装配 Model Gateway、`RunConversationTurn` 和 filesystem SessionStore。

各 package 的具体职责和边界以其源码及 package README 为准。

# OpsPilot Agent Service

`agent-service/` 是 OpsPilot 的 TypeScript / Node.js Agent Service。业务层采用 Session / Turn / Step；底层继续提供业务无关的 Agent Runtime、Model Gateway、Tool Gateway 和 Observability 基础设施。

## Current Direction

```text
Session
          ↓
Turn Application Use Case
          ↓
Agent Runtime Step
          ↓
Tool Gateway
```

当前 Agent Service 的结构：

```text
Agent Service
├── Infrastructure
├── Application
│   ├── Turns
│   └── Sessions
├── Session Domain (`packages/domain`)
├── Agent Runtime
├── Model Gateway
└── Tool Gateway
```

Application 是业务编排边界，可以理解 OpsPilot 的 `Session`、`Turn` 和 `FileReference` 等概念，并负责把这些概念转换为 Runtime 可消费的输入。它定义 `SessionStore` 与 `TurnStore` port；filesystem adapter 位于 `packages/infrastructure`，由 `apps/api-runtime` 组合。

Live UI recovery 使用独立的 Application `TurnStreamEvent`、`TurnStreamProjection` 和
`TurnStreamHub`。`TurnEvent` 是 durable execution fact；`TurnStreamEvent` 与 projection
是进程内 ephemeral UI state，reattach 只是恢复观看，不会 resume 执行。Hub 的 replay
buffer 与 projection 在进程重启后允许丢失。

Agent Runtime 必须保持业务无关。Runtime 不允许出现 `FileId`、`Excel`、`OpsPilot Session`、`Conversation` 等业务概念，也不直接依赖 Application 的业务模型。Model Gateway 负责模型 Provider 边界，Tool Gateway 负责 Tool Contract、输入校验和外部能力适配。

## Application

Application 当前依赖 `@opspilot/domain` 提供纯内存 `Session` 与 `Turn` aggregate，并提供 `SessionStore`、`TurnStore` port、最小 AgentSession、createAgentSession 及 `ExecuteTurn` 组合入口。`@opspilot/infrastructure` 提供 filesystem adapter。

`ExecuteTurn` 编排一次用户 Turn：接收可选 `sessionId` 和用户消息，加载或创建 Session，创建并持久化 Turn，提交用户输入后调用 Agent Runtime，并通过 `SessionStore` 与 `TurnStore` 更新 durable state。具体 filesystem 实现由 `@opspilot/infrastructure` 提供。

Domain Session 负责 metadata、identity、entry、会话树、branch 和 compaction invariants；它不依赖文件系统。Infrastructure 的 FileSystemSessionStore 负责文件创建、加载和 append-only 持久化；Application 不依赖该具体实现。

Session filesystem layout 为：

```text
sessions/{sessionId}/
├── metadata.json
└── history.jsonl
```

`metadata.json` 是可变 product metadata，使用 atomic replace；`history.jsonl` 保持现有 header + entry 的 append-only 格式。旧的 `sessions/{sessionId}.jsonl` 在首次成功 load 时 lazy migrate，迁移复制原始 history bytes，且保留旧文件不做 destructive cleanup。新目录优先；新目录不完整时明确报告损坏，不回退旧文件。

## Core Packages

- `packages/agent-runtime`：业务无关的 Agent 生命周期、Loop、State、Context、Tool Execution 和事件能力。
- `packages/domain`：纯内存 Session aggregate、SessionEntry、树/branch 和 compaction invariants；不依赖 JSONL 或文件系统。
- `packages/infrastructure`：实现 Application 的 SessionStore port，负责 Session metadata、JSONL history、legacy migration 和 filesystem atomic write。
- `packages/model-gateway`：模型调用、Provider 适配、消息和流式响应契约。
- `packages/tool-gateway`：Tool Contract、运行时校验、Connector / Adapter 和外部能力边界。
- `packages/observability`：Agent Service 可观测性边界。

这些核心 package 的实现和公开契约保持独立，Application 通过明确边界使用它们。

## API Boundary

`apps/api` 提供 Session / Turn API；`apps/api-runtime` 负责 composition root 和 bootstrap。Backend 通过 HTTP 调用 Turn endpoint。

当前接口：

- `POST /turns`：执行一次普通 JSON Turn，可通过 body 中的 `sessionId` 继续已有 Session。
- `POST /turns/stream`：启动 Turn 并连接首个 live SSE subscriber（旧调用方仍可使用）。
- `POST /sessions/{sessionId}/turns`：在指定 Session 上执行 Turn。
- `POST /sessions/{sessionId}/turns/stream`：在指定 Session 上启动 Turn 并连接首个 live SSE subscriber。
- `GET /sessions/{sessionId}/history`：供 Backend 读取当前 active branch 的 UI-safe 历史 projection。
- `GET /sessions/{sessionId}/active-turn`：读取当前进程中可 reattach 的 live Turn 及 projection。
- `GET /turns/{turnId}/stream?after=N`：订阅已有 Turn 的 live stream；不会创建或重新执行 Turn。

普通 Turn 请求可以携带相对共享存储根目录的 Excel `storagePath`。`api-runtime` 将其安全解析为 Application 使用的绝对 `filePath`；SSE 和普通入口使用同一请求契约。

Session 与 Turn 通过 Infrastructure 的 filesystem adapter 分别持久化；API 通过 Application 的 `ExecuteTurn` 访问，不直接操作 Domain Session、Turn 或 Model Gateway。
历史读取使用独立的 `buildSessionHistoryProjection()`，基于 `Session.getBranch()` 读取完整原始消息；它不复用会受 Compaction 影响的 `buildSessionContext()`，也不改变 JSONL persistence format。

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
4. 配置 `OPS_PILOT_SHARED_STORAGE_ROOT` 为 Backend 共享文件存储根目录；Turn/Session durable state 不写入此目录
5. 根据需要设置 `SESSION_DIRECTORY`、`TURN_STORAGE_ROOT`、`DEFAULT_MODEL_PROVIDER` 和 `DEFAULT_MODEL_ID`
6. 执行 `pnpm dev:api`
7. 手动验证真实 Excel Tool Calling 可执行 `pnpm --filter @opspilot/api-runtime smoke:excel:kimi`

本地 Backend → Agent Service 联调时，`FileStorage:RootPath` 与
`OPS_PILOT_SHARED_STORAGE_ROOT` 必须指向同一个实际目录；Backend 保存的
`uploads/<file>.xlsx` 才能被 Agent Service 通过同一相对路径读取。

默认模型由 `DEFAULT_MODEL_PROVIDER` 和 `DEFAULT_MODEL_ID` 显式指定。`api-runtime` 会加载 `agent-service/.env`，并装配 Model Gateway、`ExecuteTurn`、FileSystemSessionStore、FileSystemTurnStore 和共享的 `InMemoryTurnStreamHub`。Session 默认写入 `data/sessions`，Turn 默认写入 `data/turns`；`OPS_PILOT_SHARED_STORAGE_ROOT` 仅用于 Backend 共享文件和 Excel uploads。

各 package 的具体职责和边界以其源码及 package README 为准。

# OpsPilot Agent Service Project

Agent Service 是 OpsPilot 中独立的 TypeScript / Node.js 服务。当前方向是围绕 Session / Turn / Step 建立业务应用层，并复用业务无关的 Agent Runtime、Model Gateway、Tool Gateway 和 Observability 能力。

## 1. Positioning

OpsPilot 的进程关系保持为：

```text
Web（Vue / TypeScript）
        ↓
Backend（ASP.NET Core）
        ↓
Agent Service（Node.js / TypeScript）
```

Agent Service 内部当前整理为：

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

Session Domain 负责纯内存 Session aggregate；Application 负责用例编排、projection 和 `SessionStore` port；Infrastructure 提供 filesystem adapter。应用层不依赖 Infrastructure。

## 2. Application Boundary

Application 位于业务概念和通用 Runtime 之间：

```text
Session
          ↓
Turn Application Use Case
        ↓
Agent Runtime
        ↓
Tool Gateway
```

Application 当前围绕以下业务概念编排：

- `Session`：持久化 context aggregate
- `Turn`：一次完整 Application execution
- `Step`：Agent Runtime 内部的一次 loop iteration

`turns/` 目录负责一次 Turn 的编排，包含：

- 接收可选 `sessionId` 和 user message
- 创建并持久化 Turn
- 将 user message durable commit 到 Session
- 从 Session context 构建 AgentSession 并调用 `continue()`
- 记录 TurnEvent 并推进 TurnCheckpoint
- 完成、失败或取消 Turn

当前核心用例为 `ExecuteTurn`，负责创建 Turn、提交 Session 输入、驱动 AgentSession，并持久化 TurnEvent 与 checkpoint。

Agent Runtime 必须保持业务无关，不出现 `FileId`、`Excel`、`OpsPilot Session`、`Conversation` 等 Application 业务概念。Runtime 只处理通用的 Agent、Model、Message、Tool 和事件契约。

## 3. Session Boundary

Session Domain 与 Application Session 目录分别负责：

- Domain Session 生命周期、identity 和 tree invariants
- `SessionEntry`
- `id` / `parentId` 会话树
- 当前 leaf
- branch
- Application `buildSessionContext`
- `FileReference` 等 OpsPilot 扩展 entry

Session 现在是用户可见长期会话的 Domain aggregate，由两个逻辑部分组成：

```text
Session
├── SessionMetadata
│   ├── id
│   ├── title
│   ├── createdAt
│   └── updatedAt
└── Session History Tree
```

Infrastructure 的 filesystem persistence 使用：

```text
sessions/{sessionId}/
├── metadata.json   # mutable metadata, atomic replace
└── history.jsonl   # append-only history
```

旧的 `sessions/{sessionId}.jsonl` 仅在新目录不存在时读取，并在成功 restore 后 lazy migrate；迁移复制原始 history bytes、保留 legacy 文件。新目录优先，不完整的新目录不会 fallback 到 legacy。应用层通过 `ResumeTurn` 从 durable checkpoint 恢复执行，`RecoverTurnsOnStartup` 在 API runtime listen 前串行扫描；blocked/unrecoverable Turn 保持 `interrupted`，不会阻止服务启动。

Session 不使用 PostgreSQL 保存消息树。Application 只定义 `SessionStore` port；Infrastructure 的 JSONL/filesystem adapter 负责持久化，Domain Session 不依赖 JSONL、Node fs 或 repository。

当前已实现：

- `@opspilot/domain` Session
- `@opspilot/domain` Turn / TurnEvent / TurnCheckpoint
- `@opspilot/infrastructure` FileSystemSessionStore
- `@opspilot/infrastructure` FileSystemTurnStore / FileSystemTurnExecutionContextStore
- Infrastructure JSONL create / load / append
- Session 读写、分支和 compaction invariants

## 4. Core Runtime Packages

### Agent Runtime

`packages/agent-runtime` 提供业务无关的 Agent 生命周期、Agent Loop、State、Context、Tool Execution、Streaming、Cancellation 和 Runtime 事件能力。它不依赖 Application 的 Session、Turn 或文件业务概念。

### Model Gateway

`packages/model-gateway` 封装模型 Provider 差异，并提供模型、消息、Tool Declaration、Streaming 和响应相关的稳定契约。它不负责 Application 编排或 Session 持久化。

### Tool Gateway

`packages/tool-gateway` 提供 Tool Contract、输入校验、Connector / Adapter 和外部能力执行边界。它不负责 Agent Loop、Session 管理或业务用例编排。

### Observability

`packages/observability` 作为 Agent Service 的可观测性边界保留。其实现和公开契约不属于本次目录调整范围。

### Infrastructure

`packages/infrastructure` 实现 Application 的 `SessionStore` / `TurnStore` port，封装 metadata JSON、append-only JSONL、legacy session migration 和 atomic filesystem writes。它可以依赖 Application contract 与 Domain，但 Application 不反向依赖它。

## 5. API Status

`apps/api` 提供 Session / Turn HTTP boundary：

- `POST /turns` 与 `POST /turns/stream`
- `POST /sessions/:sessionId/turns` 与对应 stream endpoint
- `GET /sessions/:sessionId/history`

SSE 仅透传当前执行 observer，不提供 replay、reattach 或 ResumeTurn。

Runtime durable state 使用独立的 Agent Service storage root：`SESSION_DIRECTORY` 默认指向 `data/sessions`，`TURN_STORAGE_ROOT` 默认指向 `data`，因此 Turn 位于 `data/turns`。`OPS_PILOT_SHARED_STORAGE_ROOT` 只用于 Backend 共享文件和 Excel uploads，不承担 Session / Turn execution state。

## 6. Persistence Direction

当前 Application 不创建数据库表。Session 消息树使用 Application 的 `SessionStore` 抽象和 Infrastructure 的 JSONL / filesystem 实现；后续可以在不修改 Domain Session 的前提下加入其他 repository。

## 7. Workspace Layout

```text
agent-service/
├── apps/
│   ├── api/
│   └── api-runtime/
├── packages/
│   ├── infrastructure/
│   │   ├── src/session/
│   │   └── src/turn/
│   ├── domain/
│   │   └── src/session/
│   ├── application/
│   │   └── src/
│   │       ├── turns/
│   │       ├── session-history/
│   │       ├── session/
│   │       └── session-store/
│   │       └── index.ts
│   ├── agent-runtime/
│   ├── model-gateway/
│   ├── tool-gateway/
│   └── observability/
├── config/
├── docs/
├── README.md
└── PROJECT.md
```

## 8. Verification

在 `agent-service/` 目录运行：

```bash
pnpm typecheck
pnpm test
pnpm build
```

本次改动不改变 Agent Runtime、Model Gateway、Tool Gateway 和 API 的业务行为或公开契约；SessionStore filesystem 实现位于 Infrastructure，Application 只保留 persistence port。

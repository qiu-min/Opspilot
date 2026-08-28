# OpsPilot Agent Service Project

Agent Service 是 OpsPilot 中独立的 TypeScript / Node.js 服务。当前方向是围绕 Conversation / Session 建立业务应用层，并复用业务无关的 Agent Runtime、Model Gateway、Tool Gateway 和 Observability 能力。

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
├── Application
│   ├── Conversations
│   └── Sessions
├── Agent Runtime
├── Model Gateway
└── Tool Gateway
```

本次只完成旧代码清理和 Application 目录骨架调整，不实现业务用例、Session 持久化或 HTTP API。

## 2. Application Boundary

Application 位于业务概念和通用 Runtime 之间：

```text
Conversation / Session
        ↓
Application Use Case
        ↓
Agent Runtime
        ↓
Tool Gateway
```

Application 可以理解以下 OpsPilot 业务概念：

- `Conversation`
- `Session`
- `FileReference`

Conversation 目录未来负责一次用户 Conversation Turn 的编排，包含：

- 接收 `sessionId`、user message 和 file references
- 加载 Session
- 构建 Agent Context
- 调用 Agent Runtime
- 接收 Agent Runtime 结果和事件
- 更新 Session

未来核心用例可命名为 `RunConversationTurn`，但当前没有实现。

Agent Runtime 必须保持业务无关，不出现 `FileId`、`Excel`、`OpsPilot Session`、`Conversation` 等 Application 业务概念。Runtime 只处理通用的 Agent、Model、Message、Tool 和事件契约。

## 3. Session Boundary

Session 目录未来负责：

- Session 生命周期
- Pi 风格 JSONL Session 持久化
- `SessionEntry`
- `id` / `parentId` 会话树
- 当前 leaf
- branch
- `buildSessionContext`
- `FileReference` 等 OpsPilot 扩展 entry

Session 不使用 PostgreSQL 保存消息树。未来 Session 持久化采用 JSONL / filesystem。

当前尚未实现：

- `SessionManager`
- JSONL Store
- 具体 Entry 类型
- Session 读写和分支操作

## 4. Core Runtime Packages

### Agent Runtime

`packages/agent-runtime` 提供业务无关的 Agent 生命周期、Agent Loop、State、Context、Tool Execution、Streaming、Cancellation 和 Runtime 事件能力。它不依赖 Application 的 Conversation、Session 或文件业务概念。

### Model Gateway

`packages/model-gateway` 封装模型 Provider 差异，并提供模型、消息、Tool Declaration、Streaming 和响应相关的稳定契约。它不负责 Application 编排或 Session 持久化。

### Tool Gateway

`packages/tool-gateway` 提供 Tool Contract、输入校验、Connector / Adapter 和外部能力执行边界。它不负责 Agent Loop、Session 管理或业务用例编排。

### Observability

`packages/observability` 作为 Agent Service 的可观测性边界保留。其实现和公开契约不属于本次目录调整范围。

## 5. API Status

`apps/api` 保留为 API 项目和通用 HTTP 基础设施，以便未来接入 Application。当前不实现：

- Conversation API
- Session API
- Controller 或 Route
- DTO
- SSE 或 WebSocket
- ASP.NET Backend 连接

API runtime 当前只保留能够构建通用 API 模块的组合根，不绑定数据库或未实现的 Application 用例。

## 6. Persistence Direction

当前 Application 不包含 Session 存储实现。未来 Session 消息树使用 JSONL / filesystem；本次不创建数据库表，也不实现 JSONL Store 或 `SessionManager`。

## 7. Workspace Layout

```text
agent-service/
├── apps/
│   ├── api/
│   └── api-runtime/
├── packages/
│   ├── application/
│   │   └── src/
│   │       ├── conversations/
│   │       │   ├── ports/
│   │       │   └── sessions/
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

本次改动不改变四个核心 package 的实现或公开契约。

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

Application 当前只建立 Conversation / Session 的目录骨架，尚未实现具体业务逻辑或 API。

Conversation 未来负责编排一次用户 Conversation Turn：接收 `sessionId`、用户消息和文件引用，加载 Session，构建 Agent Context，调用 Agent Runtime，接收 Runtime 结果与事件，并更新 Session。未来核心用例可以命名为 `RunConversationTurn`，本次尚未实现。

Session 未来负责生命周期和会话树语义。消息树不使用 PostgreSQL 保存，计划使用 JSONL / filesystem 持久化；`SessionManager`、JSONL Store、具体 SessionEntry 类型和相关读写流程均尚未实现。

## Core Packages

- `packages/agent-runtime`：业务无关的 Agent 生命周期、Loop、State、Context、Tool Execution 和事件能力。
- `packages/model-gateway`：模型调用、Provider 适配、消息和流式响应契约。
- `packages/tool-gateway`：Tool Contract、运行时校验、Connector / Adapter 和外部能力边界。
- `packages/observability`：Agent Service 可观测性边界。

这些核心 package 的实现和公开契约保持独立，Application 通过明确边界使用它们。

## API Boundary

`apps/api` 保留为 Agent Service 的 API 项目和通用 HTTP 基础设施，但当前不实现 Conversation API，也不提供 Session 创建、消息提交、SSE、WebSocket、Controller、Route 或业务 DTO。本次不连接 ASP.NET Backend。

## Development

```bash
cd agent-service
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

各 package 的具体职责和边界以其源码及 package README 为准。

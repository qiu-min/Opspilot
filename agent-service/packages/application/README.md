# @opspilot/application

OpsPilot Agent Service 的应用层。

`application` 位于业务入口与通用 Agent Runtime 之间，负责围绕 Session 组织 Agent 的实际使用流程，并协调运行时、会话状态、上下文、工具与持久化 port。

当前已提供最小 `AgentSession` 闭环：从 Domain `Session` 恢复消息、模型和 thinking level，组合 `Agent` 与 `ModelGateway`，并通过 Application 的 `SessionStore` 在 Runtime `message_end` 之后 append finalized message。

## Session persistence

`Session` 是用户可见长期会话的 Domain aggregate，由 `SessionMetadata` 和 history tree 组成。Application 只定义 `SessionStore` port；`@opspilot/infrastructure` 的 `FileSystemSessionStore` 使用以下新布局：

```text
sessions/{sessionId}/
├── metadata.json   # mutable metadata, atomic replace
└── history.jsonl   # append-only Session history
```

`metadata.json` 保存 versioned filesystem record；`history.jsonl` 保留现有 Session header 和 entry 格式。旧的 `sessions/{sessionId}.jsonl` 会在首次成功读取后非破坏性 lazy migrate 到新目录，旧文件保持不变；新目录优先，且不完整的新目录不会 fallback 到旧文件。

`SessionStore.appendEntry()` 先追加 history，再原子更新 `metadata.updatedAt`；metadata update 失败会明确抛错，下一次 load 会根据 durable history reconciliation。`saveMetadata()` 通过 temp file + rename 原子替换整个 metadata snapshot。

Application 同时定义 `TurnStore` 与 `TurnExecutionContextStore` port。Turn snapshot、append-only `TurnEvent` history 和最小执行输入是独立的 durable execution boundary，不写入 Session JSONL；`TurnRecoveryPlanner`、`ResumeTurn` 与 `RecoverTurnsOnStartup` 负责进程 crash 后的执行恢复。

## Live Turn stream

Application 还定义独立的 `TurnStreamEvent` presentation contract、纯 reducer
`applyTurnStreamEvent()`、`TurnStreamProjector` 和 `TurnStreamHub` port。Projector 将
`AgentSessionEvent` 转成 UI-safe live facts；reasoning/thinking delta 只会变成
`assistant_thinking_started` / `assistant_thinking_completed`，不会传输隐藏 reasoning 文本。

`TurnStreamProjection` 只保存当前 Turn 的 partial assistant text、thinking 状态、tool
状态（可带由注入的 `ToolPresentationResolver` 生成的 UI-safe `ToolDisplayInfo`）、compaction 状态、usage 和 `lastSequence`，不替代 Session history，也不暴露
`MutableAgentState`。`TurnStreamEvent.sequence` 由 Hub 从 0 开始独立分配，和 durable
`TurnEvent.sequence` 无关。Hub 在内存保留有限 replay buffer（默认 256）；丢失范围会以
`TurnStreamReplayGapError` 明确报告。

SSE disconnect 只取消当前 subscriber，不会调用 `AgentSession.abort()` 或取消
`ExecuteTurn`。terminal stream event 发送后 subscriber 正常结束，live Session mapping
被移除。reattach 与 resume 是不同语义：reattach 只恢复观看，resume 使用 durable
checkpoint 恢复同一个 Turn 的执行。

## 职责

本包主要负责：

- 创建、恢复和管理 Agent Session
- 通过 `SessionStore` port 协调 Domain Session mutation 与持久化
- 通过 `TurnStore` port 保存 Application Turn snapshot 与 durable execution events
- 接收用户输入并驱动一次 Agent Run
- 将 Session 上下文恢复到 Agent Runtime
- 通过 `ContextManager` 决定单次模型调用看到的消息
- 通过 Context Accounting 估算上下文用量并判断是否接近模型窗口
- 监听 Agent Runtime 产生的消息与执行事件
- 将完成的消息、工具结果等写入 Session
- 组织 Session 的创建、继续、切换与后续扩展能力
- 组合具体 Agent 所需的模型配置、System Prompt 与工具
- 向上层 API 提供稳定的应用用例接口

当前范围暂不包含动态切换模型或 thinking level、复杂重试、扩展系统和 Session 切换等 Coding Agent 能力。

## Context 边界

Domain `Session` 保存完整会话事实与树 invariant；Application 的 `buildSessionContext(session)` 将 durable state 投影成 Agent Runtime 输入。`ContextManager` 只决定本次模型调用使用哪些 `AgentMessage`，不依赖或修改 Domain Session。`createAgentSession` 将 ContextManager 接入 Agent Runtime 的 `transformContext` hook，因此经过 ContextManager 的消息只影响当前模型调用，不影响后续 Session 持久化。

Web 历史恢复使用独立的 `buildSessionHistoryProjection()`：它读取
`Session.getBranch()` 的完整 active branch，保留原始 entry 顺序和 id，并输出 UI-safe 的 user / assistant 可见 text 以及 tool execution 的 callId、name、status。它不复用会受 Compaction 影响的 `buildSessionContext()`，也不会把 AgentMessage 的 thinking、provider、model metadata 或 tool raw output 暴露到 UI。

Phase 1 的默认 `DefaultContextManager` 不裁剪消息，只返回输入消息的副本。Context Accounting 仅负责测量上下文用量与判断阈值。

Context Accounting 是独立的纯计算边界：它优先使用最近有效 AssistantMessage 的 `Usage`，再估算其后的新增消息，并通过 `shouldCompact()` 返回是否达到预留 token 阈值。

Phase 3 支持正常 Agent Run 完成后的自动 Compaction：生成摘要并追加 `CompactionEntry`，但不删除原始消息。Compaction 失败时保持本轮结果和原始 Session 可恢复。当前 System Prompt 由 Application 层的 `buildOpsPilotSystemPrompt()` 纯函数构建，并由 runtime composition 注入；Memory、RAG、动态 Prompt 资源加载、工具输出治理和 overflow recovery 不属于当前实现范围。

核心关系：

```text
API / Transport
      │
      ▼
application
      │
      ├── @opspilot/domain Session
      ├── SessionStore port
      │
      ├── Agent configuration
      │
      └── Runtime orchestration
      │
      ▼
@opspilot/domain
      │
      ▼
agent-runtime
      │
      ├── model-gateway
      └── AgentTool
              │
              ▼
         tool-gateway
```

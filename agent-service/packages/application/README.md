# @opspilot/application

OpsPilot Agent Service 的应用层。

`application` 位于业务入口与通用 Agent Runtime 之间，负责围绕 Session 组织 Agent 的实际使用流程，并协调运行时、会话状态、上下文、工具与持久化能力。

当前已提供最小 `AgentSession` 闭环：从 `SessionManager` 恢复消息、模型和 thinking level，组合 `Agent` 与 `ModelGateway`，并通过 Runtime 的 `message_end` 事件持久化后续 finalized message。

## 职责

本包主要负责：

- 创建、恢复和管理 Agent Session
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

`SessionManager` 保存完整会话事实；`ContextManager` 只决定本次模型调用使用哪些 `AgentMessage`，不依赖或修改 `SessionManager`。`createAgentSession` 将 ContextManager 接入 Agent Runtime 的 `transformContext` hook，因此经过 ContextManager 的消息只影响当前模型调用，不影响后续 Session 持久化。

Phase 1 的默认 `DefaultContextManager` 不裁剪消息，只返回输入消息的副本。Context Accounting 仅负责测量上下文用量与判断阈值。

Context Accounting 是独立的纯计算边界：它优先使用最近有效 AssistantMessage 的 `Usage`，再估算其后的新增消息，并通过 `shouldCompact()` 返回是否达到预留 token 阈值。

Phase 3 支持正常 Agent Run 完成后的自动 Compaction：生成摘要并追加 `CompactionEntry`，但不删除原始消息。Compaction 失败时保持本轮结果和原始 Session 可恢复。Memory、RAG、PromptBuilder、工具输出治理和 overflow recovery 不属于当前实现范围。

核心关系：

```text
API / Transport
      │
      ▼
 application
      │
      ├── Session
      │
      ├── Agent configuration
      │
      └── Runtime orchestration
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

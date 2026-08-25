# Agent Service Development Instructions

本文件定义 `agent-service/` 下的开发规范。

修改代码前应先阅读：

* `/AGENTS.md`
* `/README.md`
* `agent-service/README.md`
* `agent-service/PROJECT.md`
* 当前 package 的 README、相关调用方和测试

如果参考 `docs/pi`，先理解设计目的，再决定是否适合 OpsPilot。

Pi 是设计参考，不是实现规范，不要机械复制。

---

## 1. Architecture

保持核心依赖方向：

```text
Business / Application
        ↓
Agent Runtime
        ↓
Model Gateway
        ↓
Provider Adapter
        ↓
Model Provider
```

工具调用：

```text
Agent Runtime
        ↓
Tool Contract / Tool Gateway
        ↓
Tool Implementation / External Service
```

不得为了实现方便跨越边界直接调用底层实现。

---

## 2. Model Gateway

`model-gateway` 负责统一模型供应商差异，包括：

* Model Request / Response
* Streaming
* Tool Calling
* Thinking / Reasoning
* Provider Adapter
* Provider Error
* Model Capability

不负责：

* Agent Loop
* Tool Execution
* Agent State
* Conversation orchestration
* 业务流程

Agent Runtime 不得直接依赖 OpenAI、Moonshot、DeepSeek、Anthropic 等 Provider SDK。

Provider 特殊逻辑应尽量停留在 Adapter / Model Gateway。

避免：

```ts
if (provider === "moonshot") {
    // Agent Runtime special logic
}
```

---

## 3. Agent Runtime

`agent-runtime` 是领域无关的通用 Agent 运行时。

负责：

* Agent lifecycle
* Agent Loop
* Model invocation
* Context orchestration
* Tool Call orchestration
* Agent Event
* Agent State
* Termination
* Cancellation
* Runtime Error

不要向 Runtime 添加：

* Excel 业务逻辑
* 运维领域知识
* 数据库逻辑
* HTTP 业务逻辑
* 用户权限逻辑
* 具体 Provider 协议

Runtime 负责机制，不负责业务策略。

---

## 4. Tool Boundary

Tool 体系负责：

* Tool definition
* Tool schema
* Tool registration
* Tool lookup
* Argument validation
* Invocation contract
* Execution result
* Execution error

具体业务能力可以由 Tool 调用外部系统，但不要因此把业务实现搬进 Agent Runtime。

LLM 返回的 Tool Call 永远视为外部输入。

执行前必须验证：

* Tool 是否存在
* Arguments 是否合法
* Tool Call 是否可执行

---

## 5. Event / State / Context

必须严格区分三个概念。

### Event

表示：

> 刚刚发生了什么。

用于 Streaming、Trace、Observability。

### State

表示：

> Agent 当前是什么状态。

是运行时快照。

### Context

表示：

> 下一轮模型调用应该看到什么。

是模型输入。

三者不能因为数据相似而混用。

修改生命周期逻辑时必须明确：

```text
什么时候 emit event？
什么时候 update state？
什么时候 commit context？
```

Event 已发布不代表 Context 已提交。

State 已更新也不代表下一轮模型应该立即看到对应内容。

---

## 6. Model Event vs Agent Event

Model Event 描述一次模型调用过程，例如：

* Text Delta
* Thinking Delta
* Tool Call
* Model Completed
* Model Error

Agent Event 描述整个 Agent 生命周期，例如：

* Agent Started
* Turn Started
* Model Started
* Tool Execution Started
* Tool Execution Completed
* Turn Completed
* Agent Completed
* Agent Failed

不要直接把 Provider 原始事件暴露成 Agent Event。

---

## 7. Agent Loop

Agent Loop 应保持显式、简单、可追踪。

典型流程：

```text
prepare context
      ↓
invoke model
      ↓
inspect response
      ↓
tool calls?
   ↙       ↘
 no        yes
 ↓          ↓
finish   execute tools
              ↓
         commit results
              ↓
           next turn
```

优先显式循环，不要使用难以追踪的递归或隐藏控制流。

必须存在明确停止条件，例如：

* Normal completion
* terminate
* cancellation
* fatal error
* max turns

不得存在没有保护机制的无限 Agent Loop。

---

## 8. Turn and Context Commit

Turn 必须具有稳定语义。

修改 Turn 生命周期时检查：

* Model invocation
* Tool execution
* Agent Event
* State
* Context commit
* Termination

Conversation Context 修改必须具有明确提交时机。

尤其注意：

* Tool Call / Tool Result pairing
* Tool failure
* Cancellation
* terminate
* Multiple Tool Calls

不要让不完整的 Tool Call / Result 状态进入下一轮 Context。

---

## 9. Tool Execution

Tool execution 必须有明确结果。

不要使用：

```ts
return null;
```

表示失败。

执行工具时应考虑：

* Failure
* Timeout
* Cancellation
* Duplicate execution
* Retry
* Idempotency
* Partial failure

不要默认 Tool 可以安全 Retry。

多个 Tool Calls 并发执行前，应明确：

* 是否相互独立
* 是否共享状态
* Event 顺序
* Result 顺序
* Failure 行为
* terminate 行为

如果语义不明确，优先保证正确性，而不是直接并发。

---

## 10. terminate

`terminate` 是 Runtime 控制信号，不是普通文本。

如果项目支持 `terminate`，行为必须明确，包括：

* 是否继续执行剩余 Tool Calls
* Tool Result 是否提交 Context
* Event 如何结束
* Turn 是否正常结束
* Agent 最终状态是什么

不同工具执行策略下，`terminate` 语义必须一致。

如果当前契约尚未支持，不要为了“功能完整”擅自加入。

---

## 11. Errors

必须尽量保留错误来源。

至少区分：

* Provider Error
* Model Gateway Error
* Agent Runtime Error
* Tool Execution Error
* Validation Error
* Cancellation

不要把所有错误变成：

```ts
new Error("Agent failed")
```

而丢失原始 `cause`。

能够保留时，应保留必要的：

* source
* cause
* code
* provider
* model
* tool
* retryable

但不要为了形式创建巨大 Error 类型。

---

## 12. Cancellation / Timeout / Retry

长时间操作应传播 `AbortSignal`，包括：

* Model invocation
* Streaming
* Tool execution
* External HTTP
* Retrieval

取消 Agent 时，应尽可能取消底层仍在执行的操作。

所有外部调用都应考虑合理 Timeout。

Retry 只用于明确可重试错误。

通常可以考虑：

* Temporary network failure
* Rate limit
* Temporary provider failure

通常不要 Retry：

* Validation Error
* Authentication Error
* Invalid Tool Arguments
* Deterministic business error

有副作用的 Tool 在无法保证幂等时不要自动 Retry。

---

## 13. Public Contracts

核心公共类型应保持稳定，例如：

* Model Request / Response
* Model Stream Event
* Tool Call / Result
* Agent Event
* Agent State
* Agent Error

修改公共契约前：

1. 搜索所有消费者
2. 判断是否能在内部边界解决
3. 修改调用方
4. 更新测试
5. 检查 README

不要为了适配某个 Provider，把 Provider 原始 JSON 结构泄漏进公共类型。

公共契约表达 OpsPilot 的稳定语义，而不是供应商格式。

---

## 14. Type Design

尊重 TypeScript strict。

避免：

* `any`
* 无理由类型断言
* 多个互相依赖的 boolean 状态

优先使用 discriminated union，让非法状态尽可能无法表示。

例如：

```ts
type ToolExecutionResult =
  | { status: "success"; output: ToolOutput }
  | { status: "failed"; error: ToolExecutionError };
```

不要创建：

```ts
{
    isSuccess: true,
    isFailed: true
}
```

这种可能出现非法组合的状态模型。

---

## 15. RAG / Trace / Eval

RAG 不属于 Model Gateway。

RAG 更适合作为：

* Tool
* Context Provider
* Application Capability

不要让 Provider Adapter 访问 Vector Database 或拼装业务知识。

Trace / Observability 应观察 Runtime 生命周期，不应改变核心运行语义。

Eval 用于评价行为和结果，不要把 Eval 逻辑写进 Agent Loop 主流程。

---

## 16. Avoid Over-Engineering

不要因为未来可能支持：

* Multi-Agent
* Workflow
* Persistent Memory
* Human-in-the-loop
* Plugin System

就提前增加复杂抽象。

优先：

```text
真实需求
   ↓
出现稳定重复语义
   ↓
再抽象
```

不要：

```text
猜测未来需求
   ↓
提前建立复杂框架
```

---

## 17. Tests

核心生命周期行为应有测试保护。

重点检查：

### Model Gateway

* Normal completion
* Streaming
* Tool Call
* Thinking / Reasoning
* Provider Error
* Malformed Response
* Cancellation

### Agent Runtime

* Normal completion
* Tool Call
* Multiple Tool Calls
* Tool Failure
* Model Failure
* Cancellation
* Max Turns
* Termination
* Context Commit
* State Update
* Event Ordering

修改生命周期代码时，不仅验证事件存在，还应检查事件顺序。

Bug 修复应尽可能增加 Regression Test。

---

## 18. Validation

完成修改后，先检查真实 `package.json` scripts，再执行适用的：

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

Monorepo 中根据修改范围执行具体 package 或 workspace 验证。

不要虚构不存在的命令。

不得在存在已知：

* Type Error
* Test Failure
* Build Failure
* Lint Error

时声称任务完全完成。

---

## 19. Before Finishing

完成前检查：

* 是否破坏 Model Gateway / Agent Runtime 边界？
* Provider 特殊逻辑是否泄漏到 Runtime？
* 是否把业务逻辑塞进通用 Runtime？
* Event / State / Context 是否仍然清晰？
* Context commit 时机是否正确？
* Tool Call / Result 是否正确配对？
* Error 是否保留来源和 cause？
* Cancellation 是否向下传播？
* Retry 是否可能重复副作用？
* Agent Loop 是否有明确停止条件？
* 是否引入不必要抽象？
* 是否修改公共契约及其消费者？
* 是否需要更新测试或 README？
* 是否执行相关验证？

---

## Core Principle

Agent Service 的目标是：

> 用稳定清晰的契约隔离 Model、Agent、Tool 和业务之间的变化。

优先保证：

```text
Clear Boundary
+
Predictable Lifecycle
+
Explicit State
+
Stable Contract
+
Testable Behavior
```

当存在多种可行实现时，优先选择生命周期更明确、更容易理解和测试的实现。

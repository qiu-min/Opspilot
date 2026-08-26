# `@opspilot/agent-runtime`

通用 Agent Runtime，负责维护一次 Agent Run 的消息上下文、模型回合、批量工具调用和生命周期事件。业务层通过 `AgentLoopConfig` 注入模型、工具执行模式以及可选的 `shouldStopAfterTurn` 策略；Runtime 不包含 Incident、RAG 或具体业务完成条件。

## 基本流程

```text
runAgentLoop
  → 初始化 currentContext / newMessages
  → runLoop
      → 调用模型并维护 streamingMessage
      → 按 toolExecution 执行当前 Turn 的 ToolCall 批次
      → 写入 ToolResult
      → turn_end
      → 判断是否进入下一 Turn
```

## 循环终止策略

Agent Loop 主路径只处理自然停止、上层策略停止和模型终止错误三类回合结果。Runtime 不设置 `maxTurns`、`maxSteps` 或其他隐式循环上限；Loop 外层的 `Agent.runWithLifecycle()` 另行负责把未预期 Runtime failure 转换为完整结束的失败 Run。

### 1. 自然停止

每轮模型响应完成并发出 `turn_end` 后，Runtime 先调用 `shouldStopAfterTurn`（如果配置）。策略没有要求停止时，Runtime 根据模型结果判断是否继续：

| `finishReason` | ToolCall | 行为 |
| --- | --- | --- |
| `stop` | 任意 | 不执行工具，结束 Run |
| `refusal` | 任意 | 不执行工具，结束 Run |
| `length` | 任意 | 不执行工具，结束 Run，避免使用可能被截断的参数 |
| `tool_calls` | 空 | 协议没有有效工具调用，安全结束 Run |
| `tool_calls` | 非空 | 按执行模式完成全部工具，按源顺序写入 ToolResult，然后进入下一 Turn |
| `error` | 任意 | 保存失败 AssistantMessage，结束当前 Run，不执行工具或后续 hooks |
| `aborted` | 任意 | 保存取消 AssistantMessage，结束当前 Run，不执行工具或后续 hooks |

正常结束时发送一次：

```text
turn_end
agent_end
```

### 2. 策略停止

`shouldStopAfterTurn` 在一个完整 Turn 结束后调用，调用时机是：

```text
assistant response 完成
→ 所有 ToolCall 执行完成
→ ToolResult 写入 currentContext 和 newMessages
→ turn_end 已发送
→ shouldStopAfterTurn
```

它收到：

```ts
{
  message,      // 当前 Turn 的 AssistantMessage
  toolResults,  // 当前 Turn 的全部工具结果
  context,      // 包含历史消息和本次 Run 消息的完整上下文
  newMessages,  // 本次 Run 新产生的消息，不含历史消息
}
```

返回 `true` 时，当前 Turn 已经完整结束，Runtime 发送 `agent_end` 并停止，不再开始下一 Turn。即使当前 Turn 有 ToolCall，也不会跳过工具执行。

### 3. 模型失败与外部取消

`model-gateway` 将模型错误和取消归一化为 `finishReason: 'error' | 'aborted'` 的最终 `AssistantMessage`。Runtime 会照常完成：

```text
message_start / message_update...
→ message_end（最终失败消息）
→ turn_end（toolResults 为空）
→ agent_end
```

失败消息不会进入工具执行、`prepareNextTurn`、`shouldStopAfterTurn`、follow-up 或失败后的 steering；`AgentState.errorMessage` 保存其 `errorMessage`。有流式 partial 时，最终消息会替换唯一的上下文工作消息，不会重复写入 transcript；没有 `start` 事件时也会补发 `message_start`。

调用方传入的 `AbortSignal` 仍会继续传递给模型请求和工具执行：

```text
runAgentLoop
  → runLoop
      → streamAssistantResponse(..., signal)
      → executeToolCalls(..., signal)
```

## 工具执行模式

`AgentLoopConfig.toolExecution` 和 `AgentOptions.toolExecution` 支持：

```ts
type ToolExecutionMode = 'sequential' | 'parallel';
```

未配置时默认为 `sequential`。`sequential` 按模型返回顺序完成每个 ToolCall，并在每个 Tool 完成后立即发送其 ToolResult message 事件；`parallel` 先按模型顺序完成工具查找、参数校验和 `beforeToolCall`，再并发执行已通过准备阶段的工具。并行执行期间，`tool_execution_end` 按真实完成顺序发送，全部执行完成后再按模型原始 ToolCall 顺序发送 ToolResult message 事件。

两种模式都会在整个 Tool batch 完成后，按模型原始顺序把 ToolResult 一次性提交到 `currentContext.messages` 和 `newMessages`。因此 Tool hook 使用 batch 开始时的稳定上下文，而 Agent 状态仍可通过实时事件观察已完成的 ToolResult。

工具生命周期分为三个阶段：

```text
prepare  → 查找工具、校验参数、执行 beforeToolCall
execute  → 调用 AgentTool.execute
finalize → 执行 afterToolCall 并生成 ToolResultMessage
```

`beforeToolCall` 阻止会生成可恢复的 Tool error，不会调用 `execute` 或 `afterToolCall`。`AgentToolExecutionError` 表示可恢复的 Tool 错误；普通异常则生成安全的 internal Tool error，并停止当前 Tool batch。

Tool batch 返回明确的 `stopReason`：

* `undefined`：Tool 结果正常提交，Agent 继续下一次 LLM 调用。
* `error`：已提交 internal Tool 结果，Agent 不再调用 LLM，并进入现有 runtime error 生命周期。
* `aborted`：已提交已开始 Tool 的 aborted 结果，Agent 不再调用 LLM，并进入现有 aborted 生命周期。

Tool 错误的 `details.kind` 仅供 UI、日志和 Trace 使用；Agent Loop 只根据 batch outcome 的 `stopReason` 控制流程。

模型层返回 `error` 或 `aborted` 时，`prompt()` 会解析为本次新增消息（包含失败或取消的 `AssistantMessage`），而不是将模型失败作为普通 Runtime exception rejection。工具查找、参数校验和 `beforeToolCall` block 会生成 recoverable Tool error；`AgentToolExecutionError` 也会继续当前 Agent Loop。`execute` 或 before/after hook 抛出的其他异常会生成 internal Tool error，提交结果后进入现有 Agent Runtime failure 生命周期。

## 回合事件顺序

首次运行的典型顺序为：

```text
agent_start
turn_start
message_start / message_end   # prompts
message_start / message_update... / message_end  # assistant
tool_execution_start / tool_execution_end         # 可选；end 按完成顺序，结果消息按源顺序
turn_end
```

如果需要下一 Turn，则发送 `turn_start` 后重复模型调用；自然停止或策略停止后发送 `agent_end`。每个已正常完成的 Turn 恰好发送一次 `turn_end`，每次 Run 恰好发送一次 `agent_end`。

批量工具事件和上下文提交是两条顺序：sequential 在每个 `tool_execution_end` 后立即发出对应 ToolResult 的 `message_start` / `message_end`，parallel 则在所有工具完成后按模型 ToolCall 顺序发出这些事件；两种模式都在 batch 返回后统一提交 Loop context，再进入 `turn_end`。

模型流的 `partial` AssistantMessage 会映射为 `message_start` 和 `message_update` 的 `message`，并替换 `currentContext` 中唯一的工作消息；只有 `message_end` 的最终 AssistantMessage 才写入 Agent transcript。Agent 状态通过 `streamingMessage` 暴露当前完整半成品，不自行解析 text、thinking 或 tool-call 增量。

## 消息转换

`AgentContext.messages` 使用 `AgentMessage[]`。每次模型调用前，Runtime 通过 `config.convertToLlm` 或 `defaultConvertToLlm` 将其转换为 model-gateway 的 `Message[]`。默认转换器保留标准 `user`、`assistant`、`tool` 消息，并过滤未知自定义消息。


# Agent Runtime：职责与边界

## 定位

`agent-runtime` 是 OpsPilot 的 **通用 Agent 执行引擎**。

它建立在 `model-gateway` 提供的统一模型能力之上，负责管理 Agent 从收到用户消息，到模型推理、工具调用、工具执行、继续推理，直到最终结束的完整运行过程。

它对应 Pi 架构中的 `pi-agent-core` 层。

---

## 核心职责

### 1. 驱动 Agent Loop

Agent Runtime 最核心的职责是执行循环：

```text
User Message
     ↓
LLM
     ↓
AssistantMessage
     ↓
是否存在 Tool Call？
   ├── No → Agent 结束
   │
   └── Yes
         ↓
      执行 Tool
         ↓
      Tool Result
         ↓
   再次提交给 LLM
         ↓
       下一轮
```

因此 Agent Runtime 决定的是：

> 模型的一次返回之后，Agent 接下来应该做什么。

而不是模型请求本身该怎么发送。

---

### 2. 管理 Turn

一个 Agent Run 可以包含多个 Turn。

例如：

```text
Turn 1
LLM
↓
Tool Call
↓
Tool Result

Turn 2
LLM
↓
Tool Call
↓
Tool Result

Turn 3
LLM
↓
Final Answer
```

Agent Runtime 负责：

* Turn 开始
* 模型运行
* 工具执行
* Tool Result
* Turn 结束
* 判断是否进入下一 Turn

---

### 3. 执行工具调用

当模型返回：

```text
finishReason = tool_calls
```

并包含 `toolCalls` 时，Agent Runtime 负责找到对应工具并执行：

```ts
tool.execute(callId, args, signal)
```

然后将工具结果转换成：

```text
ToolResultMessage
```

并加入 Agent Context，供下一轮模型调用使用。

---

### 4. 管理工具执行策略

Agent Runtime 控制多个 Tool Call 如何执行。

目前支持：

```text
sequential
parallel
```

因此工具调用是否并行属于 Runtime 执行策略，而不是 Model Gateway 的职责。

---

### 5. 提供 Tool Hooks

工具真正执行前后可以经过：

```text
beforeToolCall
afterToolCall
```

例如：

```text
Model Tool Call
      ↓
beforeToolCall
      ↓
执行 / 拦截
      ↓
Tool Execute
      ↓
afterToolCall
      ↓
最终 ToolResult
```

这为未来实现以下能力提供扩展点：

* 权限控制
* 危险操作审批
* 参数修改
* Tool Result 修正
* 日志
* 审计

---

### 6. 管理 Agent 生命周期事件

Agent Runtime 对外提供统一的 Agent Event：

```text
Agent
├── agent_start
└── agent_end

Turn
├── turn_start
└── turn_end

Message
├── message_start
├── message_update
└── message_end

Tool
├── tool_execution_start
└── tool_execution_end
```

这些事件可以被：

* UI
* 日志
* Trace
* Observability
* Debugger

消费。

---

### 7. 将 Model Event 提升为 Agent Event

Model Gateway 提供的是模型粒度事件，例如：

```text
text.delta
thinking.delta
tool-call.delta
```

Agent Runtime 会把这些事件映射到：

```text
message_update
```

因此：

```text
ModelEvent = 模型正在发生什么

AgentEvent = Agent 当前生命周期正在发生什么
```

两者属于不同抽象层级。

---

### 8. 管理 Agent State

`Agent` 类维护当前 Agent 的实时状态：

```text
AgentState
├── model
├── messages
├── tools
├── isRunning
├── streamingMessage
├── pendingToolCalls
├── errorMessage
└── errorInfo
```

事件发生时先更新 State，再通知监听器。

因此：

```text
AgentEvent = 时间轴

AgentState = 当前快照
```

上层 UI 可以通过 Event 获取变化过程，也可以通过 State 获取当前运行状态。

---

### 9. 保存会话消息

Agent Runtime 负责维护 Agent 消息历史。

其中：

```text
_state.messages
```

表示已经正式完成并提交的消息。

而：

```text
streamingMessage
```

表示当前正在流式生成、但还没有正式提交的消息。

这样可以避免把实时 Partial Message 和正式 Conversation History 混在一起。

---

### 10. 管理 Abort

Agent Runtime 为一次 Agent Run 建立 `AbortController`。

取消信号会继续传给：

```text
Agent
 ↓
Agent Loop
 ↓
Model Request / Tool Execution
```

因此 Agent Runtime 是整个 Agent Run 的取消边界。

---

### 11. 支持 Steering

Steering 表示：

> 当前 Agent 任务还没结束，但用户希望新的消息尽快影响接下来的执行。

Steering Message 会在合适的 Turn 边界加入 Context。

例如：

```text
Agent 正在执行任务

用户：
“不要查生产环境，只查测试环境”

↓ Steering

下一 Turn 开始前加入 Context

↓
Agent 根据新要求继续
```

---

### 12. 支持 Follow-up

Follow-up 表示：

> 当前任务先自然执行完成，之后继续处理新的用户请求。

因此：

```text
steering
= 修改当前任务

follow-up
= 当前任务之后继续一个任务
```

---

### 13. 提供 Context Transform 扩展点

在真正调用 Model Gateway 前，Agent Runtime 可以通过：

```text
transformContext
convertToLlm
```

处理 Agent Messages。

这为未来实现以下能力提供基础：

* Context Window 裁剪
* 消息压缩
* Summary
* 自定义 AgentMessage
* RAG 消息注入
* Provider 前消息转换

---

### 14. 提供 Turn 控制扩展点

Runtime 提供：

```text
prepareNextTurn
shouldStopAfterTurn
```

用于控制：

* 下一轮 Context
* 下一轮 Model
* 是否提前结束 Agent

因此 Agent Loop 不需要把所有策略硬编码到循环内部。

---

### 15. 统一 Agent Runtime Error

一次运行中的错误分为三类，调用方需要区分 Agent Runtime 的错误与外部事件消费者的错误。

#### Model failure

`model-gateway` 会把模型调用错误或取消归一化成最终 `AssistantMessage`：

```ts
finishReason: 'error' | 'aborted'
```

Agent Runtime 正常消费该消息，并保持完整生命周期：

```text
message_start / message_update...
→ message_end
→ turn_end
→ agent_end
```

此时 `AgentState.errorMessage` 保存消息中的错误文本，并记录：

```ts
AgentErrorInfo {
  source: 'model'
  reason: 'error' | 'aborted'
  message: string
}
```

模型失败不会作为普通 Runtime exception 向 `prompt()` 调用方抛出。

#### Runtime failure

如果 Runtime 自身执行过程中出现未预期异常，例如 `transformContext`、`convertToLlm`、`prepareNextTurn`、`shouldStopAfterTurn` 或 `streamFn` 的同步异常，`Agent.runWithLifecycle()` 会捕获它，并通过 `handleRunFailure()` 生成 synthetic `AssistantMessage`：

```ts
{
  role: 'assistant',
  finishReason: 'error' | 'aborted',
  errorMessage: string,
}
```

该消息由 Agent Runtime 为保持 transcript 和生命周期完整而生成，不是 Provider 返回的模型消息。随后发出：

```text
message_start
→ message_end
→ turn_end
→ agent_end
```

同时记录：

```ts
AgentErrorInfo {
  source: 'runtime'
  reason: 'error' | 'aborted'
  message: string
}
```

因此普通 Runtime failure 会转换为一次完整结束的 Agent Run，而不是直接破坏生命周期。

#### Event listener failure

`Agent.subscribe()` 注册的事件监听器属于 Runtime 外部消费者。如果 listener 在消费 `AgentEvent` 时抛出异常，Runtime 会先以 `AgentEventListenerError` 标记该异常，再解包原始 cause；`prompt()` 最终以原始异常 reject：

```text
listener throws
→ AgentEventListenerError
→ unwrap original cause
→ prompt() reject
```

Listener failure 不会被包装成 synthetic `AssistantMessage`，也不会被记录为 `AgentErrorInfo`，因为它不代表 Model failure 或 Agent Runtime execution failure。

因此：

```text
AssistantMessage
= 保持 Agent transcript / lifecycle 完整

AgentErrorInfo
= 区分 model / runtime 错误来源

listener exception
= 外部事件消费者异常，直接 reject
```

---

## Agent Runtime 不负责什么

### 不负责 Provider API

Agent Runtime 不应该知道：

* OpenAI API
* Kimi API
* HTTP Endpoint
* API Key
* Provider SDK
* SSE 原始结构
* Provider Tool Call 格式

这些全部属于 `model-gateway`。

---

### 不负责 Provider 响应适配

例如：

```text
delta.reasoning_content
response.output
choices[].delta
```

Agent Runtime 不应该直接解析这些字段。

它只应该消费 Model Gateway 已经统一好的：

```text
ModelEventStream
AssistantMessage
```

---

### 不负责具体业务领域

Agent Runtime 是一个通用执行引擎。

它不应该包含：

```text
运维诊断逻辑
日志分析规则
指标诊断规则
服务器知识
数据库故障规则
```

这些属于 OpsPilot 的业务 Agent 或 Tool 层。

---

### 不负责工具具体实现

Agent Runtime 负责：

```text
决定什么时候执行 Tool
```

但不负责：

```text
Tool 内部具体怎么完成任务
```

例如：

```text
query_logs()
query_metrics()
restart_service()
```

这些属于 Tool Gateway 或业务工具实现。

---

## 与 Model Gateway 的边界

两层之间最核心的关系是：

```text
                OpsPilot Agent
                     │
                     ▼
┌─────────────────────────────────┐
│          agent-runtime          │
│                                 │
│ Agent Loop                      │
│ Turn                            │
│ Tool Execution                  │
│ Agent Event                     │
│ Agent State                     │
│ Abort / Steering / Follow-up    │
└───────────────┬─────────────────┘
                │
                │ Unified Context
                │ Unified ModelEvent
                │ AssistantMessage
                ▼
┌─────────────────────────────────┐
│          model-gateway          │
│                                 │
│ Unified Model API               │
│ Provider Adapter                │
│ Message / Tool / Event Contract │
└───────────────┬─────────────────┘
                │
        ┌───────┴────────┐
        ▼                ▼
     OpenAI            Kimi
```

依赖方向应该始终保持：

```text
agent-runtime
      ↓
model-gateway
      ↓
Provider
```

而不能反过来。

---

## 最重要的边界原则

### Model Gateway

回答：

> “怎样用统一的协议调用模型？”

### Agent Runtime

回答：

> “模型返回结果之后，Agent 下一步应该做什么？”

这是两层最核心的职责分界。

---

## 一句话理解

> `agent-runtime` 解决的是“如何让模型、工具和上下文不断循环，从而形成一个真正的 Agent”的问题。

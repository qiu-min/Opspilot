# `@opspilot/agent-runtime`

通用 Agent Runtime，负责驱动一次 Agent Run 从用户消息、模型调用、ToolCall、工具执行到最终结束的完整生命周期。

它建立在 `@opspilot/model-gateway` 提供的统一模型契约之上，但不感知具体 Provider，也不包含 Excel、RAG、Incident 等业务逻辑。

---

## 定位与边界

`agent-runtime` 的职责是回答：

> 模型一次返回之后，Agent 接下来应该做什么？

典型流程：

```text
User Message
    ↓
LLM
    ↓
AssistantMessage
    ↓
是否包含 ToolCall？
    │
    ├─ No
    │   ↓
    │ Agent Run 结束
    │
    └─ Yes
        ↓
      执行 Tool
        ↓
    ToolResultMessage
        ↓
    是否允许继续？
        │
        ├─ Yes → 再次调用 LLM
        │
        └─ No  → 结束 Agent Run
```

### Runtime 负责

* Agent Loop
* Turn 生命周期
* 消息上下文维护
* ToolCall 执行
* Tool 执行策略
* Tool Hook
* Tool 错误归一化
* Agent Event
* Agent State
* Abort
* Steering
* Follow-up
* Agent Run 生命周期收敛

### Runtime 不负责

* Provider SDK 调用细节
* OpenAI、Kimi、DeepSeek 等协议差异
* Excel、数据库、HTTP 等具体 Tool 实现
* `tool-gateway` 内部实现
* RAG 检索实现
* Incident 等业务流程
* 业务权限和审批规则本身
* HTTP API / Controller
* 持久化

具体 Tool 通过 `AgentTool` 契约注入 Runtime。

因此：

```text
agent-runtime
    ↓ depends on
model-gateway
```

但：

```text
agent-runtime
    ✕ 不依赖
tool-gateway
```

具体 Tool 系统应在更高层完成适配和组装，再以 `AgentTool` 形式传给 Runtime。

---

## Agent Loop

Agent Loop 的基本执行流程：

```text
runAgentLoop
    ↓
初始化 currentContext / newMessages
    ↓
runLoop
    ↓
Turn Start
    ↓
调用模型
    ↓
AssistantMessage
    ↓
处理 ToolCall
    ↓
写入 ToolResult
    ↓
Turn End
    ↓
判断是否继续
```

一个 Agent Run 可以包含多个 Turn：

```text
Turn 1
LLM
↓
ToolCall
↓
ToolResult

Turn 2
LLM
↓
ToolCall
↓
ToolResult

Turn 3
LLM
↓
Final Answer
```

Runtime 默认不设置 `maxTurns`、`maxSteps` 等隐式循环上限。

业务层如果需要额外终止策略，可通过 `shouldStopAfterTurn` 注入。

---

## Agent Context

Runtime 使用：

```ts
interface AgentContext {
  readonly systemPrompt?: string;
  messages: AgentMessage[];
  readonly tools?: readonly AgentTool[];
}
```

其中：

```text
systemPrompt
    当前 Agent System Prompt

messages
    已进入 Agent 上下文的消息

tools
    当前模型可使用的 Tool
```

每次调用模型前，Runtime 会将 `AgentMessage[]` 转换为 `model-gateway` 使用的标准 `Message[]`。

默认使用：

```ts
defaultConvertToLlm
```

业务层也可以通过：

```ts
convertToLlm
```

自定义转换。

---

## Tool 契约

Runtime 通过 `AgentTool` 执行工具：

```ts
interface AgentTool<TDetails = unknown> extends Tool {
  execute(
    callId: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}
```

Tool 正常执行返回：

```ts
interface AgentToolResult<TDetails = unknown> {
  readonly content: readonly TextContent[];
  readonly details?: TDetails;
}
```

例如：

```ts
{
  content: [
    {
      type: 'text',
      text: 'Worksheet loaded successfully.'
    }
  ],
  details: {
    worksheet: 'Sheet1'
  }
}
```

Runtime 随后将其转换成标准：

```text
ToolResultMessage
```

写入 Agent Context。

---

## Tool 执行阶段

单个 ToolCall 的生命周期分为三个阶段：

```text
prepare
   ↓
execute
   ↓
finalize
```

### prepare

负责：

* 查找 Tool
* 校验 Tool 参数
* 执行 `beforeToolCall`

```text
ModelToolCall
    ↓
查找 AgentTool
    ↓
validateToolArguments
    ↓
beforeToolCall
```

### execute

调用：

```ts
tool.execute(callId, args, signal)
```

### finalize

负责：

* 执行 `afterToolCall`
* 应用 Hook 对结果的覆盖
* 生成最终 `ToolResultMessage`

---

## Tool Hooks

Runtime 提供：

```text
beforeToolCall
afterToolCall
```

完整流程：

```text
Model ToolCall
      ↓
beforeToolCall
      ↓
AgentTool.execute
      ↓
afterToolCall
      ↓
ToolResultMessage
```

### beforeToolCall

可用于：

* 权限判断
* 危险操作拦截
* 审批
* 调用策略控制

返回：

```ts
{
  block: true,
  reason: 'Operation is not allowed.'
}
```

会生成 recoverable Tool Error，不执行真正 Tool。

### afterToolCall

可以覆盖：

```ts
{
  content,
  details,
  isError
}
```

可用于：

* Tool Result 修正
* 结果包装
* 审计
* 业务状态标记

`isError` 本身不决定 Agent Loop 是否终止。

Loop 是否终止由 Tool batch 的 `stopReason` 决定。

---

## Tool 执行模式

Runtime 支持：

```ts
type ToolExecutionMode =
  | 'sequential'
  | 'parallel';
```

未配置时默认为：

```text
sequential
```

### sequential

按照模型返回的 ToolCall 顺序逐个执行：

```text
Tool A
↓
ToolResult A
↓
Tool B
↓
ToolResult B
↓
Tool C
↓
ToolResult C
```

### parallel

先按顺序完成：

```text
Tool 查找
参数校验
beforeToolCall
```

然后并发执行已经通过准备阶段的 Tool：

```text
        ┌─ Tool A ─┐
        ├─ Tool B ─┤ → Promise.all
        └─ Tool C ─┘
```

`tool_execution_end` 可以按照真实完成顺序产生。

最终 ToolResult 仍按照模型原始 ToolCall 顺序提交到 Agent Context。

无论 sequential 还是 parallel，Agent Loop 都会在整个 batch 得到结果以后，将 ToolResult 按原始顺序提交到：

```text
currentContext.messages
newMessages
```

---

## Tool 错误处理

Agent Runtime 将 Tool 执行错误分为三类：

```ts
type ToolErrorKind =
  | 'recoverable'
  | 'internal'
  | 'aborted';
```

标准错误信息：

```ts
interface ToolErrorDetails<TData = unknown> {
  readonly kind: ToolErrorKind;
  readonly code: string;
  readonly data?: TData;
}
```

三种错误最重要的区别：

| 类型            | 含义                     | 再次调用 LLM | 终止 Agent Run |
| ------------- | ---------------------- | -------- | ------------ |
| `recoverable` | 模型可能通过修改调用恢复           | 是        | 否            |
| `internal`    | Tool 或 Runtime 未预期内部异常 | 否        | 是            |
| `aborted`     | 当前执行被取消                | 否        | 是            |

---

### Recoverable Error

Recoverable Error 表示：

> 模型有机会通过修改参数、选择其他 Tool 或改变调用方式恢复。

Tool 可以通过：

```ts
AgentToolExecutionError
```

显式声明此类错误。

例如：

```ts
throw new AgentToolExecutionError(
  'Worksheet "Sheet99" does not exist.',
  'WORKSHEET_NOT_FOUND',
  {
    sheetName: 'Sheet99'
  }
);
```

其中：

```text
message
    ↓
错误文本

code
    ↓
结构化错误代码

data
    ↓
与错误相关的额外结构化信息
```

Runtime 捕获后转换为：

```ts
{
  kind: 'recoverable',
  code: 'WORKSHEET_NOT_FOUND',
  data: {
    sheetName: 'Sheet99'
  }
}
```

完整转换关系：

```text
AgentToolExecutionError
{
  message,
  code,
  data
}
        ↓
ToolErrorDetails
{
  kind: "recoverable",
  code,
  data
}
        ↓
AgentToolResult
{
  content: [message],
  details
}
        ↓
ToolResultMessage
{
  role: "tool",
  isError: true,
  content,
  details
}
        ↓
加入 Agent Context
        ↓
再次调用 LLM
```

因此：

```text
AgentToolExecutionError.data
        ↓
ToolErrorDetails.data
```

`ToolErrorDetails.data` 并不是 `AgentToolExecutionError` 对象本身。

Runtime 自身也会产生部分 recoverable Tool Error，例如：

```text
TOOL_NOT_FOUND
INVALID_TOOL_ARGUMENTS
TOOL_BLOCKED
```

这些错误生成 `ToolResultMessage` 后不会终止 Loop。

模型可以读取错误信息并尝试重新调用 Tool。

---

### Internal Error

Internal Error 表示：

> Tool 执行过程中出现 Runtime 无法安全恢复的未预期异常。

例如：

```ts
throw new TypeError(
  'Cannot read properties of undefined'
);
```

普通未知异常不会被视为 recoverable。

Runtime 会统一归一化为：

```ts
{
  kind: 'internal',
  code: 'TOOL_INTERNAL_ERROR'
}
```

返回给模型侧的安全文本为：

```text
Tool execution failed due to an internal error.
```

原始异常不会进入：

```text
ToolErrorDetails.data
```

而是仅作为 Runtime 内部：

```text
cause
```

保留，用于：

* Logging
* Trace
* Debug
* Observability

这样可以避免把：

```text
文件路径
数据库信息
内部调用栈
Secret
基础设施异常
```

等内部细节泄漏到 LLM Context。

Internal Error 仍然会生成：

```text
ToolResultMessage
```

但这条 ToolResult 的主要作用是：

* 为对应 ToolCall 提供完整结果
* 补全 transcript
* 补全 Tool 生命周期
* 保存运行失败状态

它不会再次参与 LLM 调用。

执行流程：

```text
普通未知异常
      ↓
classifyThrownError
      ↓
ToolErrorDetails
{
  kind: "internal",
  code: "TOOL_INTERNAL_ERROR"
}
      ↓
AgentToolResult
      ↓
ToolResultMessage
{
  isError: true
}
      ↓
写入 transcript
      ↓
stopReason = "error"
      ↓
AgentLoopTermination
      ↓
不再调用 LLM
```

Agent 外层随后生成 synthetic `AssistantMessage`：

```ts
{
  role: 'assistant',
  finishReason: 'error',
  errorMessage:
    'Tool execution failed due to an internal error.'
}
```

用于完整结束 Agent Run。

---

### Aborted Error

Aborted Error 表示：

> 当前 Agent Run 或 Tool Execution 被 `AbortSignal` 主动取消。

Runtime 将其统一转换为：

```ts
{
  kind: 'aborted',
  code: 'TOOL_ABORTED'
}
```

并生成：

```text
Tool execution was aborted.
```

对应 ToolResult：

```ts
{
  role: 'tool',
  isError: true,
  details: {
    kind: 'aborted',
    code: 'TOOL_ABORTED'
  }
}
```

该 ToolResult 同样用于补全 transcript 和 Tool 生命周期，不会再次参与 LLM 调用。

执行流程：

```text
AbortSignal
    ↓
classifyAbortedError
    ↓
ToolErrorDetails
{
  kind: "aborted",
  code: "TOOL_ABORTED"
}
    ↓
ToolResultMessage
    ↓
stopReason = "aborted"
    ↓
AgentLoopTermination
    ↓
不再调用 LLM
```

Agent 外层随后生成：

```ts
{
  role: 'assistant',
  finishReason: 'aborted',
  errorMessage:
    'Tool execution was aborted.'
}
```

结束当前 Agent Run。

---

## Tool Batch StopReason

Tool batch 使用：

```ts
stopReason?: 'error' | 'aborted'
```

控制 Agent Loop。

### 无 stopReason

```text
stopReason = undefined
```

表示当前 Tool batch 不要求终止 Agent Run。

包括：

```text
正常 Tool Result
recoverable Tool Error
```

处理：

```text
ToolResult 写入 Context
        ↓
Turn End
        ↓
再次调用 LLM
```

### error

```text
stopReason = "error"
```

表示发生 fatal internal Tool Error。

处理：

```text
ToolResult 写入 transcript
        ↓
不再调用 LLM
        ↓
AgentLoopTermination(error)
        ↓
synthetic AssistantMessage(error)
        ↓
Agent Run 结束
```

### aborted

```text
stopReason = "aborted"
```

表示执行被取消。

处理：

```text
ToolResult 写入 transcript
        ↓
不再调用 LLM
        ↓
AgentLoopTermination(aborted)
        ↓
synthetic AssistantMessage(aborted)
        ↓
Agent Run 结束
```

因此：

> `ToolResultMessage.isError` 描述 Tool Result 是否为错误结果，而 `stopReason` 决定 Agent Loop 是否终止。

两者不是同一个概念。

---

## 未执行 ToolCall

当一个 Tool batch 因：

```text
internal
aborted
```

提前停止时，模型可能已经生成了多个 ToolCall。

例如：

```text
AssistantMessage

ToolCall A
ToolCall B
ToolCall C
```

如果执行 A 后整个 batch 必须终止，Runtime 仍会为未执行的 ToolCall 生成对应结果，避免 transcript 出现没有结果的 ToolCall。

Internal failure 后未执行的 Tool 使用：

```text
TOOL_NOT_EXECUTED
```

Abort 导致尚未开始的 Tool 使用：

```text
TOOL_ABORTED
```

这样可以保证：

```text
每个已经产生的 ToolCall
        ↓
都有对应的 ToolResultMessage
```

即使对应 Tool 实际没有开始执行。

---

## Agent Run 终止

Agent Run 当前主要有四类终止来源。

### 1. 自然停止

模型返回：

```text
stop
refusal
length
```

或者：

```text
finishReason = tool_calls
但没有有效 ToolCall
```

Runtime 不再继续下一 Turn。

---

### 2. 策略停止

业务层可以提供：

```ts
shouldStopAfterTurn
```

调用时机：

```text
AssistantMessage 完成
        ↓
Tool batch 完成
        ↓
ToolResult 提交
        ↓
turn_end
        ↓
shouldStopAfterTurn
```

返回：

```ts
true
```

后：

```text
agent_end
```

Runtime 不再开始下一 Turn。

---

### 3. Model Error / Aborted

`model-gateway` 将模型失败归一化为最终：

```ts
AssistantMessage
{
  finishReason: 'error' | 'aborted'
}
```

Runtime 不将这种模型失败作为普通异常抛出。

生命周期：

```text
message_start
    ↓
message_update...
    ↓
message_end
    ↓
turn_end
    ↓
agent_end
```

不会继续：

* Tool Execution
* prepareNextTurn
* shouldStopAfterTurn
* follow-up
* 后续 LLM 调用

模型错误在 `AgentState.errorInfo` 中标记为：

```ts
{
  source: 'model',
  reason: 'error' | 'aborted',
  message
}
```

---

### 4. Tool Error / Aborted

Tool batch 出现：

```text
internal
aborted
```

时返回：

```ts
AgentLoopTermination
```

Runtime 外层将其收敛成 synthetic `AssistantMessage`：

```ts
{
  role: 'assistant',
  finishReason: 'error' | 'aborted',
  errorMessage: ...
}
```

并记录：

```ts
{
  source: 'runtime',
  reason: 'error' | 'aborted',
  message
}
```

然后完整结束当前 Agent Run。

---

## Agent Event

Agent Runtime 对外暴露统一生命周期事件。

### Agent

```text
agent_start
agent_end
```

### Turn

```text
turn_start
turn_end
```

### Message

```text
message_start
message_update
message_end
```

### Tool

```text
tool_execution_start
tool_execution_end
```

因此可以把两层事件理解为：

```text
ModelEvent
    ↓
描述模型正在发生什么

AgentEvent
    ↓
描述 Agent 生命周期正在发生什么
```

例如 Model Gateway：

```text
text.delta
thinking.delta
tool-call.delta
tool-call.completed
usage
```

会被 Agent Runtime 提升为：

```text
message_update
```

供：

* UI
* Logging
* Trace
* Observability
* Debugger

消费。

---

## Tool 生命周期事件

正常 Tool 执行：

```text
tool_execution_start
        ↓
AgentTool.execute
        ↓
tool_execution_end
        ↓
message_start   # ToolResultMessage
        ↓
message_end
```

未真正开始执行的 Tool 不会伪造：

```text
tool_execution_start
tool_execution_end
```

但仍可以生成对应 `ToolResultMessage`，用于补全 transcript。

---

## Agent State

`Agent` 类维护当前 Agent 的实时状态：

```text
AgentState
├── systemPrompt
├── model
├── tools
├── messages
├── isRunning
├── streamingMessage
├── pendingToolCalls
├── errorMessage
└── errorInfo
```

可以理解为：

```text
AgentEvent
    = 时间轴

AgentState
    = 当前快照
```

事件发生时，Runtime 会先更新内部 State，再通知订阅者。

---

## Message State

正式完成的消息保存在：

```text
_state.messages
```

当前正在流式生成的消息保存在：

```text
streamingMessage
```

因此：

```text
streamingMessage
    ↓
实时工作消息

_state.messages
    ↓
已经正式提交的 transcript
```

模型流式 partial 不会被不断追加成多条正式消息。

最终 `AssistantMessage` 完成后才形成正式 transcript 状态。

---

## Pending Tool Calls

正在执行的 ToolCall 暴露为：

```text
pendingToolCalls
```

生命周期：

```text
tool_execution_start
        ↓
加入 pendingToolCalls
        ↓
tool_execution_end
        ↓
从 pendingToolCalls 移除
```

上层 UI 可以据此展示当前正在执行的 Tool。

---

## Abort

`Agent` 为每次 Agent Run 创建：

```text
AbortController
```

取消信号向下传递：

```text
Agent
  ↓
Agent Loop
  ↓
Model Request
  ↓
Tool Execution
```

调用：

```ts
agent.abort();
```

会触发当前 Active Run 的取消流程。

Runtime 是整个 Agent Run 的取消边界。

---

## Steering

Steering 用于：

> 当前 Agent Run 尚未自然结束，但新的消息需要尽快影响后续执行。

例如：

```text
Agent 正在执行任务

用户：
“不要查生产环境，只查测试环境”

        ↓
      steer
        ↓
下一合适 Turn 边界加入 Context
        ↓
Agent 根据新要求继续
```

Steering Message 不会直接打断当前正在进行的同步逻辑，而是在下一合适执行边界被消费。

---

## Follow-up

Follow-up 用于：

> 当前任务先自然执行完成，然后继续处理新的消息。

例如：

```text
当前任务
    ↓
自然结束
    ↓
Follow-up Message
    ↓
开始新的后续 Turn
```

Steering 和 Follow-up 的区别：

```text
Steering
    尽快影响当前任务

Follow-up
    当前任务完成后再继续
```

---

## Agent Error State

Agent Runtime 对运行错误额外维护：

```ts
interface AgentErrorInfo {
  readonly source: 'model' | 'runtime';
  readonly reason: 'error' | 'aborted';
  readonly message: string;
}
```

其中：

```text
source = model
    ↓
错误来自 model-gateway 返回的模型结果

source = runtime
    ↓
错误来自 Agent Runtime 生命周期，
包括 fatal Tool execution failure
```

`errorMessage` 面向简单状态展示。

`errorInfo` 用于区分错误来源和类型。

它属于 Agent Runtime 的诊断 metadata，不修改 `model-gateway` 的 AssistantMessage 契约。

---

## 核心设计原则

### Model Gateway 与 Agent Runtime 分层

```text
model-gateway
    ↓
统一模型调用和 Provider 差异

agent-runtime
    ↓
驱动 Agent 生命周期
```

Runtime 不直接依赖具体 Provider SDK。

---

### Tool 实现与 Runtime 解耦

Runtime 只依赖：

```text
AgentTool
```

不知道 Tool 来自：

```text
tool-gateway
本地函数
远程服务
RAG
数据库
Excel
浏览器
```

Tool 来源属于组合层和业务层职责。

---

### Recoverable Error 面向模型

```text
recoverable
    ↓
ToolResultMessage
    ↓
LLM
    ↓
模型尝试修正
```

---

### Internal Error 面向运行边界

```text
internal
    ↓
安全 ToolResult
    ↓
保存 transcript
    ↓
停止 Agent Loop
```

原始内部异常不直接暴露给模型。

---

### Abort 是正常生命周期状态

取消不是未捕获异常。

Runtime 会将取消收敛为完整的：

```text
ToolResult / AssistantMessage
        ↓
turn_end
        ↓
agent_end
```

保证 Agent Run 生命周期能够完整结束。

---

### Event 与 Context 分离

实时事件负责：

```text
观察执行过程
```

Agent Context 负责：

```text
保存正式提交的消息
```

因此：

```text
事件发布顺序
≠
Context 提交时机
```

两者属于不同职责。

---

## 总结

`agent-runtime` 的核心目标不是实现具体业务，而是提供稳定、通用的 Agent 执行语义：

```text
Model
  ↓
AssistantMessage
  ↓
ToolCall
  ↓
Tool Execution
  ↓
ToolResult
  ↓
Continue / Terminate
  ↓
Next Turn / Agent End
```

它负责保证：

* Agent Loop 行为明确
* ToolCall 与 ToolResult 配对完整
* recoverable / internal / aborted 错误语义统一
* Tool fatal error 不会被错误地重新发送给 LLM
* 模型错误和 Runtime 错误来源可区分
* Event、State 与 transcript 生命周期一致
* Tool 实现与 Runtime 保持解耦
* 上层业务可以通过配置和 Hook 扩展，而不污染通用 Runtime

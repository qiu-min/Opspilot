# `@opspilot/agent-runtime`

通用 Agent Runtime，负责维护一次 Agent Run 的消息上下文、模型回合、串行工具调用和生命周期事件。业务层通过 `AgentLoopConfig` 注入模型以及可选的 `shouldStopAfterTurn` 策略；Runtime 不包含 Incident、RAG 或具体业务完成条件。

## 基本流程

```text
runAgentLoop
  → 初始化 currentContext / newMessages
  → runLoop
      → 调用模型
      → 顺序执行当前 Turn 的 ToolCall
      → 写入 ToolResult
      → turn_end
      → 判断是否进入下一 Turn
```

## 循环终止策略

Runtime 只保留三种终止来源：自然停止、上层策略停止和外部取消。Runtime 不设置 `maxTurns`、`maxSteps` 或其他隐式循环上限。

### 1. 自然停止

每轮模型响应完成并发出 `turn_end` 后，Runtime 先调用 `shouldStopAfterTurn`（如果配置）。策略没有要求停止时，Runtime 根据模型结果判断是否继续：

| `finishReason` | ToolCall | 行为 |
| --- | --- | --- |
| `stop` | 任意 | 不执行工具，结束 Run |
| `refusal` | 任意 | 不执行工具，结束 Run |
| `length` | 任意 | 不执行工具，结束 Run，避免使用可能被截断的参数 |
| `tool_calls` | 空 | 协议没有有效工具调用，安全结束 Run |
| `tool_calls` | 非空 | 顺序执行全部工具，写入 ToolResult，然后进入下一 Turn |

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

### 3. 外部取消

调用方可以传入 `AbortSignal`。它会继续传递给模型请求和工具执行：

```text
runAgentLoop
  → runLoop
      → streamAssistantResponse(..., signal)
      → executeToolCall(..., signal)
```

底层请求或工具取消后，Promise rejection 会向调用方传播。本阶段不额外发出取消事件，也不保证取消时发送 `agent_end`。

## 回合事件顺序

首次运行的典型顺序为：

```text
agent_start
turn_start
message_start / message_end   # prompts
message_start / message_update... / message_end  # assistant
tool_execution_start / tool_execution_end         # 可选，按顺序
turn_end
```

如果需要下一 Turn，则发送 `turn_start` 后重复模型调用；自然停止或策略停止后发送 `agent_end`。每个已正常完成的 Turn 恰好发送一次 `turn_end`，每次 Run 恰好发送一次 `agent_end`。

## 消息转换

`AgentContext.messages` 使用 `AgentMessage[]`。每次模型调用前，Runtime 通过 `config.convertToLlm` 或 `defaultConvertToLlm` 将其转换为 model-gateway 的 `Message[]`。默认转换器保留标准 `user`、`assistant`、`tool` 消息，并过滤未知自定义消息。

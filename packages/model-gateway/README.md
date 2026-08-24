# @opspilot/model-gateway

`@opspilot/model-gateway` 是 OpsPilot 的模型通信边界。它将模型事实、模型上下文和单次调用行为拆分为三个独立契约，并由 Adapter 消除 Provider 协议差异。

```text
Model    → 调用哪个模型，以及它具备哪些能力
Context  → 本轮让模型看到的 system prompt、消息和工具声明
Options  → 本轮怎样调用，例如 reasoning、温度、输出上限、取消信号
```

该包不执行工具，也不包含 Incident、Evidence、权限、审批或连接器逻辑。

它统一的是模型通信语义，而不是 Agent 行为。

~~~text
Agent Runtime
      │
      │ ModelGateway
      ▼
统一的 Model / Context / Options
      │
      │ ModelAdapter
      ▼
OpenAI / DeepSeek / Kimi 等 Provider 协议
~~~

Agent Runtime 消费本包提供的模型流事件并负责 Agent Loop；tool-gateway 负责工具校验、策略和执行。本包不会执行 ModelToolCall，也不会决定是否进入下一轮。

## 调用方式

```ts
import { createModelGateway, loadModelGatewayConfig } from '@opspilot/model-gateway';

const gateway = createModelGateway(await loadModelGatewayConfig());
const model = gateway.getModel('moonshot', 'kimi-k3');
if (!model) throw new Error('Configured model was not found.');

const response = await gateway.complete(
  model,
  {
    systemPrompt: 'You are a concise operations assistant.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Summarize the elevated 5xx alert.' }],
      },
    ],
    tools: [],
  },
  {
    reasoning: 'high',
    maxTokens: 800,
  },
);
```

`Model` 是从配置解析出的稳定对象；`Context` 只放模型可见的上下文；`Options` 只放一次调用的偏好。不要重新引入聚合三者的 `ModelRequest`。

## 公共契约速览

### Model：模型身份与能力

Model 统一描述模型身份、调用 API 和能力：

~~~ts
type Model = {
  provider: string;
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  contextWindow?: number;
  supportsTools?: boolean;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  reasoningProtocol?: ReasoningProtocol;
  compat?: OpenAiCompletionsCompat;
};
~~~

调用方不需要知道模型具体使用哪一种 Provider SDK，只使用模型声明的能力。对应契约见 src/contracts/model.ts。

### Context：模型可见的输入

Context 只放本次调用让模型看到的内容：

~~~ts
type Context = {
  systemPrompt?: string;
  messages: readonly Message[];
  tools?: readonly Tool[];
};

type Message = UserMessage | AssistantMessage | ToolResultMessage;
~~~

Tool 是模型可见的最小声明，不包含 execute、权限、超时或连接器实现。AssistantMessage 可以包含文本、ThinkingContent 和 ModelToolCall；ToolResultMessage 表示已经产生的工具结果。对应契约见 src/contracts/context.ts。

### Options：单次调用选项

Options 描述一次调用的偏好：

~~~ts
type Options = {
  reasoning?: ThinkingLevel;
  responseFormat?: ResponseFormat;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
};
~~~

Provider 私有字段，例如 reasoning_effort、max_completion_tokens 和 DeepSeek 的 thinking，由 Adapter 根据已解析的选项生成。对应契约见 src/contracts/options.ts。

### Response：完整模型结果

完整结果统一为 AssistantMessage，包含 content、toolCalls、finishReason、usage、responseId 和 reasoning 决策信息。结束原因统一为：

~~~ts
type FinishReason = 'pending' | 'stop' | 'tool_calls' | 'length' | 'refusal';
~~~

`pending` 只表示流式生成中的 AssistantMessage；`error` 和 `aborted` 表示模型调用已经进入终止协议。`ModelEventStream.result()` 对所有这三类终止消息都 resolve。

Token 用量统一为 inputTokens、outputTokens 和 totalTokens。对应契约见 src/contracts/context.ts 与 src/contracts/response.ts。

### Stream：统一流式事件

不同 Provider 的流事件由 Adapter 归一化为以下事件联合：

~~~ts
type ModelStreamEvent =
  | { type: 'start'; model: Model; partial: AssistantMessage }
  | {
      type: 'text.delta';
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: 'thinking.delta';
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: 'tool-call.delta';
      contentIndex: number;
      callId: string;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: 'tool-call.completed';
      contentIndex: number;
      toolCall: ModelToolCall;
      partial: AssistantMessage;
    }
  | { type: 'usage'; usage: Usage; partial: AssistantMessage }
  | { type: 'done'; response: AssistantMessage }
  | {
      type: 'error';
      reason: 'error' | 'aborted';
      error: AssistantMessage;
    };
~~~

正常生命周期为：

~~~text
start
  → text.delta / thinking.delta / tool-call.delta / usage
  → tool-call.completed（如果有工具调用）
  → done
~~~

ModelEventStream 同时支持增量消费和获取最终结果：

~~~ts
const stream = gateway.stream(model, context, options);

for await (const event of stream) {
  // 消费统一的模型流事件
}

const message = await stream.result();
~~~

底层失败时，流会发送 `error` 并关闭流；`result()` resolve 同一个失败 AssistantMessage。对应契约见 src/contracts/events.ts。

### Error：流终止语义

Provider 或模型流失败会封装为带有 `finishReason: 'error' | 'aborted'` 的 AssistantMessage，并通过 `error` 事件发出；`result()` 仍然 resolve 该消息。配置、输入校验和未预期的编程错误仍然可以抛出普通 `Error`。

稳定的 Provider 错误文案由 Adapter 负责格式化，不再暴露自定义错误码协议。

上层应根据 `finishReason` 和 `errorMessage` 处理模型调用失败，而不是依赖某个 Provider 的异常类型或 HTTP 响应格式。

## ModelGateway API

ModelGateway 是上层调用入口：

~~~ts
interface ModelGateway {
  getProviders(): readonly ModelProviderDescriptor[];
  getModels(providerId?: string): readonly Model[];
  getModel(providerId: string, modelId: string): Model | undefined;
  stream(model: Model, context: Context, options?: Options): ModelEventStream;
  complete(
    model: Model,
    context: Context,
    options?: Options,
  ): Promise<AssistantMessage>;
}
~~~

Gateway 在调用 Adapter 前负责校验 Model、Context 和 Options，确认模型已注册，根据 model.api 选择 Adapter，解析 ThinkingLevel，并将结果暴露为统一流或完整响应。complete() 使用 stream().result()，不会维护另一套响应处理逻辑。

对应实现见 src/model-gateway.ts 和 src/model-gateway-registry.ts。

## ThinkingLevel

调用方只使用统一等级：

```ts
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
```

模型配置声明能力、等级映射与协议格式：

```json
{
  "reasoning": true,
  "reasoningProtocol": "openai-reasoning-effort",
  "thinkingLevelMap": {
    "off": "none",
    "minimal": "low",
    "low": "low",
    "medium": "medium",
    "high": "high"
  }
}
```

Gateway 在 Adapter 前验证能力并按 Pi 的规则回退：优先寻找更高的可用等级，找不到再寻找更低等级。Adapter 只将已解析的结果转换为私有请求字段。当前 OpenAI-compatible Adapter 支持：

- `openai-reasoning-effort` → `reasoning_effort`
- `openai-reasoning-object` → `reasoning: { effort }`
- `deepseek-thinking` → `thinking: { type: 'enabled' }` 与 `reasoning_effort`

未声明或不支持 reasoning 的模型会以清晰的普通 `Error` 拒绝请求，不会猜测 Provider 参数。最终 `AssistantMessage.reasoning` 记录请求等级和实际选择等级；不会将模型私有推理作为用户可见文本或 `text.delta` 事件。

## Kimi K3

K3 通过同一个 `openai-completions` Adapter 和模型级 `compat` 配置接入。它使用顶层 `reasoning_effort`，并将 `maxTokens` 映射为 `max_completion_tokens`；显式传入 `temperature` 会抛出普通 `Error`。多轮工具调用协议要求的 `reasoning_content` 会以带来源信息的 `ThinkingContent` 保留在内存上下文中，仅允许回传给产生它的同一 Provider、API 与模型；它既不是用户可见文本，也不会产生 `text.delta`、记录日志或跨 Provider 发送。

## Provider 配置

默认配置为仓库根目录的 `config/model-providers.json`。Provider 使用 `apiKeyEnv` 引用环境变量，不能提交明文密钥：

```json
{
  "providers": [
    {
      "id": "moonshot",
      "apiKeyEnv": "MOONSHOT_API_KEY",
      "baseUrl": "https://api.example.com/v1",
      "models": [
        {
          "id": "example-model",
          "api": "openai-completions",
          "reasoning": false
        }
      ]
    }
  ]
}
```

临时测试可使用 `apiKey`，但 `apiKey` 与 `apiKeyEnv` 必须二选一。配置加载时环境变量不存在会抛出普通 `Error`。

## 扩展协议

实现 `ModelAdapter` 并注册到 `createModelGateway(config, adapters)`。Adapter 的签名为：

```ts
stream(model, context, resolvedOptions, provider): ModelEventStream
```

它只处理协议转换。注册表负责 Provider 路由、三个公共契约的校验和 ThinkingLevel 解析；上层不感知具体 Provider。

## 目录

```text
src/contracts/
  model.ts      # Model 与模型能力
  context.ts    # Context、消息与工具声明
  options.ts    # Options 与结构化输出
  response.ts   # 标准响应与用量
  events.ts     # 标准流事件
src/thinking.ts # ThinkingLevel 能力、回退和解析
src/adapters/   # Provider 协议翻译
```

完整的实现职责还包括 provider-config.ts、model-gateway.ts、model-gateway-registry.ts 和 tool-validation.ts。

## 与其他层的边界

~~~text
model-gateway
  ├─ 统一模型调用契约
  ├─ Provider 配置与路由
  ├─ 请求、响应、流事件归一化
  └─ 模型能力和错误归一化

agent-runtime
  ├─ Agent Loop
  ├─ AgentEvent 映射
  ├─ 多轮与 Tool Call 编排
  └─ 取消、进度和运行状态

tool-gateway
  ├─ 参数校验
  ├─ 权限和 Policy Gate
  ├─ 超时、幂等和连接器调用
  └─ 工具结果校验
~~~

因此，model-gateway 只提供模型看到的最小工具声明，并归一化模型返回的 Tool Call；它不会调用 execute()，也不会实现 Agent Loop。

# Model Gateway：职责与边界

## 定位

`model-gateway` 是 OpsPilot 的 **模型访问与协议统一层**。

它位于具体模型供应商与上层 Agent Runtime 之间，负责屏蔽 OpenAI、Kimi 等不同模型供应商在 API、请求结构、响应结构、流式事件、工具调用和错误表示上的差异，并向上层暴露一套稳定、统一的模型调用契约。

它对应 Pi 架构中的 `pi-ai` 层。

---

## 核心职责

### 1. 统一模型调用接口

上层不直接依赖具体 Provider SDK，而是通过统一的 `ModelGateway` 接口访问模型。

目前主要提供：

```ts
stream(model, context, options)
complete(model, context, options)
```

其中：

* `stream()` 返回统一的模型事件流
* `complete()` 返回统一的 `AssistantMessage`

上层无需知道模型底层究竟来自 OpenAI、Kimi 或其他供应商。

---

### 2. 统一模型上下文协议

`model-gateway` 定义模型能够理解的统一 `Context`：

```text
Context
├── systemPrompt
├── messages
└── tools
```

同时统一消息类型：

```text
Message
├── UserMessage
├── AssistantMessage
└── ToolResultMessage
```

Agent Runtime 只需要构造这一套 Context，不需要针对每个模型供应商分别构造请求。

---

### 3. 统一 AssistantMessage

不同 Provider 返回的数据最终被转换成统一的：

```text
AssistantMessage
├── content
├── toolCalls
├── finishReason
├── usage
├── reasoning
├── errorMessage
└── Provider / Model metadata
```

这样上层 Agent Runtime 可以只根据统一的 `finishReason`、`toolCalls` 等字段驱动 Agent Loop。

---

### 4. 统一 Tool Calling 协议

不同模型供应商可能拥有不同的工具声明和 Tool Call 格式。

`model-gateway` 将这些差异转换成统一的：

```text
Tool
ModelToolCall
ToolResultMessage
```

因此 Agent Runtime 不需要处理 OpenAI Tool Calling、Kimi Tool Calling 等供应商特有格式。

---

### 5. 统一流式事件

Provider 的 SSE / Stream 数据最终被标准化成统一的 `ModelStreamEvent`。

例如：

```text
start
text.delta
thinking.delta
tool-call.delta
tool-call.completed
usage
done
error
```

上层只消费这些统一事件，而不接触具体 Provider 的原始流式协议。

---

### 6. 隔离 Provider 差异

不同模型供应商的特殊逻辑集中放在 Adapter 中。

典型差异包括：

* HTTP API 格式
* 请求字段名称
* Response 格式
* SSE Chunk 格式
* Tool Calling 格式
* Thinking / Reasoning 字段
* Finish Reason
* Usage
* Error
* Provider 特殊兼容逻辑

这些差异应该尽量停留在 `model-gateway` 内部，而不向 Agent Runtime 泄漏。

---

### 7. 模型与 Provider 注册

`model-gateway` 负责维护：

```text
Provider
Model
Provider Config
Model Registry
```

上层只需要通过模型描述信息选择模型，不需要自己管理具体 Provider SDK。

---

## Model Gateway 不负责什么

### 不负责 Agent Loop

它只负责：

```text
输入 Context
      ↓
调用模型
      ↓
输出 AssistantMessage / ModelEventStream
```

它不会决定：

* 是否继续下一轮模型调用
* Tool Call 是否应该执行
* Tool Result 如何重新提交给模型
* 一个 Agent Run 什么时候结束

这些属于 `agent-runtime`。

---

### 不负责工具实际执行

`model-gateway` 只负责定义和传递 Tool / ToolCall 协议。

真正调用：

```ts
tool.execute(...)
```

属于 Agent Runtime。

---

### 不负责 Agent 生命周期

以下概念不应该由 `model-gateway` 管理：

```text
agent_start
agent_end
turn_start
turn_end
tool_execution_start
tool_execution_end
```

这些都是 Agent Runtime 语义。

---

### 不负责业务逻辑

例如：

* 运维故障诊断
* RAG
* 告警分析
* 数据库查询策略
* 权限审批
* 人工确认

这些都应该存在于更上层业务模块或工具层中。

---

## 核心边界

可以把 `model-gateway` 理解成：

```text
Provider SDK / API
        │
        ▼
┌──────────────────────┐
│    model-gateway     │
│                      │
│ Provider Adapter     │
│ ↓                    │
│ Unified Model API    │
│ Unified Context      │
│ Unified Message      │
│ Unified Events       │
└──────────┬───────────┘
           │
           ▼
     agent-runtime
```

最重要的设计原则是：

> Provider 差异应该在 Model Gateway 结束。

Agent Runtime 不应该知道 OpenAI、Kimi 等供应商 API 的具体实现细节。

---

## 一句话理解

> `model-gateway` 解决的是“如何用统一方式调用不同模型”的问题。

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
type FinishReason = 'stop' | 'tool_calls' | 'length' | 'refusal';
~~~

Token 用量统一为 inputTokens、outputTokens 和 totalTokens。对应契约见 src/contracts/context.ts 与 src/contracts/response.ts。

### Stream：统一流式事件

不同 Provider 的流事件由 Adapter 归一化为以下事件联合：

~~~ts
type ModelStreamEvent =
  | { type: 'start'; model: Model }
  | { type: 'text.delta'; contentIndex: number; delta: string }
  | {
      type: 'tool-call.delta';
      contentIndex: number;
      callId: string;
      delta: string;
    }
  | {
      type: 'tool-call.completed';
      contentIndex: number;
      toolCall: ModelToolCall;
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; response: AssistantMessage }
  | { type: 'error'; error: ModelGatewayError };
~~~

正常生命周期为：

~~~text
start
  → text.delta / tool-call.delta / usage
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

底层失败时，流会发送 error，同时 result() reject 并关闭流；不会为了满足返回类型而伪造 AssistantMessage。对应契约见 src/contracts/events.ts。

### Error：稳定错误码

错误统一为 ModelGatewayError，错误码包括：

~~~text
CONFIGURATION
INVALID_INPUT
INVALID_RESPONSE
INVALID_TOOL_CALL
UNSUPPORTED_CAPABILITY
AUTHENTICATION
RATE_LIMITED
TIMEOUT
MODEL_REFUSAL
PROVIDER_FAILURE
~~~

上层应根据稳定错误码处理失败，而不是依赖某个 Provider 的错误文本或 HTTP 响应格式。对应契约见 src/contracts/errors.ts。

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

未声明或不支持 reasoning 的模型会以稳定错误码拒绝请求，不会猜测 Provider 参数。最终 `AssistantMessage.reasoning` 记录请求等级和实际选择等级；不会将模型私有推理作为用户可见文本或 `text.delta` 事件。

## Kimi K3

K3 通过同一个 `openai-completions` Adapter 和模型级 `compat` 配置接入。它使用顶层 `reasoning_effort`，并将 `maxTokens` 映射为 `max_completion_tokens`；显式传入 `temperature` 会得到 `UNSUPPORTED_CAPABILITY`。多轮工具调用协议要求的 `reasoning_content` 会以带来源信息的 `ThinkingContent` 保留在内存上下文中，仅允许回传给产生它的同一 Provider、API 与模型；它既不是用户可见文本，也不会产生 `text.delta`、记录日志或跨 Provider 发送。

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

临时测试可使用 `apiKey`，但 `apiKey` 与 `apiKeyEnv` 必须二选一。配置加载时环境变量不存在会报告 `CONFIGURATION`。

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
  errors.ts     # 稳定错误码
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

# @opspilot/model-gateway

`@opspilot/model-gateway` 是 OpsPilot 的模型通信边界。它将模型事实、模型上下文和单次调用行为拆分为三个独立契约，并由 Adapter 消除 Provider 协议差异。

```text
Model    → 调用哪个模型，以及它具备哪些能力
Context  → 本轮让模型看到的 system prompt、消息和工具声明
Options  → 本轮怎样调用，例如 reasoning、温度、输出上限、取消信号
```

该包不执行工具，也不包含 Incident、Evidence、权限、审批或连接器逻辑。

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

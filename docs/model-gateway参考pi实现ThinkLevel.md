# Model Gateway 参考 Pi 实现 ThinkingLevel

## 目标

将当前 `ModelRequest` 拆分为 Pi 风格的三个公共参数：`model`、`context`、`options`。三者分别描述稳定的模型事实、需要模型处理的上下文，以及单次调用的行为偏好。

```text
agent-runtime / incident-agent
  └─ stream(model, context, { reasoning: 'high' })
       ↓
model-gateway
  ├─ 依据 model 声明的能力校验并回退 ThinkingLevel
  ├─ 将统一等级映射为 Provider 值
  └─ 将 context 与已解析 options 交给 Adapter
       ↓
ModelAdapter
  └─ 转换为 Provider 私有 HTTP 请求
```

`agent-runtime` 决定这次诊断需要何种推理强度；`model-gateway` 决定目标模型能否及如何满足该要求；Adapter 仅负责具体协议翻译。

## Pi 的三参数设计

Pi 的统一入口是：

```ts
stream(model, context, options?)
streamSimple(model, context, { reasoning: 'high' })
```

`stream()` 接受更接近协议的 `StreamOptions`；`streamSimple()` 在其外提供跨 Provider 的语义选项，例如 `reasoning`。OpsPilot 的三个公共契约直接命名为 `Model`、`Context`、`Options`，不使用 `ModelContext`、`ModelCallOptions` 这类重复前缀，也不暴露 Provider 私有选项。

### 1. Model：稳定的“调用谁、它能做什么”

Pi 的 `Model` 包含：

| 类别 | Pi 字段 | 含义 |
| --- | --- | --- |
| 身份与路由 | `id`、`name`、`api`、`provider`、`baseUrl` | 选择具体模型和 Adapter，并定位端点。 |
| 推理能力 | `reasoning`、`thinkingLevelMap` | 是否支持 reasoning，以及统一等级到模型私有值的映射。 |
| 输入/输出能力 | `input`、`contextWindow`、`maxTokens` | 接受的模态、上下文窗口和最大输出。 |
| 默认模型行为 | `samplingParams`、`headers`、`compat` | 模型级默认采样、默认请求头和兼容性配置。 |
| 成本 | `cost` | 用量成本计算。 |

`Model` 不承载本轮消息、工具列表、推理强度、取消信号或结构化输出格式；这些内容会随每次调用变化。

对于 OpsPilot，先保留当前已存在的 `provider`、`id`、`name`、`api`、`baseUrl`、`contextWindow`、`supportsTools`，并新增：

```ts
readonly reasoning: boolean;
readonly thinkingLevelMap?: ThinkingLevelMap;
readonly reasoningProtocol?: ReasoningProtocol;
```

`reasoningProtocol` 是本项目在通用 OpenAI-compatible 端点场景下所需的兼容性配置：它说明 Provider 参数应以何种格式发送，而 `thinkingLevelMap` 只说明等级映射到什么值。

### 2. Context：本轮“让模型处理什么”

Pi 的 `Context` 仅包含：

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

它描述可被模型看见的上下文，而不是网络请求选项。对应到 OpsPilot：

```ts
interface Context {
  readonly systemPrompt?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly Tool[];
}
```

- `systemPrompt`：稳定指令；当前若继续以 `system` 消息表达，也应由 context 层负责归一化，而非由 options 传递。
- `messages`：当前回合前的对话与工具结果。
- `tools`：本轮向模型声明的最小工具契约；不包含执行实现、权限和连接器信息。

`responseFormat` 不属于 Context：它不是模型已有的对话事实，而是本次希望模型以何种方式输出的约束。

### 3. Options：本轮“怎样调用”

Pi 把瞬时调用控制放在 `StreamOptions` / `SimpleStreamOptions`：

| Pi 字段类别 | 代表字段 | 职责 |
| --- | --- | --- |
| 统一推理语义 | `reasoning`、`thinkingBudgets` | 期望的推理等级及其 token 预算。 |
| 生成控制 | `temperature`、`maxTokens`、`samplingParams` | 控制本轮生成。 |
| 缓存/会话 | `cacheRetention`、`sessionId` | 表达缓存意图和会话关联。 |
| 传输与生命周期 | `signal`、`timeoutMs`、`maxRetries`、`headers`、`fetch` | 取消、超时、重试、请求头与 transport。 |
| 可观测性 | `telemetryContext`、`metadata`、`onPayload`、`onResponse` | 追踪、元数据与调试钩子。 |

OpsPilot 的首版公共选项应保持更小：

```ts
interface Options {
  readonly reasoning?: ThinkingLevel;
  readonly responseFormat?: ResponseFormat;
  readonly signal?: AbortSignal;
  readonly temperature?: number;
  readonly maxTokens?: number;
}
```

未来按同一位置扩展 `cacheRetention`、`sessionId`、`timeoutMs`、`maxRetries` 和 telemetry。上层永远不传 `reasoning_effort`、`thinking` 等 Provider 私有字段。

## Pi 的 ThinkingLevel 实现

Pi 定义：

```ts
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
type ModelThinkingLevel = 'off' | ThinkingLevel;
type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

- `SimpleStreamOptions.reasoning` 只接受启用 reasoning 的等级；不传即按默认行为调用。
- `Model.reasoning` 为 `false` 时，模型只支持 `off`。
- `thinkingLevelMap` 的字符串是模型实际接受的值；`null` 明确表示不支持该等级。
- `getSupportedThinkingLevels()` 计算模型支持的集合。
- `clampThinkingLevel()` 先向更高的可用等级寻找，找不到再向更低等级寻找。
- `streamSimple()` 在调用 Adapter 前执行 clamp；Adapter 再将映射后的值写入该协议的私有参数。

Pi 参考源码：

- `docs/pi/packages/ai/src/types.ts`：`Model`、`Context`、`StreamOptions`、`SimpleStreamOptions`、Thinking 类型。
- `docs/pi/packages/ai/src/models.ts`：支持等级计算与 `clampThinkingLevel()`。
- `docs/pi/packages/ai/src/api/openai-responses.ts`：`streamSimple()` 解析统一 reasoning 后调用底层 `stream()`。
- `docs/pi/packages/ai/src/api/openai-completions.ts`：将映射值写成多种 OpenAI-compatible thinking 方言。

## OpsPilot 的落地契约

### 公共入口

```ts
interface ModelGateway {
  stream(
    model: Model,
    context: Context,
    options?: Options,
  ): ModelEventStream;

  complete(
    model: Model,
    context: Context,
    options?: Options,
  ): Promise<ModelResponse>;
}
```

删除公共的 `stream(request: ModelRequest)` / `complete(request: ModelRequest)` 形式。若迁移期间需要兼容层，它只能是过渡性内部辅助函数，不能成为新的公共边界。

### 契约文件布局

移除 `src/contracts.ts`，改为 `src/contracts/` 目录。每个公共调用参数独占一个文件，避免继续将稳定模型事实、上下文和调用行为耦合到一个大文件中：

```text
packages/model-gateway/src/contracts/
  model.ts       # Model、ThinkingLevel、ThinkingLevelMap、模型能力 schema
  context.ts     # Context、Message、Tool 及其 schema
  options.ts     # Options、ResponseFormat 及其 schema
  response.ts    # ModelResponse、Usage、FinishReason
  events.ts      # ModelStreamEvent、ModelEventStream、stream 控制器
  errors.ts      # ModelGatewayError、错误码和类型守卫
  index.ts       # 仅重导出上述公共契约
```

`thinking.ts` 不是公共参数契约：它只包含根据 `Model` 与 `Options` 解析 reasoning 的通用算法。Adapter 若需要内部的已解析结果，可从该模块导入内部类型；不得将该类型作为新的公共入口参数。

### ThinkingLevel

首版只暴露 OpsPilot 当前需要的等级：

```ts
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';
export type ModelThinkingLevel = 'off' | ThinkingLevel;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
```

当有已验证的模型确实支持且业务需要 `xhigh` 或 `max` 时，再以兼容方式扩展枚举。

### 内部已解析选项

Gateway 在进入 Adapter 前产生内部类型，不向 Runtime 或业务层公开：

```ts
interface ResolvedOptions extends Options {
  readonly resolvedReasoning?: {
    readonly requested: ThinkingLevel;
    readonly selected: ModelThinkingLevel;
    readonly providerValue: string;
    readonly protocol: ReasoningProtocol;
  };
}
```

它使 Adapter 无需判断业务策略、模型支持集合或回退规则，只需按 `protocol` 构造请求。

## 模型配置

模型配置应显式声明 reasoning 能力和映射：

```json
{
  "id": "example-model",
  "api": "openai-completions",
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

- 字符串：统一等级映射到该模型可接受的 Provider 值。
- `null`：该模型明确不支持该等级。
- 对未知 OpenAI-compatible 端点，缺失映射视为未声明；不得猜测 Provider 参数。
- API 密钥不得保存在 JSON 中，应从环境变量或受控密钥配置注入。

## 实现步骤

1. 重构公共调用参数。
   - 删除 `contracts.ts`，创建 `contracts/model.ts`、`contracts/context.ts`、`contracts/options.ts`；每个三参数契约及其 Zod schema 只放在自己的文件中。
   - 将 `ModelRequest` 的 `messages`、`tools` 移入 `Context`。
   - 将 `responseFormat`、`signal` 移入 `Options`。
   - 将 `ModelGateway`、`ModelAdapter` 的 `stream` / `complete` 签名替换为三个参数。
   - 同时保留并更新 Zod 校验：分别验证 `Model`、`Context`、`Options`，不再通过一个不断膨胀的 request object 验证。

2. 新增通用 reasoning 模块。
   - 创建 `thinking.ts`，提供 `getSupportedThinkingLevels()`、`clampThinkingLevel()` 和 `resolveThinking()`。
   - `resolveThinking(model, options)` 产生内部 `ResolvedOptions`；不构造 HTTP payload。
   - `reasoning: false` 时，带 reasoning 的调用必须被拒绝。
   - 映射为 `null` 的等级绝不能被选择或发送。
   - 采用 Pi 的回退规则，并以测试固定。

3. 扩展配置加载和 Model 解析。
   - 在 `provider-config.ts` 的 schema、配置类型和 `resolveProviders()` 中新增 `reasoning`、`thinkingLevelMap`、`reasoningProtocol`。
   - 模型能力必须以 Provider 文档和实际测试验证后再写入配置。

4. Adapter 只做协议翻译。
   - `openai-completions-model-adapter.ts` 接收 `model`、`context`、`resolvedOptions` 与 provider。
   - 使用 `resolvedOptions.resolvedReasoning` 按 `reasoningProtocol` 写入正确 payload，例如 `{ reasoning_effort: providerValue }`。
   - 未请求 reasoning 时不附加 reasoning 参数，除非模型配置的关闭语义明确要求发送 `off` 映射。
   - Runtime 与业务层不得判断 Provider 名称，也不得直接设置 Provider 参数。

5. 记录实际决议。
   - 在 `ModelResponse` 或 `done` 事件记录 requested / selected reasoning 等级，供审计、成本分析与复现。
   - 不记录、展示或伪造模型私有思维链。

6. 最后接入上层。
   - `agent-runtime` 传递 `Options.reasoning`，不读取能力映射。
   - `incident-agent` 仅按诊断策略选择 `minimal`、`low`、`medium` 或 `high`。

## 测试清单

- Model、Context、Options 分别校验，且职责边界不重叠。
- 不支持 reasoning 的模型拒绝 reasoning 请求。
- `high` 映射为模型私有值。
- 请求不支持的等级按回退规则得到确定结果。
- 映射为 `null` 的等级绝不会写入 Adapter payload。
- 各 `reasoningProtocol` 生成正确 payload。
- 未传 reasoning 时不意外附加 Provider 参数。
- ModelResponse / done 事件可审计实际选定等级。
- 使用窄 client 替身验证 payload，不发起真实网络调用。

## 涉及文件

| 文件 | 变更 |
| --- | --- |
| `packages/model-gateway/src/contracts/model.ts` | `Model`、ThinkingLevel、ThinkingLevelMap、模型能力 Zod schema。 |
| `packages/model-gateway/src/contracts/context.ts` | `Context`、消息、工具声明及其 Zod schema。 |
| `packages/model-gateway/src/contracts/options.ts` | `Options`、ResponseFormat 及其 Zod schema。 |
| `packages/model-gateway/src/contracts/response.ts` | ModelResponse、Usage、FinishReason 与审计字段。 |
| `packages/model-gateway/src/contracts/events.ts` | 流事件、事件流和 stream 控制器。 |
| `packages/model-gateway/src/contracts/errors.ts` | 网关错误码、错误类型和类型守卫。 |
| `packages/model-gateway/src/contracts/index.ts` | 统一重导出，不定义新的混合契约。 |
| `packages/model-gateway/src/model-gateway.ts` | `ModelGateway` 与安全 Provider 描述符；定义三参数公共入口。 |
| `packages/model-gateway/src/thinking.ts` | 新增：能力计算、回退和统一 reasoning 解析。 |
| `packages/model-gateway/src/index.ts` | 导出新的公共契约与 reasoning 工具。 |
| `packages/model-gateway/src/model-gateway-registry.ts` | 改用三参数入口，统一校验和解析 options。 |
| `packages/model-gateway/src/provider-config.ts` | reasoning 能力、映射和协议的配置 schema 与 Model 解析。 |
| `packages/model-gateway/src/adapters/model-adapter.ts` | 改为接受 model、context、resolvedOptions 与 provider。 |
| `packages/model-gateway/src/adapters/openai-completions-model-adapter.ts` | Context 翻译、reasoning payload、三个参数签名。 |
| `packages/model-gateway/src/adapters/openai-completions-tools.ts` | 输入改为 Context 的 messages / tools。 |
| `packages/model-gateway/test/contracts.test.ts` | 三类公共参数及边界测试。 |
| `packages/model-gateway/test/model-gateway-registry.test.ts` | 新入口和统一解析测试。 |
| `packages/model-gateway/test/provider-config.test.ts` | reasoning 配置解析测试。 |
| `packages/model-gateway/test/thinking.test.ts` | 新增：能力、回退、null 禁用测试。 |
| `packages/model-gateway/test/openai-completions-model-adapter.test.ts` | Context 与 reasoning payload 的 Adapter 测试。 |
| `packages/model-gateway/README.md` | 三参数调用、配置、回退与限制说明。 |
| `config/model-providers.json` | 填写经验证的能力；将密钥迁移至环境变量。 |
| `packages/agent-runtime/**` | 后续改为传入 Model、Context、Options；不含 Provider 细节。 |
| `packages/incident-agent/**` | 创建后按诊断策略选择 reasoning；不含能力映射。 |

## 非目标

- 不复制 Pi 的完整模型目录、认证体系或所有 Provider 方言。
- 不将 Provider 私有 reasoning 参数暴露给上层。
- 不在 Adapter 中决定业务推理策略或等级回退。
- 不保存、展示或伪造模型的私有思维链。

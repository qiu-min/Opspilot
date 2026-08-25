# Day 7：ModelGateway Provider 与 Agent 决策契约任务清单

## 目标

建立供应商无关、可验证的模型决策边界，并以协议适配器实现 OpenAI 与 Kimi/Moonshot 调用。Day7 的交付使后续 Agent Runtime 能向模型提供告警、当前调查上下文和 Day6 的四个只读工具声明，获得且只获得以下两类决策之一：

1. 调用一个或多个只读工具；
2. 结束调查并返回结构化诊断。

本日不实现 Agent Loop、不执行工具、不创建或持久化 `Evidence`、`RunEvent`、`AnalysisRun` 状态，也不修改 API、Worker、数据库或 Web。Day8 负责调用模型、执行工具和循环控制；Day9 再把过程与诊断持久化。

```text
Day8 Agent Runtime
  → ModelGateway.decide(ModelDecisionInput)
  → OpenAI Responses API / Kimi Chat Completions API（真实环境）
  → 经过 Zod 校验的 ModelDecision
       ├─ tool_calls：ModelToolCall[]
       └─ diagnosis：FinalDiagnosis
```

Provider 注册表将 OpenAI 绑定到 Responses API，将 Kimi/Moonshot 中国大陆绑定到 Chat Completions API；两者都采用直接函数调用与结构化输出。Model Gateway 只校验模型工具调用的结构和本轮工具白名单；工具参数在 Day8 由 Agent Runtime 交给 Tool Gateway，并使用 Day6 的输入 schema 校验。模型的结构化输出也必须在进入业务逻辑前使用本包的 Zod schema 校验。

## 固定边界与契约

### 模型输入

`ModelDecisionInput` 是供应商无关的纯数据对象，至少包含：

- `incident`：`incidentId`、标题、服务、严重级别、告警时间与告警摘要；不得放入密钥、完整原始日志或数据库连接串。
- `investigation`：本次 `runId`、当前轮次、最大轮次、已成功的工具调用摘要、已失败调用的安全错误摘要，以及可供结论引用的 `callId` 集合。
- `tools`：由 Day6 `ToolDefinition` 转换而来的函数声明；只暴露 `queryLogs`、`queryMetrics`、`searchRunbook`、`getServiceTopology` 四个只读工具。
- `instructions`：明确调查目标、只读边界、工具参数要求、何时继续调查、何时可结束，以及最终诊断必须引用已返回 `callId` 的要求。

输入 schema 必须严格拒绝未知字段、空 ID、非法时间、空工具名和不合法的轮次上限。模型适配器不得读取环境变量或其他全局状态，不得自行加载 fixture、访问数据库或直接调用 Tool Gateway。

### 工具声明与调用决策

- Day8 的 Agent Runtime 将 Day6 `ToolDefinition[]` 映射为供应商无关的 `ModelToolDefinition[]`；Model Gateway 只消费后者来生成 OpenAI function tools，不导入 Tool Gateway。
- 模型返回的工具调用标准化为 `ModelToolCall`：`{ callId, name, arguments }`。`callId` 保留 OpenAI 返回的调用关联 ID，`name` 必须存在于本轮 `ModelDecisionInput.tools` 白名单中，`arguments` 必须是 JSON 对象而非文本或数组。Agent Runtime 在 Day8 将它收窄并转换为 Day6 的 `ToolCall`，再交由 Tool Gateway 校验并执行。
- 一个 `tool_calls` 决策至少包含一次调用；同一轮调用数量不在 Day7 限制，由 Day8 设置上限并拒绝重复同参调用。
- `tool_calls` 与 `diagnosis` 互斥；空输出、文本输出、混合输出、未知工具、无效 JSON、重复或缺失调用 ID，均返回可分类的 `ModelGatewayError`，不进入 Agent 业务逻辑。

### 最终诊断契约

`FinalDiagnosis` 的严格 Zod schema 至少包含：

| 字段 | 约束 |
| --- | --- |
| `rootCauseHypotheses` | 非空数组；每项有假设、0–1 的置信度、说明及非空 `evidenceCallIds`。 |
| `overallConfidence` | 0–1 的数值。 |
| `evidenceCallIds` | 非空、去重的成功工具调用 ID；后续 Day9 将其映射为持久化 Evidence 引用。 |
| `unconfirmedItems` | 数组；不能被当前证据支持的推测必须放在这里。 |
| `recommendedActions` | 非空数组；每项包含行动、理由、风险等级（`LOW` / `MEDIUM` / `HIGH`）及支撑它的 `evidenceCallIds`。 |
| `summary` | 面向值班人员的简短总结，不包含模型思维链或完整原始工具输出。 |

诊断中的每个 `evidenceCallIds` 必须属于输入中的成功调用集合；引用不存在、失败或重复调用的 ID，以及缺少根因、置信度、未确认项或建议行动的输出，均视为无效模型输出。Day7 只校验可引用性，不判断根因是否正确；三场景的正确性评测留给 Day11。

## 任务清单

### 1. 建立公开模型决策契约

- [x] 新增 `packages/model-gateway/src/contracts.ts`，定义 `ModelDecisionInput`、供应商无关的函数工具声明、`ModelGateway` 接口、`ModelDecision` 判别联合、`ToolCallsDecision`、`DiagnosisDecision` 与稳定的 `ModelGatewayError`。
- [x] 使用严格 Zod schema 同时导出运行时校验器与 TypeScript 类型；对象契约均拒绝未知字段。
- [x] 定义 `FinalDiagnosis`、根因假设、未确认项、建议行动与风险等级 schema，并落实上节的 Evidence call ID 约束。
- [x] 设计 `ModelGateway.decide(input): Promise<ModelDecision>`，使 `agent-runtime` 只依赖该抽象，不依赖 `openai` SDK、Tool Gateway、环境变量或 HTTP 响应类型。
- [x] 删除现有的 `ModelGatewayBoundary` 占位导出，更新 `packages/model-gateway/src/index.ts` 仅导出正式公开契约与实现。

验收：调用方只依赖 `@opspilot/model-gateway` 的公开类型即可构造输入、读取工具调用或诊断，且不能把未验证的模型原始输出传给 Day8。

### 2. 消费供应商无关工具声明并生成协议 function schema

- [x] 在 `packages/model-gateway/src/openai-tools.ts` 中将 `ModelToolDefinition[]` 转为 OpenAI Responses 与 Chat Completions 所需的 function tool 声明。
- [x] 将参数 JSON Schema 作为供应商无关工具声明的一部分；Day8 的 Agent Runtime 从 Day6 定义派生该数据，Model Gateway 不导入 Day6 schema。
- [x] 保持工具名称、描述、调用参数和 `callId` 的单一事实来源；禁止在 ModelGateway 中复制具体工具的参数定义。
- [x] 将 OpenAI 返回的 function call 解析为 `ModelToolCall`，并在返回前校验调用结构与本轮工具白名单；参数 schema 验证留给 Day8 的 Tool Gateway。

验收：Agent Runtime 映射出的工具声明可生成等价 OpenAI function schema；具体工具名称、描述或参数 schema 的变更由跨包契约测试捕获，而不引入 Model Gateway → Tool Gateway 依赖。

### 3. 实现真实 Provider + 协议适配器

- [x] 新增 Provider 注册表与 `createModelGateway()`：`openai` 固定映射到 Responses API，`moonshotai-cn` 固定映射到 Kimi Chat Completions API；环境变量不能覆盖 Provider 端点。
- [x] 实现 `OpenAiResponsesModelGateway` 与 `OpenAiChatCompletionsModelGateway`，通过官方 Node SDK 调用各自协议，并将结果统一映射为 `ModelDecision`。
- [x] 将运行时配置收敛为 `ModelGatewayProviderConfig`：Provider、API key、明确的模型名、可选超时；缺少必要配置时快速失败，错误信息不得泄露 key。
- [x] 在项目根 `.env.example` 增加空值示例 `MODEL_PROVIDER`、`MODEL_API_KEY` 与 `MODEL_MODEL`，并在文档中说明仅由未来服务端组合根读取；真实 key 只放本地 `.env`，不提交仓库、不写入日志或测试快照。
- [x] 每次请求传递经转换的供应商无关 function tools 和明确的系统指令；适配器仅允许输出函数调用或符合 `FinalDiagnosis` schema 的完成结果。
- [x] 归一化网络、认证、限流、超时、拒绝和不可识别响应为稳定、安全的 `ModelGatewayError`；禁止记录提示词、完整模型输出或凭据。
- [x] 不启用 Provider 内建 web/file search、代码执行或任何写操作；模型只能声明本地只读函数，实际执行仍由 Day8 控制。

验收：在已配置且可用的 API key 下，可完成一次最小真实模型请求；返回结果被映射为 `tool_calls` 或 `diagnosis`。缺失 key、无效 key、超时与错误响应均安全失败，不产生未处理异常。

### 4. 提供仅用于测试的脚本化替身

- [ ] 新增 `packages/model-gateway/src/scripted-model-gateway.ts`，实现 `ScriptedModelGateway`；它按预设队列返回已校验的 `ModelDecision` 或预设错误。
- [ ] 替身接收测试明确传入的脚本，不读取 `MODEL_API_KEY`、不访问网络、不根据告警内容硬编码三场景路径。
- [ ] 脚本耗尽、返回无效决策或期待的输入不匹配时，返回稳定错误，便于 Day8 测试失败处理。
- [ ] 在包公开入口导出替身；生产组合根只允许显式调用 `createModelGateway()`，不得因缺少 Key 自动降级到脚本化替身。

验收：所有单元测试可在未设置 OpenAI 凭据、无网络环境下确定性运行；替身不能被视作产品演示或生产回退方案。

### 5. 依赖与构建配置

- [x] 修改 `packages/model-gateway/package.json`：增加运行时依赖 `openai`、`zod`；Model Gateway 不依赖 `@opspilot/tool-gateway`，由 Day8 的 Agent Runtime 同时依赖两者；保留现有 `build`、`test`、`typecheck` 脚本。
- [x] 如 TypeScript 的 SDK 类型或 Node 环境需要，补充最小化 Node 类型配置，保持严格编译。
- [x] 确认 package export 不暴露 OpenAI SDK 的内部响应类型；对外仅暴露本包 contracts 与本包定义的适配器接口。

验收：`@opspilot/model-gateway` 可独立构建、测试和类型检查；`agent-runtime` 无需变更即可在 Day8 注入 `ModelGateway`。

### 6. 编写测试与最小真实连通验证

- [ ] 新增 `packages/model-gateway/test/contracts.test.ts`。
- [ ] 新增 `packages/model-gateway/test/openai-tools.test.ts`。
- [x] 新增 Responses 与 Chat Completions 适配器测试，使用 SDK 客户端 mock，不发送网络请求。
- [ ] 新增 `packages/model-gateway/test/scripted-model-gateway.test.ts`。
- [ ] 仅在显式设置 `MODEL_PROVIDER`、`MODEL_API_KEY` 与 `MODEL_MODEL` 时运行手动、非默认的连通性验证；该验证不纳入 `pnpm test`、不在 CI 使用真实凭据。

验收：见下方测试验证计划；Day7 代码完成后再更新 `WorkPlan.md` 的 Day7 状态与实际验证结果。

## 具体文件列表

### 新增

```text
docs/Day7TaskList.md
packages/model-gateway/src/contracts.ts
packages/model-gateway/src/model-providers.ts
packages/model-gateway/src/openai-tools.ts
packages/model-gateway/src/openai-chat-completions-model-gateway.ts
packages/model-gateway/src/openai-responses-model-gateway.ts
packages/model-gateway/src/scripted-model-gateway.ts
packages/model-gateway/test/contracts.test.ts
packages/model-gateway/test/openai-tools.test.ts
packages/model-gateway/test/model-providers.test.ts
packages/model-gateway/test/openai-chat-completions-model-gateway.test.ts
packages/model-gateway/test/openai-responses-model-gateway.test.ts
packages/model-gateway/test/scripted-model-gateway.test.ts
```

### 修改

```text
packages/model-gateway/src/index.ts
packages/model-gateway/package.json
packages/model-gateway/tsconfig.json          # 仅在 Node/SDK 类型需要时修改
.env.example
WorkPlan.md                                   # 仅在 Day7 代码完成与验证后更新
pnpm-lock.yaml
```

### 不修改

```text
apps/api/
apps/api-runtime/
apps/web/
apps/worker/
packages/agent-runtime/                      # Day8 才实现 Loop
packages/application/
packages/db/
packages/domain/
packages/observability/
packages/tool-gateway/src/contracts.ts       # 由 Day8 Agent Runtime 消费公开 ToolDefinition
packages/tool-gateway/src/tool-gateway.ts    # Day8 才实际执行工具
packages/db/prisma/schema.prisma
```

## 测试验证计划

### `contracts.test.ts`

- `ModelDecisionInput` 拒绝空 Incident/Run ID、非法时间、未知字段、空工具集及非法轮次。
- `tool_calls` 与 `diagnosis` 必须互斥；空工具调用、未知工具、非对象 arguments、缺失/重复 `callId` 均被拒绝。
- `FinalDiagnosis` 拒绝缺失根因假设、无效置信度、空结论、无行动、非法风险等级、重复 Evidence call ID 和引用输入中不存在或失败调用的 ID。
- 合法诊断保留根因假设、置信度、已确认/未确认内容、行动和 Evidence call ID，且不接受额外字段。

### `openai-tools.test.ts`

- 供应商无关工具声明转换后保持函数名称、描述、参数 JSON Schema 与顺序不变，并始终生成严格的 OpenAI function tools。
- 参数 JSON Schema 要求对象根节点、`properties`、有效的 `required` 字段和 `additionalProperties: false`；Day8 再用 Day6 定义构造这些声明。
- 每个 OpenAI function call 都能转换为 `ModelToolCall`；非法 JSON、未知/未授权工具、非对象参数、缺失调用 ID 和非 function 输出被安全拒绝。具体工具参数的业务校验留给 Day8 Tool Gateway。

### `openai-responses-model-gateway.test.ts` 与 `openai-chat-completions-model-gateway.test.ts`

- SDK mock 断言请求使用配置的模型、Day6 function tools 与受控指令，不附带内建工具或原始 fixture。
- 模拟函数调用响应映射为已验证 `tool_calls`；模拟完成响应映射为已验证 `diagnosis`。
- 混合输出、空输出、无效 JSON、schema 不匹配、未知工具、网络/认证/限流/超时与模型拒绝均映射为稳定、安全的错误类别。
- 错误对象、日志钩子和快照中不包含 API key、完整提示词或原始模型内容。

### `scripted-model-gateway.test.ts`

- 按固定脚本顺序返回有效工具调用和有效诊断，确保测试不依赖网络或环境变量。
- 脚本耗尽、无效脚本项、输入断言失败与预设错误均产生稳定失败；替身不读取真实 Key。

### 手动真实连通验证（非默认测试）

1. 在未提交的本地 `.env` 设置 `MODEL_PROVIDER`、`MODEL_API_KEY` 与一个明确的 `MODEL_MODEL`。
2. 运行最小脚本，向模型提供一个告警和四项只读 function tools。
3. 验证返回值可被解析为至少一个有效 `ToolCall` 或 `FinalDiagnosis`；记录模型名、耗时和结果类别，绝不记录 key、完整提示词或原始响应。
4. 移除/置空 Key 后重复，确认构造或调用以安全配置错误失败，且没有自动切换到脚本化替身。

### 验收命令

```text
pnpm --filter @opspilot/model-gateway build
pnpm --filter @opspilot/model-gateway test
pnpm --filter @opspilot/model-gateway typecheck
pnpm test
pnpm typecheck
```

## 完成定义

- [ ] `@opspilot/model-gateway` 已将真实 OpenAI 调用封装在供应商无关的 `ModelGateway` 后。
- [ ] 模型每次只返回有效的工具调用决策或带可引用证据的最终诊断决策。
- [ ] OpenAI function 参数 schema 来自 Agent Runtime 提供的供应商无关工具声明，未在 Model Gateway 重复定义工具参数。
- [ ] 无效模型输出、配置错误和 API 失败在进入业务逻辑前被结构化拒绝，且不泄露敏感信息。
- [ ] 脚本化替身仅用于无网络、无凭据的单元测试，生产代码不会静默降级。
- [ ] Model Gateway 包及根目录测试、类型检查通过；真实连通验证结果已单独记录。
- [ ] 尚未实现 Agent Loop、工具执行、数据库持久化、API 入口或 Web 展示。

## Day 7 对项目的作用

Day7 为 Day8 的 Agent Loop 建立唯一的“决策大脑”接口：模型可以根据当前上下文选择查什么，或在证据充分时提交可审计的诊断，但不能绕过 Tool Gateway 直接读取数据或执行操作。真实 OpenAI 适配器证明系统能接入生产模型；脚本化替身保证控制流与失败分支仍可被低成本、确定性地测试。这样 Day8 只需关心循环、安全上限和工具执行，Day9 则可将相同契约中的调用与证据关联持久化。

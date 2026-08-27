# `@opspilot/tool-gateway`

`tool-gateway` 是 Agent Service 中连接 Agent 与具体可执行能力的通用边界层。

它负责在能力边界内提供稳定的 Contract、运行时校验、Connector / Adapter 以及明确的错误语义，同时隔离具体第三方实现。它不负责 Agent Loop、Agent Lifecycle、Agent State、模型调用或 ToolCall 生命周期管理，也不依赖 `agent-runtime`。

## Current status

当前已实现第一批 Excel Capability：`readRange`、`writeData` 和 `readRangeWithMetadata`。早期故障诊断 Demo 的 Log、Metric、Runbook、Service Topology Fixture 及其测试已移除。

当前公开入口只保留 Capability 目录的出口：

```text
src/
├── excel/
│   ├── contracts.ts
│   ├── schemas.ts
│   ├── errors.ts
│   ├── connectors/
│   ├── adapters/
│   └── index.ts
└── index.ts
```

`connectors/` 和 `adapters/` 目录会在确有实现时添加文件；空目录不作为代码提交。测试数据也按 Capability 放在：

```text
test/
├── excel/
└── fixtures/
    └── excel/
```

## Capability boundaries

未来实现 Excel Capability 时：

* `contracts.ts` 只放 OpsPilot 自己的稳定 Excel DTO / Contract。
* `schemas.ts` 放对应的 Zod Runtime Validation。
* `errors.ts` 放 Excel Capability 的错误语义。
* `connectors/` 放上层依赖的稳定能力接口。
* `adapters/` 放具体第三方技术实现；第三方类型不应泄漏到公共 Contract。

其他 Capability（例如 `rag/`、`search/`）在真正开始实现时再添加，并保持各自边界，不建立全局巨型 `contracts.ts`。

## Boundary

Tool Gateway 的调用关系应保持为：

```text
Agent Runtime
      ↓
Agent Tool
      ↓
Tool Gateway Capability Contract
      ↓
Connector / Adapter
      ↓
Third-party Library / External System
```

Agent Tool 与 Connector 的组合属于更上层。Tool Gateway 不负责生成 `ToolResultMessage`，也不直接接入 Agent Runtime、Backend 或文件访问系统。

所有未来进入 Capability 的外部输入都必须在边界处校验，并明确处理失败、超时和取消语义。

## Testing

当前没有需要保留的 Tool Gateway 测试。未来增加具体 Capability 后，应在对应的 `test/<capability>/` 下覆盖其 Contract、校验、成功路径、失败路径、取消和回归行为；真实外部文件或服务行为应在明确边界处使用集成测试。

运行：

```bash
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

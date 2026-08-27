# `@opspilot/tool-gateway`

`tool-gateway` 是 Agent Service 中连接 Agent 与具体可执行能力的通用边界层。

它负责在能力边界内提供稳定的 Contract、运行时校验、Connector / Adapter 以及明确的错误语义，同时隔离具体第三方实现。它不负责 Agent Loop、Agent Lifecycle、Agent State、模型调用或 ToolCall 生命周期管理，也不依赖 `agent-runtime`。

## Current status

当前已实现 Excel Capability：

Data

- `readRange`
- `writeData`
- `readRangeWithMetadata`

Discovery

- `getWorkbookInfo`
- `getSheetProfile`

Discovery 用于“大表读取前的结构侦察”：Agent 可以先了解 Workbook / Worksheet 的大小、Sheet 状态、Header 和列类型，避免默认把整个 Workbook 数据送入模型上下文。早期故障诊断 Demo 的 Log、Metric、Runbook、Service Topology Fixture 及其测试已移除。

当前公开入口只保留 Capability 目录的出口：

```text
src/
├── excel/
│   ├── shared/
│   │   ├── errors.ts
│   │   ├── cell-reference.ts
│   │   └── exceljs/
│   │       ├── workbook-io.ts
│   │       └── used-range.ts
│   ├── data/
│   │   ├── contracts.ts
│   │   ├── schemas.ts
│   │   ├── connector.ts
│   │   ├── exceljs-data-adapter.ts
│   │   └── index.ts
│   ├── discovery/
│   │   ├── contracts.ts
│   │   ├── schemas.ts
│   │   ├── connector.ts
│   │   ├── exceljs-discovery-adapter.ts
│   │   ├── type-inference.ts
│   │   └── index.ts
│   └── index.ts
└── index.ts
```

测试按 Capability 放在：

```text
test/
└── excel/
    ├── data/
    └── discovery/
```

## Capability boundaries

Excel Capability 的边界：

- `data/` 和 `discovery/` 分别维护各自的稳定 Contract、Zod Schema、Connector 和 ExcelJS Adapter。
- `shared/` 只放跨能力复用的错误模型、A1 地址、Workbook IO 和 used-range 扫描。
- Discovery 的 used range 只按实际单元格值计算；Data 保留现有数据验证相关行为。
- ExcelJS 类型限制在 Adapter 与共享实现内部，不泄漏到公开 Contract。

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

测试位于对应的 `test/<capability>/` 目录，覆盖 Contract、校验、成功路径、失败路径、取消和回归行为；真实外部文件或服务行为在明确边界处使用集成测试。

运行：

```bash
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

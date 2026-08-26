# `@opspilot/tool-gateway`

`tool-gateway` 是 Agent Service 中连接 Agent 与具体可执行能力的边界层。

它负责定义稳定的能力契约，并通过 Connector / Adapter 将文件、外部服务、基础设施或其他具体能力接入 Agent 系统。

```text
Agent
  ↓
AgentTool
  ↓
Tool Gateway
  ↓
Connector / Adapter
  ↓
Concrete Capability
```

---

## Responsibilities

`tool-gateway` 负责：

* 定义外部能力的输入 / 输出契约
* 使用 Zod 校验运行时输入和输出
* 定义 Connector / Adapter 接口
* 实现具体能力的技术适配
* 隔离第三方 SDK 和协议细节
* 传播 `AbortSignal`
* 统一能力边界的错误语义
* 为上层提供稳定、类型安全的调用接口

具体能力可以包括：

* Excel 文件处理
* HTTP API
* 搜索 / RAG
* 数据库查询
* 日志与指标查询
* 其他 Agent 可调用能力

新增能力时，应优先通过独立 Connector / Adapter 接入，而不是把第三方实现细节传播到上层。

---

## Boundary

`tool-gateway` 不负责：

* Agent Loop
* Agent Lifecycle
* Agent State
* Context 管理
* 模型调用
* ToolCall 生命周期管理
* `ToolResultMessage` 封装
* Agent 业务流程编排

这些职责属于 Agent Runtime 或更上层的 Agent 组合代码。

因此：

```text
tool-gateway
```

不应依赖：

```text
agent-runtime
```

AgentTool 与 Connector 的组合应发生在更上层：

```text
AgentTool.execute()
      ↓
validate input
      ↓
Connector
      ↓
Concrete Capability
      ↓
AgentToolResult
```

这样 Tool Gateway 可以独立于 Agent Runtime 使用和测试。

---

## Excel Capability

Excel 文件处理属于 `tool-gateway` 的具体能力之一。

实现采用：

```text
ExcelJS
```

处理 `.xlsx` 文件。

推荐结构：

```text
src/
├── excel/
│   ├── contracts.ts
│   ├── schemas.ts
│   ├── exceljs-excel-connector.ts
│   └── index.ts
├── ...
└── index.ts
```

调用关系：

```text
AgentTool
   ↓
ExcelConnector
   ↓
ExcelJsExcelConnector
   ↓
ExcelJS
   ↓
.xlsx
```

### ExcelConnector

上层依赖稳定的 Excel 能力契约，而不是直接依赖 ExcelJS。

例如可以逐步提供：

```text
inspectWorkbook
readRange
writeRange
```

后续根据实际业务需求扩展：

```text
worksheet operations
formula operations
formatting
table operations
```

不要为了未来可能需要的能力一次性设计完整 Excel API。

### ExcelJS Boundary

ExcelJS 属于具体技术实现。

以下类型不应泄漏到 Connector 公共契约：

```text
Workbook
Worksheet
Cell
Row
Column
```

公共契约应使用稳定的 TypeScript DTO。

例如：

```text
ReadRangeInput
ReadRangeResult
WriteRangeInput
WriteRangeResult
WorkbookInfo
```

这样未来替换底层 Excel 库时，不需要修改 Agent Runtime 或上层 Agent Tool 契约。

---

## File Boundary

Agent Tool 不应接受由模型直接生成的任意服务器物理路径。

避免：

```text
C:\uploads\xxx.xlsx
/var/data/xxx.xlsx
../../secret.xlsx
```

模型侧应使用稳定的资源标识，例如：

```text
fileId
```

文件标识到实际可访问文件的解析应通过受控边界完成。

Tool Gateway 不应信任模型提供的：

* 绝对路径
* 相对路径
* 文件名
* Sheet 名
* Range
* 其他外部输入

所有外部输入均应进行必要校验。

---

## Connector Design

一个 Connector 通常包含四部分：

```text
Schema
  ↓
Contract
  ↓
Implementation
  ↓
External Capability
```

例如：

```text
readRangeInputSchema
        ↓
ExcelConnector
        ↓
ExcelJsExcelConnector
        ↓
ExcelJS
```

设计原则：

* 输入输出使用明确类型
* 外部输入使用 Zod 校验
* 第三方异常在边界处转换或补充上下文
* 支持取消的操作传播 `AbortSignal`
* 不把第三方 SDK 类型暴露给调用方
* 一个 Connector 聚焦一类相关能力
* 不创建万能 `ToolService`

---

## Existing Fixtures

当前仓库仍保留早期 Demo 使用的 Fixture Connector，例如：

* Log
* Metric
* Runbook
* Service Topology

这些实现主要用于测试和历史 Demo。

它们不代表 `tool-gateway` 只负责运维场景。

`tool-gateway` 的长期定位是：

> Agent Service 中通用的外部能力执行边界。

历史能力可以继续保留用于测试或逐步迁移，但不应影响新的 Tool Gateway 设计。

---

## Error Handling

Connector 遇到失败时，应提供明确的错误信息并保留原始原因。

例如区分：

```text
Validation Error
File Not Found
Unsupported Format
Capability Error
External Service Error
Cancellation
Unexpected Error
```

Connector 不负责生成：

```text
ToolResultMessage
```

最终 Tool 执行错误如何转换成 Agent 消息，由 Agent Runtime 的工具执行机制统一处理。

---

## Testing

Tool Gateway 测试重点覆盖：

* Schema Validation
* Connector Happy Path
* Invalid Input
* External Capability Failure
* Cancellation
* Regression Case

对于 Excel 能力，应使用真实 `.xlsx` fixture 验证：

```text
.xlsx
 ↓
open workbook
 ↓
inspect / read / write
 ↓
save
 ↓
reopen
 ↓
verify result
```

不要只 Mock ExcelJS 来证明 Excel 文件可以被正确处理。

运行：

```bash
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

---

## Core Principle

Tool Gateway 解决的是：

> Agent 如何安全、稳定地访问具体能力。

Agent Runtime 解决的是：

> Agent 如何运行以及如何执行 ToolCall。

具体第三方实现解决的是：

> 能力实际上如何完成。

保持这三层边界分离：

```text
Agent Runtime
      ↓
Agent Tool
      ↓
Tool Gateway Contract
      ↓
Connector / Adapter
      ↓
Third-party Library / External System
```

对于 Excel：

```text
Agent Runtime
      ↓
Agent Tool
      ↓
ExcelConnector
      ↓
ExcelJsExcelConnector
      ↓
ExcelJS
      ↓
.xlsx
```

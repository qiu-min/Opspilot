# @opspilot/tool-gateway

`tool-gateway` 是 Agent Service 中封装外部可执行能力的基础设施层。

它向上层提供稳定的 Capability Contract，并隔离 ExcelJS 等具体实现。

## Current Capabilities

### Excel

Data

- `readRange`
- `writeData`
- `readRangeWithMetadata`

Discovery

- `getWorkbookInfo`
- `getSheetProfile`

Aggregate

- `aggregateData`

Filter

- `filterData`

## Structure

```text
src/
└── excel/
    ├── data/
    ├── discovery/
    ├── aggregate/
    ├── filter/
    └── shared/
```

- `data/`：Excel 数据读写能力
- `discovery/`：Workbook / Worksheet 结构发现能力
- `aggregate/`：数据聚合能力
- `filter/`：按精确表头和类型条件筛选数据行的能力
- `shared/`：Excel Capability 间复用的基础实现

## Architecture

```text
Application / Agent Tool
        ↓
Tool Gateway Capability
        ↓
Connector / Adapter
        ↓
ExcelJS / External System
```

Tool Gateway 提供可执行能力，具体 Agent Tool 的定义与业务编排由上层负责。

## Development

```bash
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

开发规范与架构约束见 `AGENTS.md`。

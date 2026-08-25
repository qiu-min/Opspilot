# `@opspilot/tool-gateway`

`tool-gateway` 提供访问外部系统的 Connector 契约、输入/输出 Zod schema 和 Fixture 实现。它不负责 Agent Loop、ToolCall 生命周期或 `ToolResultMessage` 封装，也不依赖 `agent-runtime`。

## Connector

当前提供四类能力：

- `LogConnector.query()`
- `MetricConnector.query()`
- `RunbookConnector.search()`
- `ServiceTopologyConnector.get()`

每个 Connector 都接收已经定义好的输入类型和可选 `AbortSignal`，并返回经过输出 schema 校验的数据。日志、指标和拓扑结果可以携带 `sourceUri` 与时间范围等来源 metadata；`evidenceKind` 等故障领域语义由上层 `incident-agent` 映射。

## Fixture 使用

```ts
import {
  FixtureLogConnector,
  type QueryLogsInput,
} from '@opspilot/tool-gateway';

const input: QueryLogsInput = {
  service: 'billing-api',
  startTime: '2026-08-13T10:00:00.000Z',
  endTime: '2026-08-13T10:15:00.000Z',
  query: 'timeout',
};

const result = await new FixtureLogConnector().query(input, signal);
```

Connector 输入会在真实外部能力边界再次校验。未知服务或无匹配数据直接抛出异常，由 `incident-agent` 创建的 `AgentTool` 交给 `agent-runtime` 转换成 `ToolResultMessage`。

## AgentTool 组合边界

`tool-gateway` 不定义 `AgentTool`。未来由 `incident-agent` 组合 `AgentTool` 与 Connector：在 `AgentTool.execute()` 中解析输入、调用 Connector，并将结果序列化为 `AgentToolResult`。这样 `agent-runtime` 保持唯一的工具执行契约和错误封装职责。


① 定义 Connector interface

LogConnector
MetricConnector
RunbookConnector
ServiceTopologyConnector


② 定义 Connector 输入输出

QueryLogsInput
QueryLogsOutput
QueryMetricsInput
...


③ Zod 边界验证

queryLogsInputSchema
queryLogsOutputSchema
...


④ 实现具体外部能力

FixtureLogConnector
FixtureMetricConnector
FixtureRunbookConnector
FixtureServiceTopologyConnector


⑤ 传播取消

AbortSignal
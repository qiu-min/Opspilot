# @opspilot/domain

OpsPilot 的 Session Domain package。

当前只包含纯内存 `Session` aggregate。Session 同时拥有两部分业务状态：

- `SessionMetadata`：`id`、可空 `title`、`createdAt`、`updatedAt`
- Session history tree：entries、parent、active leaf、branch 和 compaction invariants

metadata mutation 不会生成 history entry，也不会改变 history tree。持久化格式和文件布局属于上层 Application adapter；Domain 只通过显式的 restore/create API 接收和返回业务状态。

Application projection 通过 `buildSessionContext(session)` 将 durable history 转换为 Agent Runtime context，metadata 不进入 Agent context。

## Turn

`Turn` 表示一次 Application-level Agent execution，与 Session history 分开持久化。
它只保存执行状态、尝试次数、Session leaf 引用和最小恢复 checkpoint；不保存 Agent 实例、流式 token、Tool 实例或 Runtime state。

`TurnEvent` 是 append-only durable execution fact，不是 SSE event，也不是 `SessionEntry`。
`Turn` 保存当前 snapshot，Turn event history 由 Application 的 `TurnStore` port 管理。

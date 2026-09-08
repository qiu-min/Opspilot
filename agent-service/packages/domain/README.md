# @opspilot/domain

OpsPilot 的 Session Domain package。

当前只包含纯内存 `Session` aggregate。Session 同时拥有两部分业务状态：

- `SessionMetadata`：`id`、可空 `title`、`createdAt`、`updatedAt`
- Session history tree：entries、parent、active leaf、branch 和 compaction invariants

metadata mutation 不会生成 history entry，也不会改变 history tree。持久化格式和文件布局属于上层 Application adapter；Domain 只通过显式的 restore/create API 接收和返回业务状态。

Application projection 通过 `buildSessionContext(session)` 将 durable history 转换为 Agent Runtime context，metadata 不进入 Agent context。

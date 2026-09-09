# OpsPilot Backend

Backend 是面向 Web 的 ASP.NET Core 业务边界，负责用户认证、Session ownership、产品元数据、文件资产和 Agent Service HTTP 协调。

## Session / Turn boundary

```text
Web Session
    ↓
Backend Session ownership boundary
    ↓
Agent Service Session
    ↓
Turn
    ↓
Step
```

Backend `Session.Id` 与 Agent Service `Session.Id` 是同一个 identity。Backend PostgreSQL 只保存：

```text
sessions(id, user_id, title, created_at_utc, updated_at_utc)
```

消息树和执行事实仍由 Agent Service 的 Session / Turn / TurnEvent 持久化；Backend 不保存 Turn 表、消息历史或 `TurnStreamProjection`。`TurnEvent` 是 durable execution fact，`TurnStreamEvent` 是 ephemeral live UI event。

创建 Session 的调用链：

```text
POST /api/sessions
    ↓
Backend → POST /sessions
    ↓
Agent Service 返回真实 sessionId
    ↓
Backend 保存 Session ownership row
```

如果 Agent Service 创建成功而 Backend 保存失败，第一版允许 orphan Agent Service Session。

## Public API

所有 Session 路由都要求 JWT，并按 `Session.UserId == currentUser.UserId` 做 ownership 验证；不存在或不属于当前用户统一按 404 处理。

```text
POST /api/sessions
GET  /api/sessions
GET  /api/sessions/{sessionId}
POST /api/sessions/{sessionId}/turns
POST /api/sessions/{sessionId}/turns/stream
GET  /api/sessions/{sessionId}/active-turn
GET  /api/sessions/{sessionId}/turns/{turnId}/stream?after=N
```

Backend stream adapter 原样转发 Agent Service PR2 `TurnStreamEvent`，保留 `turnId`、`sessionId`、`sequence`、`timestamp`，SSE `id` 等于 `sequence`。Backend 只负责 ownership、文件资源解析、错误映射和 SSE transport，不再次推断 thinking、assistant、tool 或 compaction semantics。

Agent Service stream conflicts 的 machine-readable `code` 会继续透传到 Backend ProblemDetails；`TURN_STREAM_REPLAY_GAP` 与 `SESSION_ACTIVE_TURN_CONFLICT` 不会被折叠成同一种 Web 语义。

`GET /api/sessions/{sessionId}/active-turn` 直接读取 Agent Service live Hub projection。reattach 先验证 Session ownership，再确认 active Turn 的 `turnId` 与 route 一致，随后只调用 Agent Service reattach endpoint，不创建新 Turn。reattach 是恢复观看，不是 resume 执行。

SSE subscriber 断开只取消该 subscriber 的 HTTP/Agent stream connection，不调用 Turn cancel 或 Agent abort；执行状态不变。

## Files

Backend 管理 FileAsset 生命周期和访问权限。请求中的 `fileId` 先经过 ownership 检查，再将共享存储相对路径转换为 Agent Service 的 Excel resource。Workbook 解析和工具执行属于 Agent Service Tool Gateway。

## Persistence migration

`20260909122355_MigrateConversationsToSessions` 是真实 schema transition：已绑定旧行使用非空 `agent_session_id` 作为新的 `sessions.id`，保留 user/title/timestamps；没有真实 Agent Service Session 的 legacy empty rows 被清理。之后 schema 不再包含 `agent_session_id`，模型也不保留 compatibility layer。历史 migration 文件只作为不可修改的 schema history 保留。

## Development

```bash
cd backend
dotnet restore
dotnet build
dotnet test
```

数据库结构通过 EF Core Migration 管理；开发数据库可按项目约定执行：

```bash
dotnet ef database update --project src/OpsPilot.Infrastructure --startup-project src/OpsPilot.Api
```

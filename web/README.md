# OpsPilot Web

OpsPilot Web 是 React 工作台。页面业务概念是 Session + Turn：Session detail/history 提供 durable timeline，active Turn 的 `TurnStreamProjection` 与 `TurnStreamEvent` 提供当前 live UI。

## Recovery model

进入或刷新 Session 时，Web 并行读取：

```text
GET /api/sessions/{sessionId}
GET /api/sessions/{sessionId}/active-turn
```

如果存在 active Turn，先 hydrate projection，再使用 `lastSequence` reattach：

```text
GET /api/sessions/{sessionId}/turns/{turnId}/stream?after=N
```

SSE 意外断开不等于 Turn failed。Web 会重新读取 active-turn；仍 active 时 hydrate/reconcile 后最多重新观看一次，active-turn 为 null 时重新读取 durable Session history。Replay gap 409 也走同一 projection refetch/retry 路径。

同一个 SPA 内切换 Session 不会 abort 其他 Session 的 Turn。live state 按 `turnId` 管理，`activeTurnIdBySessionId` 只保存 Session 到 active Turn 的映射；如果已有该 Turn 的 subscriber，不重复建立第二条 SSE。

terminal `turn_completed`、`turn_failed` 或 `turn_cancelled` 到达后，Web 重新获取 Session detail，以 durable history 为 source of truth，再清理对应 Turn live state 并刷新 Session list metadata。

## API / feature layout

```text
src/api/sessions/
  session-contracts.ts
  session-api.ts
  turn-stream-contracts.ts
  turn-sse-parser.ts

src/features/session/
  session-page.tsx
  session-sidebar.tsx
  turn-stream-state.ts
  turn-stream-projection.ts
```

SSE parser 严格验证 event name、payload `type`、`turnId`、`sessionId`、safe non-negative `sequence`、timestamp，以及 SSE `id == sequence`。未知事件和协议不一致使用 `TurnStreamProtocolError`。

## Development

```bash
cd web
pnpm build
pnpm test
```

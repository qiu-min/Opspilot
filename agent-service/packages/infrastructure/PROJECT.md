# @opspilot/infrastructure Project

`@opspilot/infrastructure` 提供 Agent Service 的具体外部系统 adapter。当前范围是实现 Application 的 `SessionStore` 与 `TurnStore` port，并将 Session history、Turn metadata snapshot 和 append-only TurnEvent history 持久化到 filesystem；同时提供 `InMemoryTurnStreamHub` 作为 Application live stream port 的单进程实现。

## Boundary

```text
@opspilot/domain
        ↑
@opspilot/application  (SessionStore / TurnStore ports)
        ↑
@opspilot/infrastructure (FileSystemSessionStore / FileSystemTurnStore)
        ↑
apps/api-runtime (composition root)
```

Infrastructure 可以依赖 Application contract 与 Domain aggregate；Application 不依赖 Infrastructure，api-runtime 负责把具体 adapter 注入 `ExecuteTurn`、`GetSessionHistory` 和 live stream use cases。

## Session filesystem adapter

当前布局：

```text
sessions/{sessionId}/
├── metadata.json
└── history.jsonl
```

Infrastructure 保留 legacy `{sessionId}.jsonl` 读取和 lazy migration 行为：新布局优先；不完整的新布局报告错误且不 fallback；迁移复制原始 history bytes 并保留 legacy 文件；metadata 使用 atomic replacement，history 保持 append-only。

公开的具体能力包括 `FileSystemSessionStore`、JSONL helpers、metadata JSON helpers 和 filesystem persistence errors。它们不从 Application 导出。

本 package 不定义 Turn 业务状态转换；它只实现 Application 的持久化 port 和进程内 live stream hub，不直接引入 Prisma、SQLite、Redis 或数据库 repository。`InMemoryTurnStreamHub` 的 projection、ring buffer 和 subscriber queue 都不持久化，进程重启后丢失是允许的。

## Live stream adapter

每个 active Turn 有独立 channel，保存 Turn identity、下一个 stream sequence、当前
`TurnStreamProjection`、默认 256 条 replay buffer 和多个 subscriber queue。注册
subscriber 时会同步完成 replay seed 与 live queue 注册，因此 projection snapshot 后用
`subscribe(turnId, afterSequence)` 不会出现 gap；当请求点已落出 ring buffer 时抛出
`TurnStreamReplayGapError`。terminal event 先入队，再结束 subscriber，并清除 Session 的
active mapping。

Turn filesystem layout 为：

```text
turns/{turnId}/
├── metadata.json
└── events.jsonl
```

`metadata.json` 保存当前 Turn snapshot 并使用 atomic replacement；`events.jsonl` 保存严格连续 sequence 的 append-only `TurnEvent`。本阶段不实现自动恢复执行。

加载 Turn 时，Infrastructure 会检查当前 attempt 的 terminal event。若 metadata 仍为 running/interrupted 但 events 已经持久化 `turn_completed`、`turn_failed` 或 `turn_cancelled`，会在内存中 reconciliation 为对应 terminal state；不会覆盖 checkpoint，也不会把 terminal event 当成 checkpoint。相同 attempt 的冲突 terminal conclusion 会被拒绝。

## Verification

在 `agent-service/` 目录运行：

```bash
pnpm --filter @opspilot/infrastructure typecheck
pnpm --filter @opspilot/infrastructure test
pnpm --filter @opspilot/infrastructure build
```

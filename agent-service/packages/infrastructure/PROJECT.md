# @opspilot/infrastructure Project

`@opspilot/infrastructure` 提供 Agent Service 的具体外部系统 adapter。当前范围是实现 Application 的 `SessionStore` 与 `TurnStore` port，并将 Session history、Turn metadata snapshot 和 append-only TurnEvent history 持久化到 filesystem。

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

Infrastructure 可以依赖 Application contract 与 Domain aggregate；Application 不依赖 Infrastructure，api-runtime 负责把具体 adapter 注入 `ExecuteTurn` 和 `GetSessionHistory`。

## Session filesystem adapter

当前布局：

```text
sessions/{sessionId}/
├── metadata.json
└── history.jsonl
```

Infrastructure 保留 legacy `{sessionId}.jsonl` 读取和 lazy migration 行为：新布局优先；不完整的新布局报告错误且不 fallback；迁移复制原始 history bytes 并保留 legacy 文件；metadata 使用 atomic replacement，history 保持 append-only。

公开的具体能力包括 `FileSystemSessionStore`、JSONL helpers、metadata JSON helpers 和 filesystem persistence errors。它们不从 Application 导出。

本 package 不定义 Turn 业务状态转换；它只实现 Application 的持久化 port，不直接引入 Prisma、SQLite、Redis 或数据库 repository。

Turn filesystem layout 为：

```text
turns/{turnId}/
├── metadata.json
└── events.jsonl
```

`metadata.json` 保存当前 Turn snapshot 并使用 atomic replacement；`events.jsonl` 保存严格连续 sequence 的 append-only `TurnEvent`。本阶段不实现自动恢复执行。

## Verification

在 `agent-service/` 目录运行：

```bash
pnpm --filter @opspilot/infrastructure typecheck
pnpm --filter @opspilot/infrastructure test
pnpm --filter @opspilot/infrastructure build
```

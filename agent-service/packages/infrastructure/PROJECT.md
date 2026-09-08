# @opspilot/infrastructure Project

`@opspilot/infrastructure` 提供 Agent Service 的具体外部系统 adapter。当前范围是实现 Application 的 `SessionStore` port，并将 Session metadata 与 append-only history 持久化到 filesystem。

## Boundary

```text
@opspilot/domain
        ↑
@opspilot/application  (SessionStore port)
        ↑
@opspilot/infrastructure (FileSystemSessionStore)
        ↑
apps/api-runtime (composition root)
```

Infrastructure 可以依赖 Application contract 与 Domain aggregate；Application 不依赖 Infrastructure，api-runtime 负责把具体 adapter 注入 `RunConversationTurn` 和 `GetConversationHistory`。

## Session filesystem adapter

当前布局：

```text
sessions/{sessionId}/
├── metadata.json
└── history.jsonl
```

Infrastructure 保留 legacy `{sessionId}.jsonl` 读取和 lazy migration 行为：新布局优先；不完整的新布局报告错误且不 fallback；迁移复制原始 history bytes 并保留 legacy 文件；metadata 使用 atomic replacement，history 保持 append-only。

公开的具体能力包括 `FileSystemSessionStore`、JSONL helpers、metadata JSON helpers 和 filesystem persistence errors。它们不从 Application 导出。

本 package 不拥有 `Run`、`RunSnapshot`、`RunEvent`，不直接引入 Prisma、SQLite、Redis 或数据库 repository。

## Verification

在 `agent-service/` 目录运行：

```bash
pnpm --filter @opspilot/infrastructure typecheck
pnpm --filter @opspilot/infrastructure test
pnpm --filter @opspilot/infrastructure build
```

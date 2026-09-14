# @opspilot/domain Project

`@opspilot/domain` 提供纯内存的 Session aggregate，不依赖 Node 文件系统、持久化 adapter 或应用层回调。

## Session aggregate

Session 包含两个逻辑部分：

```text
Session
├── SessionMetadata
│   ├── id
│   ├── title
│   ├── createdAt
│   ├── updatedAt
│   └── resources: SessionResourceRef[]
└── History Tree
    ├── MessageEntry
    ├── ModelChangeEntry
    ├── ThinkingLevelChangeEntry
    └── CompactionEntry
```

`rename()` 和 `registerResource()` 只修改 product metadata，不进入 entries，不改变 leaf 或
branch。Resource registry 只保存 `id + kind`，当前 kind 只有 `excel`；同一个引用重复注册
不会产生重复项，`getResources()` 返回副本。所有 durable history mutation 都会以 entry timestamp
推进 `updatedAt`。`Session.restore()` 会验证 metadata 与 history header 的 id、creation timestamp
一致，并重建 tree invariants；如果 metadata 落后于已恢复 entry，会将 `updatedAt` reconciliation
到最新 durable timestamp。

持久化由 Application 定义的 `SessionStore` port 和 Infrastructure adapter 负责；Domain 不依赖任一持久化实现。Application 负责在 Domain 的 `SessionMessage` / `SessionThinkingLevel` 与 Agent Runtime 输入之间做转换；Session metadata 不属于 Session message history。

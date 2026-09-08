# @opspilot/domain

OpsPilot 的 Session Domain package。

当前只包含纯内存 `Session` aggregate：Session identity、entries、树/branch、active leaf 和 compaction invariants。它不依赖 JSONL、Node 文件系统、repository 或 application callback。

Session 的 JSONL create/load/append 由 `@opspilot/application` 的 `SessionStore` adapter 负责；Application projection 通过 `buildSessionContext(session)` 将 durable state 转换为 Agent Runtime context。

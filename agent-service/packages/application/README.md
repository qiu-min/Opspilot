# @opspilot/application

OpsPilot Agent Service 的应用层。

`application` 位于业务入口与通用 Agent Runtime 之间，负责围绕 Session 组织 Agent 的实际使用流程，并协调运行时、会话状态、上下文、工具与持久化 port。

当前已提供最小 `AgentSession` 闭环：从 Domain `Session` 恢复消息、模型和 thinking level，组合 `Agent` 与 `ModelGateway`，并通过 Application 的 `SessionStore` 在 Runtime `message_end` 之后 append finalized message。ToolResult 的 `content` 进入 Session history；machine-facing `details` 进入对应的 durable `TurnEvent.tool_completed.resultDetails`。

## Session persistence

`Session` 是用户可见长期会话的 Domain aggregate，由 `SessionMetadata`（包含轻量 resource
registry）和 history tree 组成。Application 只定义 `SessionStore` port；`@opspilot/infrastructure`
的 `FileSystemSessionStore` 使用以下新布局：

```text
sessions/{sessionId}/
├── metadata.json   # mutable metadata, atomic replace
└── history.jsonl   # append-only Session history
```

`metadata.json` 保存 versioned filesystem record，包括 Session resource registry 和可空的
`activeResourceId`；`history.jsonl`
保留现有 Session header 和 entry 格式。旧的 `sessions/{sessionId}.jsonl` 会在首次成功读取后
非破坏性 lazy migrate 到新目录，旧文件保持不变；新目录优先，且不完整的新目录不会 fallback
到旧文件。旧 metadata 缺少 `resources` 时按空 registry 读取。
旧 metadata 缺少 `activeResourceId` 时按 `null` 读取。Excel source locator 不进入 Session
metadata，而由 Application 的 `ExcelSourceResourceStore` 独立持久化；filesystem adapter 使用
`workspaces/{sessionId}/excel-source-locators.json`，后续 Turn 会按 registry 恢复所有仍有
locator 的 Excel resources，并单独标识 active resource。

`SessionStore.appendEntry()` 先追加 history，再原子更新 `metadata.updatedAt`；metadata update 失败会明确抛错，下一次 load 会根据 durable history reconciliation。`saveMetadata()` 通过 temp file + rename 原子替换整个 metadata snapshot。

Application 同时定义 `TurnStore` 与 `TurnExecutionContextStore` port。Turn snapshot、append-only `TurnEvent` history 和最小执行输入是独立的 durable execution boundary，不写入 Session JSONL；`TurnRecoveryPlanner`、`ResumeTurn` 与 `RecoverTurnsOnStartup` 负责进程 crash 后的执行恢复。

Application maps model-gateway `ModelErrorInfo` to the domain-owned `ModelFailureSnapshot` at the
execution boundary. `TurnEventRecorder` records `model_failed` for a model response with
`finishReason: 'error'` and a model call id, while aborted responses continue to use
`turn_cancelled`; `model_failed` is the failure of one model call and does not replace `turn_failed`.
Gateway 安排 transient retry 时，`TurnEventRecorder` 将 `AgentEvent.model_retry` 记录为 durable
`model_retry_scheduled`，同时 `TurnStreamProjector` 产生 UI-safe ephemeral `model_retry`。Retry
属于同一逻辑 Model Call 的执行事实，不创建 Session entry；只有最终成功或耗尽后的最终失败消息进入 Session。

## Live Turn stream

Application 还定义独立的 `TurnStreamEvent` presentation contract、纯 reducer
`applyTurnStreamEvent()`、`TurnStreamProjector` 和 `TurnStreamHub` port。Projector 将
`AgentSessionEvent` 转成 UI-safe live facts；reasoning/thinking delta 只会变成
`assistant_thinking_started` / `assistant_thinking_completed`，不会传输隐藏 reasoning 文本。

`TurnStreamProjection` 只保存当前 Turn 的 partial assistant text、thinking 状态、tool
状态（可带由注入的 `ToolPresentationResolver` 生成的 UI-safe `ToolDisplayInfo`）、compaction 状态、usage、当前 retry 状态和 `lastSequence`，不替代 Session history，也不暴露
`MutableAgentState`。`TurnStreamEvent.sequence` 由 Hub 从 0 开始独立分配，和 durable
`TurnEvent.sequence` 无关。Hub 在内存保留有限 replay buffer（默认 256）；丢失范围会以
`TurnStreamReplayGapError` 明确报告。

SSE disconnect 只取消当前 subscriber，不会调用 `AgentSession.abort()` 或取消
`ExecuteTurn`。terminal stream event 发送后 subscriber 正常结束，live Session mapping
被移除。reattach 与 resume 是不同语义：reattach 只恢复观看，resume 使用 durable
checkpoint 恢复同一个 Turn 的执行。

## Durable Turn presentation

`TurnStreamProjection` 是 active Turn 的 live / ephemeral presentation；它不进入 Session
history。历史恢复由 `GetSessionHistory` 在 application 边界组合两个纯 read projection：

```text
Session branch -> buildSessionHistoryProjection() -> items
Turn + TurnEvent + SessionEntry -> buildTurnPresentationSummary() -> turnSummaries
```

`TurnPresentationSummary` 每次从 durable `Turn`、`TurnEvent` 和相关的
`SessionEntry` 重建，不新增 summary 文件、数据库表或 TurnEvent schema/version。只返回
terminal Turn，并按当前 branch 的 user input 顺序排序；`usage_recorded` 每条代表一个
完成 model call 的最终 contribution，Turn usage 会累加全部记录。工具的 display 通过与
live presentation 相同的 `ToolPresentationResolver` 重新解析，失败时安全降级为工具名。

## 职责

本包主要负责：

- 创建、恢复和管理 Agent Session
- 通过 `SessionStore` port 协调 Domain Session mutation 与持久化
- 通过 `TurnStore` port 保存 Application Turn snapshot 与 durable execution events
- 接收用户输入并驱动一次 Agent Run
- 将 Session 上下文恢复到 Agent Runtime
- 通过 `ContextManager` 决定单次模型调用看到的消息
- 通过 Context Accounting 估算上下文用量并判断是否接近模型窗口
- 监听 Agent Runtime 产生的消息与执行事件
- 将完成的消息和 ToolResult content 写入 Session，并将 ToolResult details 写入 durable TurnEvent
- 组织 Session 的创建、继续、切换与后续扩展能力
- 组合具体 Agent 所需的模型配置、System Prompt 与工具
- 向上层 API 提供稳定的应用用例接口

Excel Application Tools 使用当前 Turn 的 `ToolExecutionContext` 携带 `turnId`、
`excelResources`、`excelResourceRefs` 与 `activeExcelResourceId`。其中 `turnId` 只供 Application
执行期使用，不进入 Agent Runtime、模型可见参数或持久化 `execution.json`。模型可以在工具参数中传入
Session-local 的 `resource` 别名；Application 先将别名解析为 `ExcelResource`，再通过
`ExcelWorkingResourceManager.resolveReadablePath()` 按当前 Session 与 resource id 选择 source 或
working path。`write_data` 复用相同 alias 选择与 request helper，确保 working copy 后只将
`workingPath` 交给 Gateway；Gateway 只收到最终的 `filePath` 等 Capability 参数，不接触别名、内部
resource id 或 working resource 状态。durable `TurnExecutionContext` 仍保持现有的单 active Excel
resource 契约，恢复扩展留待后续变更。

`aggregate_data` 与 `filter_data` 是只读 Application Tools，沿用相同的资源 alias 解析和
`resolveReadablePath()` 路径选择，因此始终分析当前 Session 的 committed Working Resource（或尚未修改时的
source）。聚合结果最多向模型和 Session ToolResult 暴露前 100 行；筛选结果只返回行号范围，最多暴露前
100 个范围。Application details 使用独立的 bounded contract：aggregate 同时记录完整
`resultRowCount`、实际 `returnedRowCount` 和 `truncated`；filter 分别记录匹配行数
`matchedRowCount`、完整 range 数 `totalRangeCount`、实际返回数 `returnedRangeCount` 和
`truncated`。两者均使用 `retry_safe`，且不会创建新 revision；Tool Gateway 的结果仍保持完整语义。

`read_range` 仅接受必填的显式 A1 cell/range，并在调用 Tool Gateway 前限制请求最多 500 个单元格；它通过
`resolveReadablePath()` 读取当前 Session 可见的 source 或 committed Working Resource。Gateway 返回值必须为
矩形且不超过请求上限，否则读取失败，不会截断矩阵。Application details 将复杂 Excel 值投影为 JSON-safe
字符串，并将单个字符串表示限制为 2,000 个字符；details 和模型可见文本都会报告被截断的单元格数。该工具
使用 `retry_safe`，不会创建 revision，适合在分析或筛选后读取少量精确单元格。

当前范围暂不包含动态切换模型或 thinking level、复杂重试、扩展系统和 Session 切换等 Coding Agent 能力。

## 模块布局

应用层按主要业务边界组织：

- `session/`：Session 创建、Runtime projection、history projection 与 Session persistence port。
- `turn/`：Turn execution、recovery、live stream、presentation 与 persistence port。
- `context/`、`tools/`、`system-prompt/`：保持为独立的应用能力模块。
- `resources/excel/`：定义 Session-scoped Excel resource registry 的 source locator port、Turn
  resource context，以及 Excel working resource、atomic mutation 生命周期及持久化 port；不依赖具体
  filesystem adapter，也不改变 Tool Gateway contract。Excel read tools 通过注入的 manager 解析有效路径。
- `Session.registerResource()`：由 `ExecuteTurn` 在收到新 Excel resource 后登记 `id + kind + alias`；
  alias 以 `excel-N` 形式在 Session 内稳定分配并持久化。后续 Turn 从独立 source locator store
  恢复可用 resources，并以内部 `activeResourceId` 作为默认 resource。resource alias 选择与物理路径
  选择仍由各自边界处理。

## Excel working resources

Backend 提供的 Excel source 是 immutable input。Application 的
`ExcelWorkingResourceManager` 以 `sessionId + sourceResourceId` 为稳定身份；读操作返回 source
或当前 committed revision。首次成功 mutation 从 source 创建 revision 1。`executeMutation()`
持有同一 resource 的单进程锁，直到 staging callback、commit 或 abort 完成。Application 使用
`createToolMutationId(turnId, callId)` 生成 durable `mutationId`；长度前缀编码使 identity 稳定且无歧义，
不包含 attempt、工具参数、alias 或物理路径。`ResumeTurn` 继续使用原 Turn ID，因此重放命中相同 receipt；
不同 Turn 的相同 Provider `callId` 则是不同 mutation。Provider `callId` 本身保持原样，用于 ToolResult、
TurnEvent 与 Trace correlation。Working Resource 只接收 opaque `mutationId`，回放时返回 manifest 中的
opaque JSON receipt，不再次调用 callback。旧 PR3 裸 `callId` receipt 仍是合法 opaque string，但新执行不
回退查询裸 `callId`。sourcePath 变更会被拒绝。Staging、revision 文件、manifest 和原子 rename 细节属于
Infrastructure。

Application 的 `write_data` 校验非空矩形 JSON scalar 数据，并只把 staging path 交给 Tool Gateway。
只有 Gateway 成功且 current pointer 提交成功后，工具才返回成功；其 recovery policy 为
`retry_safe`。现有 `TurnRecoveryPlanner` 按 ToolDefinition policy 决定是否重试，`ResumeTurn`
重放原 ToolCall 并沿用原 Turn ID；Working Resource Manager 根据 scoped mutation receipt 保证该重放幂等。
Turn recovery 不增加 Excel 特判，`execution.json` 仍只保存恢复所需的最小输入。

Filesystem adapter 位于 `@opspilot/infrastructure`，使用：

```text
data/workspaces/{sessionId}/resources/{sourceResourceId}/
├── current.json
├── revisions/
│   └── revision-{revision}-{uuid}.xlsx
└── staging/
    └── mutation-{uuid}.xlsx
```

`current.json` 保存 workspace-relative revision 文件、revision 与 bounded mutation receipts；current
pointer 的同目录原子替换是唯一资源 commit point。保留当前与前一 revision；未被 pointer 引用的
staging/candidate 文件在后续 mutation 时安全清理。旧 `working.xlsx + metadata.json` 会在首次读取或
mutation 时保守迁移，revision 0 的实际文件内容也会复制到 versioned revision。Tool Gateway 的
aggregate 与 filter capabilities 由 Application wrapper 复用，Tool Gateway 本身仍只接收最终可读
`filePath`，不会自行选择 source 或 working path。

其中 `turn/presentation/` 提供 live stream 与历史 Turn presentation 共用的工具展示解析能力；`turn/ports/` 与 `session/ports/` 只定义 Application persistence port，不包含 infrastructure 实现。

## Context 边界

Domain `Session` 保存完整会话事实与树 invariant；Application 的 Session runtime adapter 负责在 Domain 的 `SessionMessage` / `SessionThinkingLevel` 与 Agent Runtime 类型之间转换，`buildSessionContext(session)` 将 durable state 投影成 Agent Runtime 输入。`ContextManager` 只决定本次模型调用使用哪些 `AgentMessage`，不依赖或修改 Domain Session。`createAgentSession` 将 ContextManager 接入 Agent Runtime 的 `transformContext` hook，因此经过 ContextManager 的消息只影响当前模型调用，不影响后续 Session 持久化。

Web 历史恢复使用独立的 `buildSessionHistoryProjection()`：它读取
`Session.getBranch()` 的完整 active branch，保留原始 entry 顺序和 id，并输出 UI-safe 的 user / assistant 可见 text 以及 tool execution 的 callId、name、status。它不复用会受 Compaction 影响的 `buildSessionContext()`，也不会把 AgentMessage 的 thinking、provider、model metadata 或 tool raw output 暴露到 UI。

Phase 1 的默认 `DefaultContextManager` 不裁剪消息，只返回输入消息的副本。Context Accounting 仅负责测量上下文用量与判断阈值。

Context Accounting 是独立的纯计算边界：它优先使用最近有效 AssistantMessage 的 `Usage`，再估算其后的新增消息，并通过 `shouldCompact()` 返回是否达到预留 token 阈值。

Phase 3 支持正常 Agent Run 完成后的自动 Compaction：生成摘要并追加 `CompactionEntry`，但不删除原始消息。Compaction 失败时保持本轮结果和原始 Session 可恢复。当前 System Prompt 由 Application 层的 `buildOpsPilotSystemPrompt()` 纯函数构建，并由 runtime composition 注入；Memory、RAG、动态 Prompt 资源加载、工具输出治理和 overflow recovery 不属于当前实现范围。

核心关系：

```text
API / Transport
      │
      ▼
application
      │
      ├── @opspilot/domain Session
      ├── SessionStore port
      │
      ├── Agent configuration
      │
      └── Runtime orchestration
      │
      ▼
@opspilot/domain
      │
      ▼
agent-runtime
      │
      ├── model-gateway
      └── AgentTool
              │
              ▼
         tool-gateway
```

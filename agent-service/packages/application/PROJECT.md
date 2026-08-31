# OpsPilot Application Context Engineering 设计计划

## 1. 目标

为 OpsPilot Application 层建立可持续演进的上下文工程能力，使：

* Session 保存完整、可恢复的会话事实
* LLM Context 与 Session History 解耦
* 长对话可以通过自动 Compaction 持续运行
* ContextManager 保持为单次模型调用的上下文变换入口
* Memory、RAG、Prompt、工具输出治理等能力以后可以独立接入
* `agent-runtime` 保持通用，不感知 Session、Compaction、Memory、RAG 等业务能力

核心原则：

```text
Session History ≠ LLM Context
```

Session 负责保存事实。

Context Engineering 负责决定这些事实如何被模型使用。

---

# 2. 总体架构

上下文工程不实现为一个“大而全”的 ContextManager，而拆分为不同职责：

```text
SessionManager
ContextManager
Context Accounting
CompactionService
PromptBuilder / ResourceLoader
MemoryRetriever        // 后续
RagRetriever           // 后续
Tool Output Policy     // Tool 层负责
```

---

# 3. SessionManager

SessionManager 回答：

> 这次会话实际发生过什么？

职责：

* SessionHeader
* SessionEntry 持久化
* MessageEntry
* ModelChangeEntry
* ThinkingLevelChangeEntry
* Session Tree
* Branch
* Session reload
* 后续支持 CompactionEntry
* 后续支持 BranchSummaryEntry
* 根据当前分支构建 Session Context

原则：

```text
SessionManager 保存完整会话事实。
```

Compaction 不能删除旧 Entry。

即使旧消息以后不再直接进入模型上下文，它们仍应保存在 Session JSONL 中。

---

# 4. ContextManager

ContextManager 回答：

> 这一次模型调用之前，AgentMessage[] 需要做什么临时变换？

当前契约：

```ts
export interface ContextManager {
  prepare(
    input: ContextPrepareInput,
  ): Promise<ContextPrepareResult>;
}

export interface ContextPrepareInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Model;
  readonly systemPrompt?: string;
  readonly tools: readonly AgentTool[];
  readonly signal?: AbortSignal;
}

export interface ContextPrepareResult {
  readonly messages: readonly AgentMessage[];
}
```

ContextManager 通过 Application 接入：

```text
Agent Runtime.transformContext
```

调用顺序：

```text
AgentMessage[]
      ↓
ContextManager.prepare()
      ↓
AgentMessage[]
      ↓
convertToLlm()
      ↓
ModelGateway Context
      ↓
LLM
```

ContextManager：

* 不依赖 SessionManager
* 不写 Session
* 不追加 CompactionEntry
* 不负责 Session Tree
* 不负责自动压缩流程

当前 `DefaultContextManager` 保持 identity 行为：

```ts
return {
  messages: [...input.messages],
};
```

未来 ContextManager 可以逐步承担：

* Memory 注入
* RAG 注入
* 临时业务 Context
* Context 排序
* 特定消息过滤
* 外部上下文组合

但：

```text
ContextManager ≠ CompactionManager
```

---

# 5. Runtime 边界

`agent-runtime` 不依赖 Application 的上下文工程实现。

Runtime 只提供通用 hook：

```ts
transformContext?: (
  messages: readonly AgentMessage[],
  signal?: AbortSignal,
) =>
  readonly AgentMessage[]
  | Promise<readonly AgentMessage[]>;
```

Agent Loop：

```text
完整 Agent State
      ↓
transformContext
      ↓
convertToLlm
      ↓
ModelGateway
```

Runtime 不应该知道：

* SessionManager
* Session JSONL
* CompactionEntry
* CompactionService
* Memory
* RAG
* PromptBuilder
* Application 业务规则

---

# 6. 当前调用链

当前 Application 调用链：

```text
RunConversationTurn
        ↓
SessionStore
        ↓
SessionManager
        ↓
buildSessionContext()
        ↓
createAgentSession()
        ↓
AgentSession
        ↓
Agent Runtime
        ↓
transformContext
        ↓
ContextManager.prepare()
        ↓
convertToLlm()
        ↓
ModelGateway
        ↓
LLM
```

模型产生的新消息：

```text
LLM
 ↓
Agent Runtime
 ↓
message_end
 ↓
AgentSession
 ↓
SessionManager.appendMessage()
 ↓
Session JSONL
```

因此：

```text
Session History
和
本次 LLM Context
已经解耦。
```

---

# 7. Context Accounting

Context Accounting 回答：

> 当前上下文是否已经接近模型窗口，需要触发 Compaction？

它负责“测量”和“判断”，不负责真正执行压缩。

核心能力：

```text
estimateTokens()
calculateContextTokens()
shouldCompact()
CompactionSettings
```

配置：

```ts
export interface CompactionSettings {
  readonly enabled: boolean;
  readonly reserveTokens: number;
  readonly keepRecentTokens: number;
}
```

基本判断：

```text
contextTokens
>
contextWindow - reserveTokens
```

例如：

```text
contextWindow = 128000
reserveTokens = 16000

threshold = 112000
```

当：

```text
contextTokens > 112000
```

应提前触发 Compaction，而不是等真正产生 context overflow 后再处理。

---

# 8. Token Accounting 策略

优先使用最近有效 AssistantMessage 中模型返回的 usage。

如果没有可靠 usage：

```text
使用消息内容进行估算
```

第一版允许使用近似算法，例如：

```text
characters / 4
```

Context Accounting 的目标不是做到 tokenizer 级完全精确，而是提供稳定的安全阈值判断。

以后可以替换为更准确的 provider/model tokenizer。

---

# 9. Compaction

Compaction 回答：

> 历史已经太长，以后应该怎样重新表达过去？

Compaction 与 ContextManager 不同。

ContextManager 是：

```text
单次调用的临时变换
```

Compaction 是：

```text
Session 级持久历史重表达
```

例如原始 Session：

```text
A
↓
B
↓
C
↓
D
↓
E
↓
F
```

当历史达到安全阈值：

```text
A B C D
   ↓
生成 Summary
```

随后 Session 追加：

```text
CompactionEntry
```

原始 Entry 不删除。

---

# 10. CompactionEntry

计划新增：

```ts
export interface CompactionEntry extends SessionEntryBase {
  readonly type: 'compaction';

  readonly summary: string;

  readonly firstKeptEntryId: string;

  readonly tokensBefore: number;
}
```

例如：

```text
summary = A-D 的摘要
firstKeptEntryId = E
```

Session JSONL 中仍然存在：

```text
A
B
C
D
E
F
CompactionEntry
```

但以后：

```text
SessionManager.buildSessionContext()
```

生成：

```text
CompactionSummary(A-D)
E
F
```

因此：

```text
历史事实没有删除，
只是当前 Session Context 的投影方式改变。
```

---

# 11. 自动 Compaction

自动 Compaction 与手动 Compaction 使用相同的 Session 持久化模型。

区别只是触发方式。

手动：

```text
用户主动 compact
```

自动：

```text
Context Accounting
      ↓
达到安全阈值
      ↓
Post-run 或下一次 Prompt 前自动触发 Compaction
```

自动 Compaction 最终同样：

```text
SessionManager.appendCompaction()
```

而不是只在内存中临时裁剪消息。

---

# 12. Auto Compaction 完整流程

```text
Agent Run 完成
        ↓
读取最新 context usage
        ↓
Context Accounting
        ↓
shouldCompact()
       / \
     false true
       │    │
       │    ▼
       │ AgentSession
       │    │
       │    ├─ prepareCompaction()
       │    ├─ 找 safe cut point
       │    ├─ 选择旧历史
       │    └─ 将 prepared messages 交给 CompactionService
       │
       │    ▼
       │ 调用模型生成 Summary
       │
       │    ▼
       │ CompactionSummaryResult
       │
       │    ▼
       │ AgentSession 构造 CompactionResult
       │
       │    ▼
       │ SessionManager.appendCompaction()
       │
       │    ▼
       │ buildSessionContext()
       │
       │    ▼
       │ Summary + Recent Messages
       │
       ▼
      结束
```

下一次 Prompt 提交前会再次检查，避免上一次 aborted/error 等场景遗漏压缩；如果发生压缩，Application 会用新的 `buildSessionContext()` 结果刷新当前 Runtime history。

同一 `AgentSession` 会串行化自身完整的 prompt lifecycle；不同 Session 的并发仍由上层协调器负责。

---

# 13. Safe Cut Point

Compaction 不能直接：

```ts
messages.slice(...)
```

因为消息之间存在结构关系。

例如：

```text
assistant
  toolCall(id=123)
      ↓
toolResult(toolCallId=123)
```

不能从：

```text
toolResult
```

开始保留，否则会形成孤立工具结果。

Cut Point 应优先选择可以独立形成上下文边界的位置，例如：

* user message
* assistant message
* 其他明确安全的消息边界

第一版策略：

```text
从最新历史向前遍历
        ↓
累计消息 token
        ↓
达到 keepRecentTokens
        ↓
继续寻找安全 cut point
        ↓
旧历史进入 Summary
        ↓
最近历史保持原样
```

---

# 14. CompactionService

定义：

```ts
export interface CompactionSummaryInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Model;
  readonly signal?: AbortSignal;
}

export interface CompactionSummaryResult {
  readonly summary: string;
}

export interface CompactionService {
  compact(
    input: CompactionSummaryInput,
  ): Promise<CompactionSummaryResult>;
}
```

CompactionService 负责：

* 接收 `prepareCompaction` 选出的 messages
* 调模型生成 summary
* 返回 `CompactionSummaryResult`

但：

```text
CompactionService 不直接负责 Session persistence
```

Application / AgentSession 负责协调：

```text
CompactionService
      ↓
CompactionSummaryResult
      ↓
AgentSession 构造 CompactionResult
      ↓
SessionManager.appendCompaction()
```

保持计算逻辑和持久化边界分离。

---

# 15. buildSessionContext 的未来职责

当前：

```text
buildSessionContext()
```

主要沿 Session 当前 branch 构造所有有效 message。

支持 Compaction 后，应变成：

```text
读取当前 Branch
      ↓
寻找最新 CompactionEntry
       │
       ├─ 没有
       │    ↓
       │ 返回正常 branch messages
       │
       └─ 有
            ↓
      构造 CompactionSummary
            +
      firstKeptEntryId 之后的消息
```

因此 `buildSessionContext()` 是：

```text
Session Tree
      ↓
当前可运行 Session Projection
```

它不是简单读取所有历史。

---

# 16. Overflow Recovery

Threshold Compaction 是主路径。

另外仍需要处理真正发生的：

```text
context overflow
```

未来可以实现：

```text
Model 返回 context overflow
        ↓
识别 overflow
        ↓
移除本次失败的临时 AssistantMessage
        ↓
自动 Compaction
        ↓
重新构建 Session Context
        ↓
retry once
```

第一版只允许一次恢复重试，防止：

```text
overflow
→ compact
→ retry
→ overflow
→ compact
→ retry
→ ...
```

形成无限循环。

Overflow Recovery 属于后续阶段，不与第一版 Auto Compaction 一起实现。

---

# 17. 工具输出治理

工具输出属于广义 Context Engineering，但不由 ContextManager 或 Compaction 负责。

正确流程：

```text
Tool
 ↓
Raw Result
 ↓
Tool Output Policy
 ↓
truncate / paging / summarize
 ↓
AgentToolResult
 ↓
Session
```

例如 Excel：

```text
读取 10000 行
      ↓
Tool Gateway
      ↓
限制输出大小
      ↓
返回局部数据 / 摘要 / 引用
```

原则：

```text
能在信息源头限制，
就不要等待 Context 层补救。
```

---

# 18. Prompt / Resource Engineering

System Prompt 相关能力独立为：

```text
PromptBuilder
ResourceLoader
```

负责：

* Agent System Prompt
* 项目级上下文
* AGENTS.md
* Skills
* 工具说明
* 工作区资源
* 用户配置

流程：

```text
ResourceLoader
      ↓
PromptBuilder
      ↓
systemPrompt
      ↓
Agent
```

不要让 ContextManager 同时负责：

```text
文件加载
Prompt 拼接
Session
Compaction
```

---

# 19. Memory / RAG

未来 Memory 和 RAG 作为独立 Retriever：

```text
MemoryRetriever
RagRetriever
```

ContextManager 负责将结果注入当前 LLM Context：

```text
Session Context
      +
Memory
      +
RAG
      +
Temporary Context
      ↓
ContextManager
      ↓
本次模型输入
```

最终模型可能看到：

```text
System Prompt
+
Compaction Summary
+
Recent Messages
+
Relevant Memory
+
RAG Results
+
Current User Input
```

Memory / RAG 负责：

```text
找什么
```

ContextManager 负责：

```text
如何放进当前模型上下文
```

---

# 20. 模块职责总结

```text
SessionManager
= 保存“发生过什么”

ContextManager
= 决定“单次模型调用前如何临时变换上下文”

Context Accounting
= 判断“上下文是否接近模型窗口”

CompactionService
= 为已选历史生成 Summary

AgentSession / Application
= 协调自动 Compaction 生命周期

PromptBuilder
= 决定“系统应该告诉模型什么”

MemoryRetriever
= 找值得重新想起的历史信息

RagRetriever
= 找外部知识

convertToLlm
= 将 AgentMessage 翻译为模型协议

Tool Output Policy
= 控制工具从源头产生多少上下文
```

---

# 21. 分阶段实施计划

## Phase 1：ContextManager Boundary ✅

目标：

```text
Session History
与
LLM Context
解耦
```

已完成：

* 新增 `context/`
* ContextManager 契约
* DefaultContextManager
* `createAgentSession()` 接入
* `RunConversationTurn` 注入
* 连接 Runtime `transformContext`
* 测试 ContextManager 变换不会修改 Session History
* 测试新的消息仍正常持久化

当前：

```text
DefaultContextManager
=
identity transform
```

这是预期行为。

---

## Phase 2：Context Accounting ✅

目标：

```text
准确回答：
当前 Session Context 是否需要进行 Compaction？
```

实现：

* `CompactionSettings`
* `estimateTokens()`
* `calculateContextTokens()`
* `estimateContextTokens()`
* `shouldCompact()`

使用：

```text
Model.contextWindow
reserveTokens
Assistant usage
message token estimate
```

基本判断：

```text
contextTokens
>
contextWindow - reserveTokens
```

---

## Phase 3：Auto Compaction ✅

目标：

```text
达到安全阈值后自动压缩旧历史，
并持久化为 Session CompactionEntry。
```

实现：

* CompactionEntry
* CompactionResult
* CompactionService
* prepareCompaction()
* safe cut point
* keepRecentTokens
* summary generation
* SessionManager.appendCompaction()
* compaction-aware `buildSessionContext()`
* Application 自动触发流程

完成后的核心链路：

```text
Context Usage
      ↓
shouldCompact
      ↓
CompactionService
      ↓
Summary
      ↓
CompactionEntry
      ↓
SessionManager
      ↓
Summary + Recent Messages
```

---

## Phase 3.5：Pre-prompt Compaction + Runtime Message Replacement ✅

在下一次 `AgentSession.prompt()` 调用模型之前，Application 会复用同一套 threshold compaction 判断。发生压缩后：

```text
SessionManager.appendCompaction()
        ↓
SessionManager.buildSessionContext()
        ↓
Agent.replaceMessages()
        ↓
Agent.prompt(newUserMessage)
```

`agent-runtime` 只提供通用的空闲态 `replaceMessages()`，不知道 Session 或 Compaction。它不会发送 AgentEvent、调用模型或清空 steering/follow-up 队列。

Pre-prompt compaction 用于兜住上一轮 aborted/error 或 post-run maintenance 未完成的情况。Overflow recovery、`agent.continue()` 和 retry 仍未实现。

---

## Phase 4：Overflow Recovery

实现：

* context overflow detection
* recoverable length detection
* compact after overflow
* rebuild context
* retry once
* 防止无限重试

Threshold Auto Compaction 仍是主路径。

Overflow Recovery 是异常兜底。

---

## Phase 5：Tool Output Governance

在 Tool Gateway / AgentTool Adapter 层实现：

* 最大字符数
* 最大行数
* 最大结果大小
* head / tail 截取策略
* paging
* summary
* full-result reference

重点覆盖：

* Excel 大范围读取
* 搜索
* 文件
* 日志
* 大型结构化结果

---

## Phase 6：Prompt / Resource Engineering

实现：

```text
PromptBuilder
ResourceLoader
```

逐步支持：

* Agent System Prompt
* 项目说明
* AGENTS.md
* Skills
* 工具说明
* 工作区上下文

---

## Phase 7：Memory / RAG

实现：

```text
MemoryRetriever
RagRetriever
```

通过 ContextManager 注入本次模型调用。

ContextManager 在这个阶段才开始承担更丰富的上下文组合策略。

---

# 22. 当前实现范围

当前已经完成：

```text
Phase 1 ✅
ContextManager Boundary

Phase 2 ✅
Context Accounting

Phase 3 ✅
Post-run Auto Compaction

Phase 3.5 ✅
Pre-prompt Compaction + Runtime Message Replacement
```

当前仍未实现：

```text
Phase 4
Overflow Recovery
```

即：

```text
CompactionSettings
      ↓
Token Accounting
      ↓
Context Usage
      ↓
shouldCompact()
```

当前不要：

```text
messages.slice(-N)

不要把超预算处理实现成简单 sliding window

不要让 ContextManager 写 Session

不要让 ContextManager 实现 Compaction

不要提前实现 RAG / Memory

不要把 Compaction 放进 agent-runtime
```

Phase 3.5 完成后，再进入 Phase 4 Overflow Recovery。

---

# 23. 最终目标架构

```text
                         Application
                             │
          ┌──────────────────┼───────────────────┐
          │                  │                   │
          ▼                  ▼                   ▼
   SessionManager      ContextManager      Context Accounting
          │                  │                   │
          │                  │                   ▼
          │                  │             shouldCompact()
          │                  │                   │
          │                  │                   ▼
          │                  │           CompactionService
          │                  │                   │
          │                  │                   ▼
          │                  │       CompactionSummaryResult
          │                  │                   │
          │                  │                   ▼
          │                  │           AgentSession 构造
          │                  │           CompactionResult
          │                  │                   │
          │                  │                   ▼
          └──────────────────┼────────── SessionManager
                             │
                             ▼
                        AgentSession
                             │
                             ▼
                        Agent Runtime
                             │
                      transformContext
                             │
                             ▼
                       ContextManager
                             │
                             ▼
                        convertToLlm
                             │
                             ▼
                        ModelGateway
                             │
                             ▼
                            LLM
```

最终目标：

```text
Session 可以持续保存完整历史，

Compaction 负责把旧历史重新编码为更高密度的信息，

ContextManager 负责单次模型调用的临时上下文组合，

Agent Runtime 始终保持通用和业务无关。
```

核心原则保持：

```text
Session History ≠ LLM Context

ContextManager ≠ Compaction

Auto Compaction = 自动生成并持久化 CompactionEntry
```

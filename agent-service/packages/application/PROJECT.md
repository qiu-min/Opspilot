# OpsPilot Context Engineering 设计计划

## 1. 目标

为 OpsPilot 建立独立的上下文工程能力，使：

* Session 保存完整、可恢复的会话事实
* Context 只表示“本次模型调用实际看到的内容”
* 长对话可以通过 Compaction 持续运行
* Memory、RAG、Prompt、工具输出限制等能力以后可以逐步接入
* `agent-runtime` 保持通用，不感知具体业务上下文策略

核心原则：

```text
Session History ≠ LLM Context
```

Session 负责保存历史。

Context Engineering 负责决定如何使用历史。

---

## 2. 总体架构

上下文工程不设计成一个“大而全”的 ContextManager，而拆成多个独立职责：

```text
SessionManager
ContextManager
CompactionService
PromptBuilder
MemoryRetriever        // 后续
RagRetriever           // 后续
Tool Output Policy     // tool 层负责
```

各模块职责如下。

### SessionManager

负责回答：

> 发生过什么？

职责：

* SessionEntry 持久化
* message 保存
* model change
* thinking level change
* branch
* session tree
* session reload
* 后续支持 compaction entry
* 后续支持 branch summary

SessionManager 保存的是完整会话事实，不负责临时裁剪上下文。

---

### ContextManager

负责回答：

> 这一次 LLM 应该看到什么？

职责：

* 接收完整的 AgentMessage 历史
* 根据当前模型和 Context Budget 做过滤
* 临时裁剪低价值内容
* 后续注入 Memory
* 后续注入 RAG
* 后续处理业务级上下文策略
* 返回本次模型调用所使用的 AgentMessage[]

原则：

```text
ContextManager 默认不修改 Session。
```

ContextManager 是 Application 层对 `agent-runtime.transformContext` 的具体实现。

---

### CompactionService

负责回答：

> 历史已经太长，以后应该怎样重新表达过去？

职责：

* 估算当前上下文 token
* 判断是否需要压缩
* 找合法 cut point
* 保留最近高价值消息
* 对旧历史生成结构化摘要
* 生成 CompactionResult
* 由 Application 调用 SessionManager 保存 CompactionEntry

Compaction 是 Session 级长期状态变化，不是一次性的 Context 裁剪。

---

## 3. Runtime 边界

`agent-runtime` 不依赖 ContextManager。

Runtime 只保留通用 hook：

```ts
transformContext?: (
  messages: AgentMessage[],
  signal?: AbortSignal,
) => Promise<AgentMessage[]>;
```

Agent Loop 调用链：

```text
AgentMessage[]
      ↓
transformContext
      ↓
AgentMessage[]
      ↓
convertToLlm
      ↓
Message[]
      ↓
ModelGateway
      ↓
LLM
```

Runtime 只知道：

> 调模型之前允许上层转换一次 AgentMessage[]。

它不应该知道：

* Session
* RAG
* Memory
* Compaction
* Token Budget
* Application 业务规则

---

## 4. ContextManager 契约

Application 层定义：

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

第一版实现：

```ts
export class DefaultContextManager implements ContextManager {
  async prepare(
    input: ContextPrepareInput,
  ): Promise<ContextPrepareResult> {
    return {
      messages: [...input.messages],
    };
  }
}
```

第一版不实现真正裁剪，只先建立架构边界。

---

## 5. ContextManager 接入流程

`createAgentSession()` 接收：

```ts
contextManager
```

创建 Agent 时：

```ts
new Agent({
  ...

  transformContext: async (messages, signal) => {
    const result = await contextManager.prepare({
      messages,
      model,
      systemPrompt,
      tools,
      signal,
    });

    return [...result.messages];
  },
});
```

因此完整调用链为：

```text
RunConversationTurn
        ↓
SessionManager
        ↓
buildSessionContext()
        ↓
完整 Session History
        ↓
createAgentSession()
        ↓
Agent
        ↓
Agent Loop
        ↓
ContextManager.prepare()
        ↓
本次 LLM Context
        ↓
convertToLlm()
        ↓
ModelGateway
        ↓
LLM
```

---

## 6. Session 与 Context 的关系

SessionManager 保存完整历史：

```text
A
B
C
D
E
F
```

ContextManager 可以临时决定模型只看到：

```text
C
D
E
F
```

但 Session 中依旧保持：

```text
A
B
C
D
E
F
```

因此 ContextManager 的处理不能反向删除 Session 内容。

---

## 7. Compaction 设计

当会话长期增长时，仅依靠临时裁剪不够，需要 Compaction。

新增：

```ts
interface CompactionEntry {
  type: 'compaction';

  summary: string;

  firstKeptEntryId: string;

  tokensBefore: number;
}
```

例如原 Session：

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

压缩后 Session 仍保留这些原始 Entry，同时追加：

```text
CompactionEntry
summary = A~D 的摘要
firstKeptEntryId = E
```

以后 `buildSessionContext()` 不再直接返回：

```text
A B C D E F
```

而返回：

```text
CompactionSummary
E
F
```

原始历史没有丢失，只改变了未来 Context 的投影方式。

---

## 8. CompactionService 契约方向

后续可以定义：

```ts
export interface CompactionService {
  shouldCompact(
    input: CompactionCheckInput,
  ): boolean;

  compact(
    input: CompactionInput,
  ): Promise<CompactionResult>;
}
```

配置：

```ts
export interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}
```

基本判断：

```text
currentContextTokens
>
contextWindow - reserveTokens
```

达到阈值才触发压缩。

---

## 9. Cut Point 规则

Compaction 不能随便从某条消息切断。

例如：

```text
assistant
  toolCall
↓
toolResult
```

不能从 `toolResult` 开始保留，否则模型将看到一个没有对应 ToolCall 的孤立结果。

因此合法 cut point 应优先是：

* user
* assistant
* 其他可以独立形成上下文语义边界的消息

不能直接从 toolResult 中间切。

Cut Point 算法方向：

```text
从最新消息向前遍历
        ↓
累计 token
        ↓
达到 keepRecentTokens
        ↓
寻找最近合法 cut point
        ↓
旧历史进入 summary
        ↓
新历史保持原始消息
```

---

## 10. Compaction 完整流程

```text
Agent Run 完成
      ↓
Context Usage Check
      ↓
shouldCompact()
      ↓
否 → 结束
      ↓
是
      ↓
CompactionService
      ↓
找到 cut point
      ↓
提取旧历史
      ↓
调用模型生成 summary
      ↓
CompactionResult
      ↓
SessionManager.appendCompaction()
      ↓
Session JSONL
```

下一轮：

```text
SessionManager
      ↓
buildSessionContext()
      ↓
读取最新 CompactionEntry
      ↓
CompactionSummary
+
最近未压缩消息
      ↓
Agent
```

---

## 11. 工具输出截断边界

工具输出限制属于广义 Context Engineering，但不由 ContextManager 负责。

正确流程：

```text
Tool
 ↓
execute
 ↓
Raw Result
 ↓
truncate / paging / summarize
 ↓
AgentToolResult
 ↓
Session + Context
```

例如：

```text
Excel Tool
读取 10000 行数据
      ↓
Tool Adapter
      ↓
限制结果大小
      ↓
返回摘要 / 分页结果
```

不要先把巨大结果写进 Session，再等待 ContextManager 清理。

原则：

```text
能在信息源头限制，就不要等到 Context 层补救。
```

---

## 12. System Prompt 边界

System Prompt 同样属于广义上下文工程，但建议独立为：

```text
PromptBuilder
ResourceLoader
```

未来负责：

* Agent 系统指令
* 项目级说明
* AGENTS.md
* 用户配置
* Skills 描述
* 工具相关 Guidelines

最终：

```text
ResourceLoader
      ↓
PromptBuilder
      ↓
systemPrompt
```

再由 Agent 使用。

不要让 ContextManager 同时负责加载文件、拼 Prompt、维护 Session。

---

## 13. Memory / RAG 后续接入方式

未来：

```text
ContextManager.prepare()
        ↓
基础 Session Context
        ↓
MemoryRetriever
        ↓
RagRetriever
        ↓
Context Budget 分配
        ↓
最终 AgentMessage[]
```

可以逐渐形成：

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

ContextManager 负责最后的组合和预算，而 Memory/RAG 各自负责检索。

---

## 14. 最终模块职责总结

```text
SessionManager
= 保存“发生过什么”

ContextManager
= 决定“这次模型看什么”

CompactionService
= 决定“历史太长以后怎么重新表达过去”

PromptBuilder
= 决定“系统应该告诉模型什么”

MemoryRetriever
= 找过去值得重新想起的信息

RagRetriever
= 找外部知识

convertToLlm
= 把 AgentMessage 翻译成模型协议

Tool Output Policy
= 控制工具一开始吐多少内容
```

---

# 15. 分阶段实施计划

## Phase 1：建立 Context 边界

目标：

```text
Session History 与 LLM Context 解耦
```

实现：

* 新增 `context/`
* 定义 ContextManager
* 实现 DefaultContextManager
* `createAgentSession()` 接入
* 连接 `Agent.transformContext`

测试：

* ContextManager 确实被调用
* 修改后的消息进入 ModelGateway
* Session 历史不被修改

完成标准：

```text
SessionManager → AgentSession → ContextManager → Runtime
```

链路跑通。

---

## Phase 2：Context Budget

新增：

* contextWindow
* reserveTokens
* token estimation
* context usage

ContextManager 能判断：

```text
当前 Context 是否接近模型窗口
```

暂时仍可以只做简单最近消息裁剪。

---

## Phase 3：Compaction

新增：

* CompactionEntry
* CompactionSettings
* CompactionService
* shouldCompact()
* findCutPoint()
* summary generation
* appendCompaction()

升级：

```text
SessionManager.buildSessionContext()
```

支持 compaction-aware context projection。

---

## Phase 4：工具输出治理

在 Tool Gateway / AgentTool Adapter 层实现：

* 最大行数
* 最大字符或字节
* 分页
* 结果摘要
* Full Result Reference

重点覆盖：

* Excel 大范围读取
* 搜索结果
* 文件读取
* 日志类输出

---

## Phase 5：Prompt / Resource Engineering

新增：

```text
PromptBuilder
ResourceLoader
```

逐步支持：

* 全局 Agent Prompt
* 项目 Prompt
* AGENTS.md
* Skills
* 工具说明
* 当前工作区信息

---

## Phase 6：Memory / RAG

新增：

```text
MemoryRetriever
RagRetriever
```

由 ContextManager 统一负责将检索结果放进 Context Budget。

---

# 16. 当前最应该实现的范围

目前只实现 Phase 1。

即：

```text
ContextManager 契约
        ↓
DefaultContextManager
        ↓
createAgentSession 接入
        ↓
Agent.transformContext
        ↓
ModelGateway
```

暂时不要实现：

```text
Compaction
Memory
RAG
复杂 Token Budget
PromptBuilder
工具结果摘要
```

先建立正确边界，再逐层增加能力。

---

# 17. 最终目标架构

```text
                     Application
                         │
       ┌─────────────────┼─────────────────┐
       │                 │                 │
       ▼                 ▼                 ▼
SessionManager      ContextManager   CompactionService
       │                 │                 │
       │                 ├── Memory        │
       │                 ├── RAG           │
       │                 └── ContextBudget │
       │                                   │
       └──────────────┬────────────────────┘
                      ▼
                 AgentSession
                      │
                      ▼
                 Agent Runtime
                      │
              transformContext
                      │
                 convertToLlm
                      │
                      ▼
                 ModelGateway
                      │
                      ▼
                     LLM
```

设计目标不是“把 ContextManager 做强大”，而是让不同上下文问题拥有正确的责任边界。

最终形成：

```text
完整历史可以无限增长，
模型每次只看到当前最有价值的一小部分。
```

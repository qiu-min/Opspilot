# OpsPilot Development Instructions

本文件定义整个 OpsPilot 仓库的通用开发规范。

修改代码前，先理解相关模块的职责、现有实现、调用链、测试和文档，再进行修改。

核心原则：

> Correctness > Clarity > Maintainability > Extensibility > Cleverness

优先写容易理解、容易验证、容易修改的代码，而不是复杂或炫技的代码。

---

## 1. Repository Architecture

仓库主要包含：

* `agent-service/`

  * TypeScript / Node.js
  * Agent、Model Gateway、Tool Gateway、RAG、Eval 等 AI 能力。

* `backend/`

  * ASP.NET Core
  * 用户、权限、文件、任务、数据库、缓存、后台任务、Excel 等传统业务能力。

* `web/`

  * Vue 3 + TypeScript
  * 用户交互与 Agent 运行过程展示。

开发前应阅读：

* 根目录 `README.md`
* 当前模块的 `README.md`
* 当前目录或上级目录存在的 `AGENTS.md`
* 修改 `agent-service/` 时，同时阅读 `agent-service/PROJECT.md`

遵守模块边界，不得因为实现方便而跨层复制业务逻辑。

---

## 2. Change Discipline

### 先理解，再修改

不要只阅读目标文件。

修改前应检查：

* 相关类型和接口
* 调用方
* 测试
* 模块 README
* 相关配置

理解数据流和生命周期后再修改。

### 保持改动最小

只修改完成当前任务需要的内容。

除非任务明确要求，否则不要：

* 顺手重构无关代码
* 大范围格式化
* 大规模重命名
* 调整无关目录结构
* 引入新的架构模式

### 保持契约兼容

修改以下内容前，先搜索所有消费者：

* Public API
* Interface
* DTO
* Event
* Shared Type
* Tool Contract
* Service Contract

如果必须改变契约，应同步修改调用方、测试和相关文档。

不得静默改变已有行为。

---

## 3. Code Quality

代码应该：

* 职责清晰
* 命名准确
* 数据流明确
* 副作用可见
* 边界明确
* 容易测试

优先使用 early return，避免不必要的深层嵌套。

函数只承担一个清晰职责，但不要为了缩短函数而机械拆分。

不要创建没有明确价值的：

* Manager
* Helper
* Utils
* Base Class
* Factory
* Interface
* Shared Package

抽象必须来自真实的重复语义，而不是对未来需求的猜测。

只有多个模块确实以相同业务语义消费某个能力时，才考虑抽取公共抽象。

宁可暂时保留少量重复，也不要制造错误抽象。

---

## 4. Naming

名称应表达领域语义。

避免无意义名称：

* `data`
* `info`
* `obj`
* `temp`
* `result2`
* `manager`
* `helper`
* `utils`

优先：

* `toolCall`
* `agentState`
* `modelResponse`
* `executionResult`
* `analysisTask`

布尔变量应表达判断：

* `isRunning`
* `hasToolCalls`
* `shouldTerminate`
* `canRetry`

让代码本身尽可能表达含义，而不是依赖注释解释。

---

## 5. Comments

代码表达 **what**，注释主要解释 **why**。

注释适合说明：

* 非显而易见的设计原因
* 生命周期约束
* 外部 API 的特殊行为
* 边界条件
* 为什么不能采用更简单的实现

不要为显而易见的代码添加注释。

不要强制为每个函数或参数编写注释。

公共 API 在参数、行为或约束不明显时，可以使用 JSDoc / XML Documentation。

---

## 6. Type Safety

不得为了快速通过编译绕过类型系统。

TypeScript：

* 尊重 strict 模式
* 避免 `any`
* 优先 `unknown` + 类型收窄
* 不使用类型断言掩盖真实类型问题

C#：

* 尊重 Nullable Reference Types
* 不使用 `null!` 掩盖设计问题
* 异步代码保持 async 调用链
* 不使用 `.Result` / `.Wait()` 阻塞异步代码

不要因为两个类型字段相似就自动合并它们。

类型是否共享取决于业务语义和边界。

---

## 7. Error Handling

不得吞掉错误。

禁止空 `catch` 或通过返回 `null` 掩盖异常。

错误处理应：

* 保留原始错误原因
* 保留必要的错误来源
* 在正确的架构边界处理
* 区分可恢复与不可恢复错误
* 区分用户错误与内部诊断信息

不得把所有错误转换成一个无法定位来源的普通字符串。

不要在日志中泄漏：

* API Key
* Token
* Secret
* 敏感用户数据

---

## 8. External Input

所有外部输入默认不可信，包括：

* HTTP Request
* LLM Output
* Tool Arguments
* Provider Response
* Environment Variables
* File Content
* Database Data

应在系统边界进行验证。

不得信任未经验证的 LLM Structured Output 或 Tool Arguments。

---

## 9. Async and Side Effects

涉及异步、状态修改或外部副作用时，应考虑：

* Timeout
* Cancellation
* Retry
* Race Condition
* Duplicate Execution
* State Consistency
* Resource Cleanup

不要无条件 Retry。

只有明确属于临时故障且操作允许安全重试时才重试。

具有副作用的操作必须考虑幂等性和重复执行风险。

---

## 10. Tests

行为发生变化时，应检查是否需要增加或修改测试。

重点覆盖：

* Happy Path
* Boundary Condition
* Failure Path
* Regression Case

Bug 修复如果可以自动化复现，应优先：

1. 添加能够复现问题的测试
2. 修复实现
3. 验证回归测试
4. 运行相关测试集

测试应验证行为，而不是过度绑定内部实现。

不要通过修改测试来掩盖真实问题。

---

## 11. Validation

修改完成后必须执行与修改范围匹配的验证。

根据实际项目配置执行适用的：

### TypeScript

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

### .NET

```bash
dotnet build
dotnet test
```

执行前先检查当前项目真实存在的 script 或 solution，不要虚构命令。

不得在存在已知：

* Build Error
* Type Error
* Test Failure
* Lint Error

的情况下声称任务完全完成。

如果由于环境原因无法执行某项验证，应在最终回复中明确说明。

---

## 12. Documentation

发生以下变化时，应检查相关 README / PROJECT 文档是否需要同步：

* Public API
* Architecture Boundary
* Directory Structure
* Configuration
* Environment Variables
* Development Commands
* 对外行为

不要因为内部实现发生变化就机械修改文档。

---

## 13. Keep Diffs Reviewable

修改应尽量容易 Code Review。

不要在同一个任务中混入无关的：

* 全局格式化
* 大规模重命名
* 架构调整
* 文档重写
* 无关重构

不要修改与当前任务无关的文件。

---

## 14. Final Self Review

完成任务前检查：

* 是否真正解决了问题？
* 是否改变了未要求改变的行为？
* 是否破坏已有调用方？
* 是否引入不必要的抽象？
* 命名和职责是否清晰？
* 是否正确处理错误和边界情况？
* 是否存在 null / undefined / race condition 风险？
* 是否存在重复副作用风险？
* 是否需要增加测试？
* 是否需要更新文档？
* 是否执行了相关 build / test / typecheck / lint？

发现明显问题应先修复，再结束任务。

---

## 15. Final Response

完成开发任务后简要说明：

1. 修改了什么
2. 为什么这样设计
3. 主要涉及哪些文件
4. 执行了哪些验证
5. 是否存在未解决的问题或风险

不要只回复“已完成”。

不要声称执行了实际上没有执行的验证。

---

## Core Principle

当存在多种可行实现时：

> 选择最容易被下一位开发者正确理解、修改和验证的实现。

不要为了展示复杂度而增加复杂度。

# Agent Service AGENTS.md

## 1. 项目概述与核心技术栈

`agent-service/` 是基于 TypeScript / Node.js 的服务与包集合。

核心技术栈：

* TypeScript
* Node.js
* pnpm workspace
* Zod
* Vitest
* PostgreSQL / Redis
* Docker

本文件只定义 `agent-service/` 的代码设计与工程规范。

具体模块职责、业务边界和能力归属以：

* `/README.md`
* `agent-service/README.md`
* 各 package `README.md`

为准。

开发具体 package 时，应先阅读对应源码、测试和 README。

---

## 2. 环境搭建与开发/构建指令

使用仓库现有 pnpm workspace 和 TypeScript 配置。

常用命令：

```bash
cd agent-service

pnpm install
pnpm typecheck
pnpm test
pnpm build
```

修改单个 package 时优先使用 workspace filter：

```bash
pnpm --filter <package-name> typecheck
pnpm --filter <package-name> test
pnpm --filter <package-name> build
```

原则：

* 使用 `pnpm`，不要混用 npm / yarn。
* 修改依赖后同步更新 `pnpm-lock.yaml`。
* 不硬编码环境变量、API Key、服务地址或生产配置。
* 不无理由升级核心依赖或修改全局 TypeScript 配置。

---

## 3. 测试规范

行为发生变化时同步检查测试。

重点覆盖：

* Happy Path
* Validation
* Failure Path
* Cancellation
* State Transition
* Boundary Case
* Regression Case

规范：

* Unit Test 关注单个模块的可观察行为。
* 跨 package 契约或真实组合行为使用 Integration Test。
* Bug 修复尽可能增加 Regression Test。
* 外部能力在明确边界处使用 Fake / Stub / Mock。
* 不过度 Mock 内部实现细节。
* 不为了测试机械增加 Interface 或 Wrapper。

完成修改后至少运行受影响 package 的：

```text
typecheck
test
build
```

不得在存在已知 TypeScript、测试或构建错误时声称任务完成。

---

## 4. 代码风格与命名规范

TypeScript 保持严格类型。

原则：

* 避免 `any`，优先使用明确类型或 `unknown` + narrowing。
* 外部输入必须经过运行时校验。
* Zod Schema 与对应 Type 尽量保持单一事实来源。
* 类型和函数命名表达真实语义，避免模糊缩写。
* 保持函数短小、职责单一、控制流清晰。
* 优先使用不可变数据和显式返回值。
* 异步操作使用 `async / await`。
* 可取消操作应传播 `AbortSignal`。
* 不静默吞掉异常。
* 第三方 SDK 和协议类型尽量限制在 Adapter / Boundary 内。
* package 之间通过明确的公开契约通信。
* 避免循环依赖和跨 package 访问内部实现。
* 公共 API 统一从 package 的公开入口导出。
* 不为假设中的未来需求提前制造复杂抽象。

优先：

```text
明确类型
→ 明确边界
→ 小型可组合函数
→ 可测试实现
```

而不是大型 Service 或万能工具类。

---

## 5. 操作边界与绝对禁止事项

### 必须遵守

* 修改前先理解相关 README、调用方和测试。
* 尊重现有 package 边界和依赖方向。
* 修改公共契约时检查所有调用方。
* 外部输入进入系统时进行 Schema Validation。
* 跨边界调用明确处理 Error、Timeout 和 Cancellation。
* 有副作用的操作考虑 Retry 与 Idempotency。
* 架构或模块职责发生变化时同步更新 README。
* 修改范围尽量保持与当前任务一致。
* 函数和类得有注释

### 禁止

* 不在 `AGENTS.md` 中规定具体业务能力属于哪个 package。
* 不绕过 package 公共入口直接依赖内部文件。
* 不制造循环依赖。
* 不使用 `any`、`@ts-ignore` 或关闭严格检查规避类型问题。
* 不吞异常或用模糊错误隐藏真实失败原因。
* 不无条件 Retry 有副作用操作。
* 不提交 API Key、Token、Secret 或生产凭据。
* 不删除或跳过测试来让 CI 通过。
* 不修改与当前任务无关的代码。
* 不进行无关的大规模重构。
* 不复制已有逻辑形成多个事实来源。
* 不为套设计模式机械增加 Adapter、Factory、Interface 或 Layer。

## Core Principle

`AGENTS.md` 定义：

> 代码应该怎么写。

`README.md` 定义：

> package 负责什么，以及业务能力属于哪里。

具体业务边界不要固化在 `AGENTS.md` 中。

存在多种方案时，优先选择：

> 类型安全、依赖清晰、边界明确、容易测试、改动最小的实现。

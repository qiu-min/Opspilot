# OpsPilot AGENTS.md

## 1. 项目概述与核心技术栈

OpsPilot 是一个多服务 Monorepo。

主要目录：

```text
agent-service/
backend/
web/
```

核心技术栈包括：

- TypeScript / Node.js
- C# / .NET / ASP.NET Core
- PostgreSQL
- Redis
- Docker
- pnpm
- xUnit / Vitest

本文件只定义仓库级代码设计与工程规范。

具体模块职责、业务边界和能力归属以：

- `/README.md`
- 各子项目 `README.md`
- 相关架构文档

为准。

进入子项目开发时，应同时遵守该目录下更具体的 `AGENTS.md`。

---

## 2. 环境搭建与开发/构建指令

优先使用仓库已有的脚本、包管理器和配置，不自行引入重复工具链。

### Agent Service

```bash
cd agent-service
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

### Backend

```bash
cd backend
dotnet restore
dotnet build
dotnet test
```

### Infrastructure

```bash
docker compose up -d
```

原则：

- 不硬编码环境相关配置。
- 不提交 Secret、API Key、Token、生产连接字符串。
- 修改依赖后同步更新对应 lockfile。
- 不无理由升级或替换现有核心依赖。
- 不修改与当前任务无关的环境配置。

---

## 3. 测试规范

代码行为发生变化时同步检查测试。

重点覆盖：

- Happy Path
- Validation
- Failure Path
- State Transition
- Boundary Case
- Regression Case

规范：

- 测试关注可观察行为，不绑定无关内部实现。
- Bug 修复尽可能增加 Regression Test。
- 不为了测试机械增加 Interface 或无意义抽象。
- 外部系统优先在明确边界处 Mock / Fake。
- 涉及真实数据库、HTTP、文件或队列行为时使用 Integration Test。

修改完成后运行当前受影响项目的：

```text
typecheck / build / test
```

不得在存在已知编译、类型检查或测试失败时声称任务完成。

---

## 4. 代码风格与命名规范

保持：

- 清晰的依赖方向
- 单一职责
- 明确的模块边界
- 简单的控制流
- 稳定的内部契约
- 可测试性

命名应表达业务或技术意图。

避免：

- 模糊缩写
- God Class / God Service
- 深层嵌套
- Magic String / Magic Number
- 重复逻辑
- 无意义 Wrapper
- 无意义 Interface
- 循环依赖
- 跨层直接访问实现细节

跨模块调用优先通过明确的：

```text
Contract
Port
Adapter
Client
Interface
```

隔离实现细节。

第三方 SDK、数据库驱动和协议类型不要无必要向其他模块泄漏。

异步 IO 应：

- 使用 async / await
- 正确传播 CancellationToken / AbortSignal
- 明确处理 Timeout 和失败

优先实现当前需求所需的最简单方案，不为假设中的未来需求提前构建复杂框架。

---

## 5. 操作边界与绝对禁止事项

### 必须遵守

- 修改前先阅读相关 README、AGENTS、调用方和测试。
- 尊重现有架构和依赖方向。
- 修改公共契约时检查所有调用方。
- 新增依赖前确认现有依赖无法合理解决问题。
- 外部输入默认不可信并进行边界验证。
- 跨服务调用必须明确错误、超时和取消语义。
- 有副作用的操作必须考虑 Retry 与 Idempotency。
- 架构或模块职责发生变化时同步更新 README。

### 禁止

- 不在 `AGENTS.md` 中规定具体业务能力属于哪个模块。
- 不绕过已有抽象直接依赖具体实现。
- 不为了完成局部任务破坏其他模块边界。
- 不修改与当前任务无关的代码。
- 不进行无关的大规模重构。
- 不静默改变公共 API 或跨模块契约。
- 不吞异常或隐藏真实错误原因。
- 不无条件 Retry 有副作用的操作。
- 不提交 Secret、Token、API Key 或生产凭据。
- 不删除测试来让构建通过。
- 不通过 `any`、禁用类型检查或忽略编译错误规避问题。
- 不复制已有能力形成多个事实来源。
- 不为了形式机械套用架构模式。

## Core Principle

`AGENTS.md` 定义：

> 代码应该怎么写。

`README.md` 定义：

> 项目和模块负责什么，以及业务能力属于哪里。

根目录 `AGENTS.md` 负责仓库级通用规范。

子项目 `AGENTS.md` 负责该技术栈下更具体的开发规范。

具体业务边界不要固化在 `AGENTS.md` 中。

当存在多种方案时，优先选择：

> 边界清晰、依赖简单、错误明确、容易测试、改动范围最小的实现。
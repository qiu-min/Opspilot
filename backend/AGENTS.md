# Backend AGENTS.md

## 1. 项目概述与核心技术栈

`backend/` 是基于 ASP.NET Core 的后端服务。

核心技术栈：

- C# / .NET
- ASP.NET Core Web API
- EF Core
- PostgreSQL
- xUnit
- Docker

本文件只定义代码设计与工程规范。

具体模块职责、业务边界和能力归属以 `README.md` 及相关架构文档为准。

开发前优先阅读：

- `/AGENTS.md`
- `/README.md`
- `backend/README.md`
- 当前功能相关代码与测试

---

## 2. 环境搭建与开发/构建指令

保持项目能够通过标准 .NET CLI 构建和测试。

常用命令：

```bash
dotnet restore
dotnet build
dotnet test
```

涉及数据库模型修改时检查：

- EF Core Migration
- Model Snapshot
- 是否产生无关 Schema 变化

环境相关配置不得硬编码，使用：

- `appsettings.json`
- Environment Variables
- `dotnet user-secrets`

连接字符串、密钥、服务地址等敏感配置不得提交到仓库。

---

## 3. 测试规范

代码行为发生变化时必须同步检查测试。

重点覆盖：

- Happy Path
- Validation
- Failure Path
- State Transition
- Regression Case

规范：

- Domain / Application 逻辑优先 Unit Test。
- 数据库、HTTP Pipeline、持久化等真实边界使用 Integration Test。
- Bug 修复应尽可能增加 Regression Test。
- 测试关注可观察行为，不要过度 Mock 内部实现。
- 不要为了测试给所有类机械增加 Interface。

完成修改后运行：

```bash
dotnet build
dotnet test
```

不得在存在已知编译或测试失败时声称任务完成。

---

## 4. 代码风格与命名规范

保持依赖方向清晰：

```text
API
 ↓
Application
 ↓
Domain / Abstractions
 ↑
Infrastructure
```

基本原则：

- Controller / Endpoint 保持轻量。
- Application 负责用例编排，不直接依赖具体基础设施。
- Domain 不依赖 ASP.NET Core、EF Core 或第三方 SDK。
- Infrastructure 实现外部能力和技术细节。
- 第三方 SDK 类型不要向业务层泄漏。
- 优先 Constructor Injection。
- IO 操作保持完整 async 调用链并传播 `CancellationToken`。
- 不使用 `.Result`、`.Wait()` 包装异步代码。
- 命名表达业务或技术意图，避免模糊缩写。
- 类和方法保持单一职责。
- 优先简单实现，不为假设中的未来需求提前设计复杂抽象。
- 不创建没有实际价值的 Repository、Service、Wrapper 或 Interface。

EF Core 查询注意：

- 只读查询考虑 `AsNoTracking()`。
- 尽量在数据库侧完成过滤。
- 只需要部分字段时使用 Projection。
- 避免 N+1。
- 避免无意义 `Include`。
- 避免循环查询数据库。

使用 Structured Logging，不记录：

- Password
- JWT
- API Key
- Secret
- Authorization Header
- 不必要的完整用户数据

---

## 5. 操作边界与绝对禁止事项

### 必须遵守

- 修改前先理解现有调用链和测试。
- 外部系统通过明确的 Adapter / Client / Abstraction 边界访问。
- 外部输入默认不可信并进行必要验证。
- 数据库事务保持尽可能短。
- Retry 仅用于明确的临时故障，并考虑幂等性。
- HTTP DTO、Domain Model、Persistence Entity 根据语义保持边界。
- 修改公共契约时检查所有调用方。

### 禁止

- 不在 `AGENTS.md` 中规定具体业务能力应该放在哪个模块。
- 不在 Controller 中编写复杂业务流程。
- 不在 Domain 中依赖 Infrastructure。
- 不直接将 EF Core Entity 暴露为 HTTP API。
- 不在业务代码中使用 Service Locator 或全局 ServiceProvider。
- 不频繁手动 `new HttpClient()`。
- 不在数据库事务中执行长时间外部调用。
- 不吞异常或无差别将所有异常转换成 `BadRequest`。
- 不无条件 Retry 有副作用的操作。
- 不硬编码生产环境配置和敏感信息。
- 不为了符合架构形式机械增加层级和抽象。
- 不修改与当前任务无关的代码。

## Core Principle

`AGENTS.md` 定义：

> 代码应该怎么写。

`README.md` 定义：

> 模块负责什么，以及业务能力属于哪里。

优先选择依赖清晰、职责单一、边界明确、容易测试的实现。
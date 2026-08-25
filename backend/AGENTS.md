# Backend Development Instructions

本文件定义 `backend/` 下 ASP.NET Core 项目的开发规范。

修改代码前应先阅读：

* `/AGENTS.md`
* `/README.md`
* `backend/README.md`
* 相关调用方、测试和配置

Backend 负责传统业务系统能力，包括 API、用户与权限、数据库、缓存、文件、任务、Excel 处理以及与 `agent-service` 的集成。

Backend 不负责实现 Agent Runtime、Agent Loop 或模型 Provider Adapter。

---

## 1. Architecture

保持清晰的数据流：

```text
API
 ↓
Application
 ↓
Infrastructure
```

如果存在独立 Domain 层，则业务核心不应依赖 ASP.NET Core、EF Core、Redis、HttpClient 等基础设施。

不要为了套 Clean Architecture 模板机械增加层级。

每一层都必须有真实职责。

---

## 2. Controller

Controller 应保持轻量，只负责：

* Request Binding
* Authentication / Authorization
* 调用 Application Service
* HTTP Response Mapping

不要在 Controller 中直接：

* 使用 DbContext 编写业务流程
* 调用 Redis
* 调用 Agent Service
* 处理 Excel
* 编写复杂业务判断

复杂逻辑应进入 Application 或 Infrastructure。

---

## 3. Application

Application 层负责业务用例和流程编排，例如：

* 创建任务
* 上传文件
* 启动 Agent Run
* 获取分析结果
* 取消任务

Application 可以协调数据库、缓存、Agent Service 和文件服务，但不要直接处理具体 HTTP、Redis、EF Core 或 ClosedXML 协议细节。

---

## 4. Infrastructure

Infrastructure 负责具体技术实现，例如：

* EF Core / PostgreSQL
* Redis
* HttpClient
* File Storage
* ClosedXML
* Agent Service Client

Infrastructure 不应成为业务规则的容器。

---

## 5. DTO and Entity

不要直接将 EF Core Entity 暴露给 HTTP API。

保持：

```text
Request DTO
    ↓
Application
    ↓
Entity

Entity
    ↓
Response DTO
```

不要因为两个类型字段一样就自动复用。

类型是否共享取决于业务语义和边界。

---

## 6. Dependency Injection

依赖通过 ASP.NET Core DI 管理。

优先 Constructor Injection。

不要：

* 使用全局 ServiceProvider
* 在 Controller 中手动创建 Service
* 在业务代码中频繁 `new HttpClient()`
* 让 Singleton 持有 Scoped Service

`DbContext` 通常保持 Scoped 生命周期。

---

## 7. Async and Cancellation

IO 操作保持完整 async 调用链。

禁止：

```csharp
.Result
.Wait()
```

不要用 `Task.Run()` 包装普通异步 IO。

以下操作应尽可能传播 `CancellationToken`：

* Database
* HTTP
* Agent Service
* File IO
* Excel Processing

---

## 8. EF Core

查询时注意：

* 只读查询优先考虑 `AsNoTracking()`
* 能在数据库过滤就不要加载后在内存过滤
* 只需要部分字段时使用 Projection
* 避免 N+1
* 不要无脑 `Include`
* 不要在循环中重复查询数据库

不要为了形式给每个 Entity 创建无意义 Repository。

抽象必须提供真实价值。

---

## 9. Transactions

事务围绕真实业务一致性边界。

不要在数据库事务中执行长时间外部调用，例如：

```text
Begin Transaction
    ↓
Call Agent Service
    ↓
等待几十秒
    ↓
Commit
```

数据库事务应尽可能短。

跨数据库与外部服务的流程要明确处理中间状态和失败情况。

---

## 10. Error Handling

不要在每个 Controller 中重复 `try/catch`。

优先使用统一异常处理机制，例如：

* `IExceptionHandler`
* Exception Middleware
* ProblemDetails

不要：

```csharp
catch (Exception ex)
{
    return BadRequest(ex.Message);
}
```

应区分：

* Validation Error
* Authentication / Authorization Error
* Not Found
* Conflict
* Business Error
* Infrastructure Error
* Agent Service Error
* Unexpected Error

不要吞掉原始异常原因。

---

## 11. Authentication and Authorization

Authentication 解决：

> 用户是谁。

Authorization 解决：

> 用户能不能访问这个资源。

不要只检查：

```text
资源是否存在
```

还要检查：

```text
资源是否属于当前用户或授权范围
```

尤其注意：

* File
* AnalysisTask
* AgentRun

避免 IDOR 类型权限漏洞。

---

## 12. Agent Service Integration

Backend 调用 `agent-service` 必须经过明确客户端边界：

```text
Application
    ↓
IAgentServiceClient
    ↓
Infrastructure AgentServiceClient
    ↓
HTTP / SSE
    ↓
agent-service
```

不要在 Controller 或业务 Service 中到处手写：

```csharp
httpClient.PostAsync(...)
```

Agent Service 的：

* Base URL
* Serialization
* Timeout
* Error Mapping
* Streaming Protocol

应集中在 Client 内处理。

必须区分：

```text
Agent Run 执行失败
```

和：

```text
Agent Service 网络 / HTTP / Infrastructure 失败
```

两者不是同一种错误。

---

## 13. Excel Boundary

Excel 处理属于 Backend。

推荐调用关系：

```text
Agent
 ↓
Tool Call
 ↓
Backend Internal API
 ↓
Excel Service
 ↓
ClosedXML
```

`agent-service` 不应直接依赖 ClosedXML。

不要将：

* Worksheet
* Cell
* ClosedXML 类型

暴露到跨服务契约。

跨服务使用稳定 DTO。

---

## 14. External Input

所有外部输入默认不可信，包括：

* HTTP Request
* Uploaded File
* Agent Service Response
* Environment Variables
* External API Response

文件上传至少考虑：

* Size
* Extension / Format
* File Name
* Path Traversal
* Malformed Content

不要直接使用用户提供的文件名作为服务器存储路径。

---

## 15. Retry and Idempotency

不要无条件 Retry。

只有明确属于临时故障并且操作可以安全重试时才 Retry。

特别注意：

* 创建 Agent Run
* 启动分析任务
* Tool Execution
* 文件处理

必须考虑重复请求是否会产生重复副作用。

必要时使用：

* Unique Constraint
* Operation Id
* Idempotency Key
* State Check

---

## 16. Logging

优先 Structured Logging。

例如：

```csharp
logger.LogInformation(
    "Starting analysis task {TaskId} for user {UserId}",
    taskId,
    userId);
```

不要记录：

* Password
* JWT
* API Key
* Secret
* Authorization Header
* 不必要的完整用户内容

跨服务调用尽可能保留：

* TraceId
* RequestId
* AnalysisTaskId
* AgentRunId

---

## 17. Configuration

以下内容不得硬编码：

* Connection String
* Redis Address
* Agent Service URL
* API Key
* Production Path

使用：

* `appsettings.json`
* Environment Variables
* Secret Store
* `dotnet user-secrets`

关键配置缺失时应尽可能 Fail Fast。

---

## 18. Testing

行为发生变化时检查测试。

重点覆盖：

* Happy Path
* Validation
* Authorization
* Failure Path
* State Transition
* Regression Case

涉及真实基础设施行为时，适当使用 Integration Test。

不要通过大量 Mock 把内部所有类彼此隔离。

测试应关注业务行为。

---

## 19. Validation

完成 Backend 修改后，根据项目实际结构运行：

```bash
dotnet build
dotnet test
```

如果没有测试项目，不要虚构测试结果。

修改 EF Core Model 时检查：

* Migration
* Model Snapshot
* 是否产生无关 Schema 修改

不得在存在已知编译或测试失败时声称任务完全完成。

---

## 20. Before Finishing

完成前检查：

* Controller 是否保持轻量？
* 业务逻辑是否位于正确层？
* Infrastructure 是否泄漏到业务层？
* Entity 是否直接暴露给 API？
* async / CancellationToken 是否正确？
* 是否存在 N+1 或长事务？
* Agent Service 是否经过统一 Client？
* Retry 是否可能造成重复副作用？
* Authorization 是否验证资源归属？
* 是否泄漏敏感数据？
* 是否需要 Migration / Test / README 更新？
* 是否运行 build / test？

---

## Core Principle

Backend 负责：

> Business System

Agent Service 负责：

> Agent Mechanism

两边通过稳定契约通信，不要因为调用方便逐渐互相侵入。

当存在多种实现方案时，优先选择：

> 数据流清晰、错误边界明确、容易测试、耦合更低的实现。

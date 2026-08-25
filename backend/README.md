# OpsPilot Backend

OpsPilot Backend 是负责用户、权限、文件和 Excel 处理等产品能力的 ASP.NET Core 后端。本目录当前已包含 .NET 10 基础启动骨架，但尚未加入具体业务实现或基础设施。

当前骨架提供：

- Controller API 管道和开发环境 OpenAPI
- `GET /health` 基础进程健康检查
- 基于 `IExceptionHandler` 和 `ProblemDetails` 的统一未预期异常处理
- Application 与 Infrastructure 的统一 DI 注册入口

## Development

```powershell
cd backend
dotnet restore
dotnet build
dotnet test
dotnet run --project src/OpsPilot.Api
```

数据库、缓存、认证授权、文件处理和 Agent Service 集成将在对应功能具备真实需求后加入。

## Technology

- ASP.NET Core
- EF Core
- PostgreSQL
- Redis
- JWT / RBAC
- BackgroundService
- HttpClient
- SignalR / SSE
- ClosedXML / Open XML SDK
- OpenTelemetry

## Responsibilities

- 用户管理、身份认证和权限控制
- 文件上传与下载、Excel 文件管理
- AnalysisTask、AgentRun 业务记录和数据库持久化
- Redis 与后台任务
- Agent Service 调用
- Internal Tool API 与 Excel Processing

Backend 负责传统业务和 Excel 基础设施，不负责实现 Agent Loop。

## Integration boundaries

```text
Web
 ↓ HTTP
Backend
 ├─→ Agent Service       # 启动和管理 Agent Run
 └─← Agent Service Tool  # 提供 Excel 等业务 Tool 的 Internal API
```

Backend 是 Web 和 Agent Service 之间的传统业务边界；Agent Service 不直接访问 EF Core、ClosedXML 或 Backend 的数据库基础设施。

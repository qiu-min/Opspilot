# OpsPilot Backend

未来的传统业务后端，负责用户、权限、文件和 Excel 处理等产品能力；本目录当前只作为架构占位，不包含 ASP.NET Core Solution 或业务实现。

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

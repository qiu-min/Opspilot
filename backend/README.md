# OpsPilot Backend

`backend/` 是 OpsPilot 的 ASP.NET Core 业务后端。

它负责面向 Web 的业务 API、业务数据持久化、文件资产管理以及与其他服务之间的业务流程协调。

Excel 工作簿的读取、修改等具体文件处理能力不在 Backend 中实现，由 Agent Service 的 Tool Gateway 提供。

---

## Responsibilities

Backend 主要负责：

* 对外 HTTP API
* 业务用例与状态管理
* PostgreSQL 数据持久化
* 文件上传、存储与文件资产管理
* User / FileAsset / Conversation 等业务记录
* 身份认证与权限控制
* 与 Agent Service 的跨服务协作
* 后续需要的缓存、任务调度和实时通信能力

Backend 负责管理“文件这个业务资源”，但不负责理解和操作 Excel Workbook 内容。

例如：

```text
Backend
  ↓
FileAsset
  ↓
文件存储

Agent Service
  ↓
Tool Gateway
  ↓
ExcelJS
  ↓
Excel Workbook 操作
```

---

## Architecture

Backend 使用分层结构：

```text
API
 ↓
Application
 ↓
Domain / Abstractions
 ↑
Infrastructure
```

### API

负责：

* HTTP Endpoint / Controller
* Request Binding
* Authentication / Authorization
* Response Mapping
* ProblemDetails

API 层保持轻量，不直接实现业务流程或基础设施逻辑。

### Application

负责：

* 业务 Use Case
* 流程编排
* 调用 Domain
* 通过抽象访问持久化、文件存储和外部服务

### Domain

负责：

* 核心业务实体
* 状态
* 业务不变量

Domain 不依赖 ASP.NET Core、EF Core 或其他基础设施。

### Infrastructure

负责具体技术实现，例如：

* EF Core
* PostgreSQL
* File Storage
* External Service Client
* 其他基础设施 Adapter

具体工程规范见：

```text
backend/AGENTS.md
```

---

## Current Capabilities

当前 Backend 已实现：

* ASP.NET Core API 基础启动
* `GET /health`
* `POST /api/auth/register`
* `POST /api/auth/login` with JWT Bearer authentication
* `ProblemDetails` 统一异常响应
* Application / Infrastructure DI 注册
* EF Core + PostgreSQL
* User / FileAsset / Conversation 持久化
* EF Core Migration
* 上传 `.xlsx` 文件的 Vertical Slice
* 通过 `FileAsset.UserId` 隔离用户文件归属
* `POST /api/conversations` 创建当前用户的 Conversation
* `GET /api/conversations` 列出当前用户的 Conversation
* 通过 Agent Service 执行普通 Conversation Turn

用户注册的最小调用链为：

```text
POST /api/auth/register
  ↓
RegisterUserHandler
  ↓
IUserRepository
  ↓
User.Create(...)
  ↓
PostgreSQL
```

当前主要业务链路：

```text
Client
  ↓
POST /api/auth/register
  ↓
User
  ↓
POST /api/files
  ↓
JwtBearer → ICurrentUser → FileAsset.UserId
  ↓
POST /api/conversations
  ↓
Conversation
  ↓
GET /api/conversations
```

普通 Conversation Turn 的最小调用链为：

```text
POST /api/conversations/{conversationId}/turns
  ↓
RunConversationTurnHandler
  ↓
Load Conversation by current user
  ↓
Conversation.AgentSessionId
  ↓
FileId → FileAsset.StoragePath
  ↓
AgentServiceClient
  ↓
POST Agent Service /conversations/turns
```

客户端只认识 `ConversationId`。`SessionId` 是 Backend 与 Agent Service
之间的内部实现细节：第一次 Turn 创建并绑定 Session，后续 Turn 复用并确认该 Session。

---

## File Management

Backend 负责文件作为业务资产的生命周期。

当前上传接口：

```http
POST /api/files
Content-Type: multipart/form-data
```

表单字段：

```text
file
```

当前仅接受 `.xlsx` 文件。

上传后 Backend：

```text
Upload
  ↓
Validate
  ↓
ICurrentUser.UserId
  ↓
File Storage
  ↓
FileAsset
  ↓
PostgreSQL
```

对外返回稳定的文件资源标识：

```text
FileId
```

而不是暴露：

* 服务器物理路径
* 内部存储文件名
* Infrastructure 实现细节

`FileId` 可以继续用于 Conversation 或跨服务文件访问。

文件上传和带 `fileId` 的 Conversation 请求都要求 JWT Bearer 认证，并且只允许
当前用户访问自己拥有的 `FileAsset`。不存在或不属于当前用户的文件统一返回 404。

### File Boundary

Backend 负责：

```text
文件上传
文件存储
文件 Metadata
FileAsset
文件访问权限
文件生命周期
```

Backend 不负责：

```text
Workbook 解析
Worksheet 操作
Cell / Range 操作
公式和样式处理
ExcelJS
```

Excel 内容处理由 Agent Service 的 Tool Gateway 提供。

---

## Agent Service Integration

Backend 与 Agent Service 是两个独立进程。

整体关系：

```text
Web
 ↓
Backend
 ↓
Agent Service
```

Backend 负责业务请求和业务状态。

Agent Service 负责 Agent 执行。

跨服务通信应通过稳定契约，例如：

```text
HTTP
Message Queue
Event
```

而不是直接访问对方内部代码或数据库。

后续典型流程：

```text
User Request
     ↓
Backend
     ↓
Conversation
     ↓
Agent Service
     ↓
Agent Execution
```

Agent Service 执行期间需要使用具体工具能力时，由 Agent Service 自己的 Tool Gateway 负责。

当前 Backend 仅代理非流式 Conversation Turn；SSE 代理仍待后续实现。

---

## Persistence

Backend 当前使用：

```text
EF Core
   ↓
Npgsql
   ↓
PostgreSQL
```

主要持久化模型包括：

```text
User
FileAsset
Conversation
```

数据库模型变化通过 EF Core Migration 管理。

`AddFileAssetOwnership` 为 `file_assets` 增加必填 `user_id`。已有旧文件没有可推断的
用户归属，迁移会明确终止；开发环境应重建数据库，或在迁移前显式完成数据回填。

开发环境更新数据库：

```bash
dotnet ef database update \
  --project src/OpsPilot.Infrastructure \
  --startup-project src/OpsPilot.Api
```

---

## Project Structure

```text
backend/
├── src/
│   ├── OpsPilot.Api/
│   ├── OpsPilot.Application/
│   ├── OpsPilot.Domain/
│   └── OpsPilot.Infrastructure/
├── tests/
│   ├── OpsPilot.UnitTests/
│   └── OpsPilot.IntegrationTests/
├── AGENTS.md
└── README.md
```

具体 Feature 的代码尽量围绕业务能力组织，而不是把所有 Request、Handler 或 DTO 堆积到全局目录。

---

## Development

安装依赖：

```bash
cd backend
dotnet restore
```

构建：

```bash
dotnet build
```

测试：

```bash
dotnet test
```

启动 API：

```bash
dotnet run --project src/OpsPilot.Api
```

启动本地 PostgreSQL：

```bash
docker compose up -d postgres
```

然后执行 Migration：

```bash
dotnet ef database update \
  --project src/OpsPilot.Infrastructure \
  --startup-project src/OpsPilot.Api
```

具体配置以：

```text
src/OpsPilot.Api/appsettings*.json
```

及环境变量为准。

---

## Service Boundary

Backend 解决的是：

> OpsPilot 的业务系统如何管理用户请求、业务状态和持久化资源。

Agent Service 解决的是：

> Agent 如何运行、调用模型并执行工具。

Tool Gateway 解决的是：

> Agent 如何访问具体可执行能力。

因此：

```text
Backend
   ↓
业务资源与业务状态

Agent Service
   ↓
Agent 执行

Tool Gateway
   ↓
具体工具能力
```

这些边界应通过稳定契约连接，而不是为了调用方便逐渐混合实现细节。

---

## Related Documentation

* [OpsPilot README](../README.md)
* [Backend Development Rules](AGENTS.md)
* [Agent Service](../agent-service/README.md)
* [Tool Gateway](../agent-service/packages/tool-gateway/README.md)

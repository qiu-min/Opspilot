# OpsPilot

OpsPilot 是一个 AI Agent 驱动的数据处理平台。当前仓库先保留已有的 TypeScript Agent 基础设施，并为后续 ASP.NET Core 业务后端和 Vue 3 前端预留清晰边界。

## Repository structure

```text
OpsPilot/
├── agent-service/       # TypeScript / Node.js Agent Service
├── backend/             # 未来的 ASP.NET Core 业务后端
├── web/                 # 未来的 Vue 3 + TypeScript 前端
└── docker-compose.yml   # 产品级 PostgreSQL / Redis 编排
```

### agent-service

`agent-service/` 负责通用 Agent 能力：

- Model Gateway、Agent Runtime、Agent Loop 和 Agent Lifecycle
- Tool Calling、Tool Gateway、Streaming Events 和 Agent State
- Observability，以及后续的 RAG 和 Eval 能力

它不直接承担用户、文件、权限、Excel 持久化等传统业务职责。详细的 Agent 架构、包说明和当前演示命令见 [agent-service/README.md](agent-service/README.md)，项目计划见 [agent-service/PROJECT.md](agent-service/PROJECT.md)。

### backend

未来使用 ASP.NET Core，负责 User、Auth、RBAC、File、AnalysisTask、AgentRun、PostgreSQL、Redis、后台任务、Excel Processing、ClosedXML / Open XML SDK、Agent Service Client 和 Internal Tool API。

Backend 负责传统业务和 Excel 基础设施，不负责实现 Agent Loop。当前仅有架构占位说明，见 [backend/README.md](backend/README.md)。

### web

未来使用 Vue 3 + TypeScript，负责文件上传、自然语言分析请求、Agent 实时进度、分析结果和结果文件下载。当前仅有架构占位说明，见 [web/README.md](web/README.md)。

## Target call flow

```text
Web
 ↓ HTTP
ASP.NET Core Backend
 ↓ HTTP
Agent Service
 ↓
Agent Runtime
 ↓
Tool Gateway
 ↓ HTTP
ASP.NET Core Internal Tool API
 ↓
Excel Service
 ↓
ClosedXML / Open XML SDK
 ↓
.xlsx
```

Backend → Agent Service 用于启动 Agent Run；Agent Service → Backend Internal Tool API 用于执行 Excel 等业务 Tool。

## Current development

当前可运行的 Agent Workspace 位于 `agent-service/`：

```powershell
cd agent-service
pnpm install
Copy-Item .env.example .env
pnpm build
pnpm test
pnpm typecheck
```

PostgreSQL 和 Redis 由仓库根目录的 `docker-compose.yml` 提供：

```powershell
docker compose up -d
```

本次目录重构没有初始化 ASP.NET Core 或 Vue 项目，也没有新增 backend/web 容器。

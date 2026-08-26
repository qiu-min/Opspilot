# OpsPilot

OpsPilot 是一个 AI Agent 驱动的数据分析与处理平台。

项目采用多服务架构，将传统业务系统、Agent 执行环境和 Web 客户端分离，使各部分能够独立开发、测试和演进。

## Repository Structure

```text
OpsPilot/
├── agent-service/       # TypeScript / Node.js Agent Service
├── backend/             # ASP.NET Core Backend
├── web/                 # Web Frontend
├── docker-compose.yml   # Local infrastructure
├── AGENTS.md            # Repository-wide development rules
└── README.md
```

各子项目的架构、模块职责和开发方式由其自身 README 说明。

* [Agent Service](agent-service/README.md)
* [Backend](backend/README.md)
* [Web](web/README.md)

## Architecture

OpsPilot 主要由三个独立进程组成：

```text
┌───────────────┐
│      Web      │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│    Backend    │
│ ASP.NET Core  │
└───────┬───────┘
        │
        ▼
┌───────────────┐
│ Agent Service │
│  TypeScript   │
└───────────────┘
```

服务之间通过稳定的 API、消息或其他明确契约进行通信。

具体业务边界和内部模块设计不在根 README 中展开，请查看对应子项目文档。

## Tech Stack

### Agent Service

* TypeScript
* Node.js
* pnpm

### Backend

* C#
* ASP.NET Core
* EF Core

### Web

* TypeScript
* Vue

### Infrastructure

* PostgreSQL
* Redis
* Docker

## Development

### Infrastructure

在仓库根目录启动本地基础设施：

```bash
docker compose up -d
```

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

具体环境配置和运行方式以各子项目 README 为准。

## Documentation

仓库级文档只描述 OpsPilot 的整体结构。

详细设计应放在距离代码最近的位置：

```text
README.md
    ↓
整体项目

agent-service/README.md
backend/README.md
web/README.md
    ↓
子项目架构与职责

package / module README
    ↓
具体模块设计与边界
```

开发规范：

* 根目录 `AGENTS.md`：仓库级通用开发规范
* 子项目 `AGENTS.md`：对应技术栈和工程规范
* `README.md`：描述项目、模块职责和架构边界

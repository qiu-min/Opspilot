# OpsPilot Agent Service

`agent-service/` 是 OpsPilot 的 TypeScript / Node.js Agent 执行服务。

它提供模型访问、Agent Runtime、Tool 执行与外部能力集成等 Agent 侧基础能力，并通过稳定契约与 OpsPilot 的其他服务协作。

具体 package 的实现细节和内部设计由各 package README 说明。

---

## Responsibilities

Agent Service 主要负责：

* 统一模型访问与 Provider 适配
* Agent 生命周期与 Agent Loop
* Agent State、Context 与消息处理
* Tool Calling 与 Tool Execution
* 外部能力和业务工具集成
* Streaming 与生命周期事件
* Cancellation 与错误传播
* Agent 侧 Observability
* Agent 执行入口与运行环境

Agent Service 不承担 Web UI 或传统 ASP.NET Core 业务后端职责。

跨进程职责以仓库根目录及对应子项目 README 为准。

---

## Architecture

整体结构：

```text
External Request / Task
          ↓
     Agent Service
          ↓
    Agent Runtime
      ↙       ↘
Model Gateway  Tools
                 ↓
            Tool Gateway
                 ↓
        External Capability
```

核心原则：

* Agent Runtime 不感知具体模型 Provider。
* Agent Runtime 不包含具体业务 Tool 的实现。
* Model Provider 差异由模型访问边界吸收。
* 外部能力通过 Tool 边界接入 Agent。
* package 之间通过明确的公开契约协作。

---

## Packages

```text
agent-service/
├── apps/
├── packages/
│   ├── model-gateway/
│   ├── agent-runtime/
│   ├── tool-gateway/
│   ├── observability/
│   ├── application/
│   ├── domain/
│   ├── db/
│   └── shared/
├── config/
├── docs/
├── AGENTS.md
├── PROJECT.md
└── README.md
```

### model-gateway

统一不同模型 Provider 的访问方式，为上层提供稳定的模型调用、消息、Tool Declaration、Streaming 和错误契约。

详细设计见：

```text
packages/model-gateway/README.md
```

### agent-runtime

提供通用 Agent 运行机制，包括生命周期、Agent Loop、State、Context、Tool Execution 和运行事件。

它保持领域无关，不直接实现具体业务能力。

详细设计见：

```text
packages/agent-runtime/README.md
```

### tool-gateway

负责 Agent 可调用能力与具体外部能力之间的执行边界，包括契约、输入验证、Connector / Adapter 和具体工具能力实现。

Excel 文件操作属于 Agent Service 的 Tool 能力之一，具体实现放在 Tool Gateway 边界内，并使用 ExcelJS 处理 `.xlsx` 文件。

Tool Gateway 的详细职责、Excel 能力和契约设计见：

```text
packages/tool-gateway/README.md
```

### observability

提供 Agent Service 的日志、Trace 和可观测性相关基础能力。

具体实现以 package README 和源码为准。

### Other Packages

`application`、`domain`、`db`、`shared` 等 package 为 Agent Service 内现有应用与基础代码。

其具体职责由对应 package 和项目文档定义，不在本 README 中展开。

---

## Service Boundary

OpsPilot 的主要进程关系：

```text
Web
 ↓
Backend
 ↓
Agent Service
```

Backend 与 Agent Service 是独立进程，通过稳定的 API、消息或其他明确契约通信。

Agent Service 内部需要使用文件、数据库或其他外部资源时，也应通过明确边界访问，而不是跨进程直接依赖其他项目的内部实现。

具体跨服务契约由相关功能文档定义。

---

## Tool Integration

Agent Runtime 使用统一 Tool Contract 调用工具：

```text
Model Tool Call
      ↓
Agent Runtime
      ↓
Agent Tool
      ↓
Tool Gateway
      ↓
Connector / Adapter
      ↓
External Capability
```

具体 Tool 的业务语义和实现不进入 Agent Runtime。

例如 Excel 能力：

```text
Agent Tool
    ↓
Tool Gateway
    ↓
ExcelJS
    ↓
.xlsx
```

更细的 Excel Tool 契约、文件解析和 Workbook 操作方式由 `tool-gateway` 文档维护。

---

## Development

安装依赖：

```bash
cd agent-service
pnpm install
```

常用验证命令：

```bash
pnpm typecheck
pnpm test
pnpm build
```

启动仓库级基础设施：

```bash
docker compose -f ../docker-compose.yml up -d
```

开发具体 package 时可以使用：

```bash
pnpm --filter <package-name> typecheck
pnpm --filter <package-name> test
pnpm --filter <package-name> build
```

具体启动方式、环境变量和 package 开发命令以对应 README 和 `package.json` 为准。

---

## Documentation

文档按层级维护：

```text
/README.md
    ↓
OpsPilot 整体架构

agent-service/README.md
    ↓
Agent Service 进程级架构

packages/*/README.md
    ↓
具体 package 职责与边界

源码 / 测试
    ↓
具体实现
```

相关文档：

* [OpsPilot README](../README.md)
* [Agent Service Project](PROJECT.md)
* [Model Gateway](packages/model-gateway/README.md)
* [Agent Runtime](packages/agent-runtime/README.md)
* [Tool Gateway](packages/tool-gateway/README.md)

历史 Demo 和已经废弃的设计应放入 `docs/legacy/`，避免与当前架构说明混合。

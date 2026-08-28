# @opspilot/application

OpsPilot Agent Service 的应用层。

`application` 位于业务入口与通用 Agent Runtime 之间，负责围绕 Session 组织 Agent 的实际使用流程，并协调运行时、会话状态、工具与持久化能力。

## 职责

本包主要负责：

- 创建、恢复和管理 Agent Session
- 接收用户输入并驱动一次 Agent Run
- 将 Session 上下文恢复到 Agent Runtime
- 监听 Agent Runtime 产生的消息与执行事件
- 将完成的消息、工具结果等写入 Session
- 组织 Session 的创建、继续、切换与后续扩展能力
- 组合具体 Agent 所需的模型配置、System Prompt 与工具
- 向上层 API 提供稳定的应用用例接口

核心关系：

```text
API / Transport
      │
      ▼
 application
      │
      ├── Session
      │
      ├── Agent configuration
      │
      └── Runtime orchestration
      │
      ▼
 agent-runtime
      │
      ├── model-gateway
      └── AgentTool
              │
              ▼
         tool-gateway
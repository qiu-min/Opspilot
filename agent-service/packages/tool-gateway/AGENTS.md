# 1. 项目概述与核心技术栈

`@opspilot/tool-gateway` 是 Agent Service 中封装外部可执行能力的基础设施层。

核心技术栈：

* TypeScript
* Node.js
* Zod
* ExcelJS
* Vitest
* pnpm workspace

主要职责：

* 定义稳定的 Capability Contract
* 对外部输入进行运行时校验
* 通过 Connector / Adapter 隔离具体第三方实现
* 提供明确、可处理的错误语义
* 沉淀 Capability 间可复用的基础工具到 `shared/`

# 2. 环境搭建与开发 / 构建指令

在 `agent-service` 目录执行：

```bash
pnpm install
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

提交代码前必须确保：

```bash
pnpm --filter @opspilot/tool-gateway typecheck
pnpm --filter @opspilot/tool-gateway test
pnpm --filter @opspilot/tool-gateway build
```

全部通过。

# 3. 测试规范

* 每个 Capability 的测试必须放在对应目录中。
* 测试目录应与 `src/` 中的 Capability 结构保持对应。
* 新增或修改 Capability 时必须同步补充测试。
* 至少覆盖：

  * 正常路径
  * 输入校验
  * 边界值
  * 明确失败路径
  * 取消行为
  * 已修复问题的回归场景
* 优先测试公开行为和 Contract，不依赖内部实现细节。
* 涉及真实文件处理时使用临时文件和独立测试数据，不依赖开发机上的固定文件。
* 测试之间不得共享可变状态。
* 不得为了让测试通过而削弱生产代码中的校验和错误处理。

# 4. 代码风格与命名规范

* 使用 TypeScript strict 模式，避免 `any`。
* 对不可信输入优先使用 `unknown`，并显式收窄类型。
* 公共 Contract 使用清晰、稳定的业务名称，不暴露 ExcelJS 等第三方类型。
* 文件和目录使用 `kebab-case`。
* 类型、接口、类使用 `PascalCase`。
* 函数、变量使用 `camelCase`。
* 常量枚举对象使用语义明确的命名。
* Adapter 使用 `<implementation>-<capability>-adapter.ts` 或当前模块既有命名方式。
* Connector 仅描述 Capability 所需接口，不包含具体第三方实现。
* Schema 与 Contract 应保持语义一致。
* 函数保持单一职责，复杂逻辑应拆分为可独立理解和测试的函数。
* 避免重复实现通用逻辑。
* Capability 内部专用逻辑留在自身目录。
* 多个 Capability 共用的工具函数、类型辅助或底层实现必须移动到对应 `shared/`。
* 注释用于解释边界、原因和特殊语义，不重复描述代码本身。

# 5. 操作边界与绝对禁止事项

## Capability 隔离

**严禁 Capability 之间直接引用文件。**

例如以下行为禁止：

```text
excel/data/*
    ↓
excel/discovery/*

excel/aggregate/*
    ↓
excel/data/*
```

任何 Capability：

* 不得 import 其他 Capability 的 `contracts.ts`
* 不得 import 其他 Capability 的 `schemas.ts`
* 不得 import 其他 Capability 的 Adapter
* 不得复用其他 Capability 目录中的内部函数
* 不得通过相对路径绕过边界访问其他 Capability 实现

如果多个 Capability 需要同一份通用逻辑：

```text
Capability A ─┐
              ├─> shared/
Capability B ─┘
```

必须将通用工具函数或基础实现提取到 `shared/`，再由各 Capability 独立引用。

`shared/` 只允许存放真正跨 Capability 复用、且不包含具体业务语义的基础能力，不得成为杂物目录。

## 架构边界

Tool Gateway 不负责：

* Agent Loop
* Agent Lifecycle
* Agent State
* LLM 调用
* ToolCall 生命周期
* Agent Tool 的业务定义
* 多个 Capability 的业务编排
* Backend 业务流程
* 将结果包装为 Agent Runtime 的 Message 类型

禁止 `tool-gateway` 依赖：

* `agent-runtime`
* 具体业务层实现
* Backend 项目
* UI / Web 项目

上层业务可以依赖 Tool Gateway，Tool Gateway 不得反向依赖上层。

## Contract 与实现边界

* 第三方库类型不得泄漏到公共 Contract。
* ExcelJS 类型只允许出现在 Adapter 或 Excel 相关共享实现内部。
* 外部输入必须在 Capability 边界进行运行时校验。
* 不得将 Zod、ExcelJS 等第三方异常作为稳定公共错误契约直接暴露给上层。
* 不得创建跨所有 Capability 的巨型 `contracts.ts`、`schemas.ts` 或 Adapter。
* 不得因为代码量少而合并职责不同的 Capability。
* 不得提前创建尚未使用的 Capability、抽象层或扩展点。
* 不得为了复用而建立 Capability 之间的隐式依赖。
* 不得在未更新测试的情况下改变公开 Contract 或错误语义。

修改代码时优先保持：

```text
Capability Contract
        ↓
Schema
        ↓
Connector
        ↓
Adapter / Internal Logic
        ↓
Third-party Implementation
```

Capability 之间保持横向隔离，共享基础逻辑统一向 `shared/` 收敛。

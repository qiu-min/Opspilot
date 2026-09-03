# OpsPilot Web

OpsPilot 的 React Web 工作台，当前包含桌面优先的 Agent 对话页面原型。

## Technology

- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui 风格组件
- HTTP API
- SSE / SignalR

## Responsibilities

- 用户登录
- Excel 文件上传
- 调用后端接口agent对话
- 展示 Agent 执行进度和分析结果

## Integration boundary

Web 通过 HTTP 调用 Backend 提供的 ASP.NET Core API，正常情况下不直接调用 `agent-service/`。Agent Service 的运行启动、任务状态和业务 Tool 调用由 Backend 负责协调。

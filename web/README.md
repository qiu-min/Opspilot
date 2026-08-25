# OpsPilot Web

未来的 Web 前端占位目录。本次不初始化 Vue、Vite 或任何前端工程文件。

## Technology

- Vue 3
- TypeScript
- Vite
- Pinia
- HTTP API
- SSE / SignalR

## Responsibilities

- 用户登录
- Excel 文件上传
- 创建分析任务
- 展示 Agent 执行进度和分析结果
- 下载处理后的 Excel

## Integration boundary

Web 通过 HTTP 调用 `/backend` 的 ASP.NET Core API，正常情况下不直接调用 `agent-service/`。Agent Service 的运行启动、任务状态和业务 Tool 调用由 Backend 负责协调。

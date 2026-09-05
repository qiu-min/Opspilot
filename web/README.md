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
- 在 active Conversation 切换或页面重新加载后恢复持久化聊天历史

## Integration boundary

Web 通过 HTTP 调用 Backend 提供的 ASP.NET Core API，正常情况下不直接调用 `agent-service/`。Agent Service 的运行启动、任务状态和业务 Tool 调用由 Backend 负责协调。

Conversation detail 使用 `GET /api/conversations/{conversationId}`；API DTO 先经过 mapper，再写入按 ConversationId 隔离的 timeline cache。切换 active conversation 时会取消上一条 detail 请求，避免慢响应覆盖当前会话。

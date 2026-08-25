# Day 5：异步可靠性基础任务清单

## 目标

把 Day 4 创建的 `AnalysisRun(QUEUED)` 可靠地交给后台 Worker 执行，并把运行的起止事实追加到 `run_events`。本日只建立异步调度和运行生命周期；不实现工具调用、模型诊断、审批或真实写操作。

目标链路：

```text
POST /alerts
  → 同一数据库事务写入 Incident、AnalysisRun、alert.received、OutboxMessage
  → Outbox publisher
  → Redis / BullMQ analysis Job
  → Worker
  → run.started → run.completed 或 run.failed
```

## 任务清单

### 0. 恢复可验证的开发基线

- [x] 使用与项目锁文件一致的 Node.js `v22.22.0` 与 pnpm `v11.21.0` 执行 `pnpm install --force`，已重建不完整的工作区依赖链接。
- [x] 运行现有 `pnpm test` 与 `pnpm typecheck`：6 个 workspace 的 15 个测试文件、51 项测试全部通过；7 个 workspace 的类型检查全部通过。
- [x] 根据本机 `docker compose ps` 输出确认：`postgres` 与 `redis` 均为 `healthy`；分别映射到 `localhost:5432` 和 `localhost:6379`，与 `.env` 的 `DATABASE_URL`、`REDIS_URL` 一致。自动化终端未暴露 Docker CLI，但不影响该本机验证结果。

验收：Day 1–4 的依赖、测试、类型检查与 PostgreSQL/Redis 服务均已获得可复现的健康基线。

### 1. 建立最小可编译的异步模块边界

- [x] 创建 `apps/worker`，提供独立的 `dev`、`build`、`test`、`typecheck` 脚本和优雅关闭入口。
- [x] 创建最小 package：`packages/agent-runtime`、`packages/tool-gateway`、`packages/model-gateway`、`packages/observability`。
- [x] 每个 package 只导出 Day 5 所需的边界接口；未提前实现 Day 6+ 的工具、模型和遥测逻辑，也未引入 BullMQ、Redis、OpenAI 或 OpenTelemetry。
- [x] 明确依赖方向：Worker 的启动/组合层可依赖 `application`、`db`、`agent-runtime`、`observability` 来装配资源；未来业务处理层只依赖 `application` 接口，不直接使用 Prisma、BullMQ 或 Redis。

验收：所有新 workspace 均能参与根目录的构建、测试和类型检查；Worker 可以连接后启动再正常停止。

### 2. 定义队列与消息契约

- [x] 在 `packages/application` 定义版本化的 `analysisRunJobSchema`：包含 `incidentId`、`runId`、`outboxMessageId`、字面量 `schemaVersion: 1`；它是 API、publisher 与 Worker 的内部契约，不属于浏览器共享 DTO。
- [x] 为 `analysis-runs` 队列、`analysis.run.requested` Job、最多 3 次执行、初始延迟 1000ms 的指数退避和 Job ID 建立单一常量来源。
- [x] 使用 Zod 在入队前和未来 Worker 消费前校验 payload；缺失字段、非法 UUID 或不支持的版本均会被拒绝。
- [x] 约定幂等语义：投递采用 at-least-once；同一 outbox 消息固定以 `outboxMessageId` 作为 BullMQ `jobId`；Worker 将在第 5 节以 `runId` 为业务幂等边界。

验收：无效任务不能进入业务处理；同一个 outbox 消息重复发布不会产生两个不同的队列 Job。

### 3. 增加事务 outbox 持久化

- [ ] 在 Prisma schema 中新增 `OutboxMessage`（或等价模型）及迁移。
- [ ] 字段至少包含：ID、topic、版本化 payload、去重键、状态、尝试次数、下次可用时间、已发布时间、最后错误、创建/更新时间。
- [ ] 为待发布查询建立必要索引，并为 topic + 去重键建立唯一约束或等价约束。
- [ ] 在 `application` 声明 outbox port；在 `db` 实现持久化、待发布查询、领取/重试、标记已发布接口。
- [ ] 修改告警接收用例，使 Incident、初始 AnalysisRun、`alert.received` 和分析任务 outbox 消息处于同一数据库事务。

验收：模拟事务失败时，既不会遗留 Incident/Run，也不会遗留待投递消息；成功告警恰好产生一条可发布的分析 outbox 消息。

### 4. 实现 outbox publisher

- [ ] 实现可由 API 进程触发且可独立轮询运行的 publisher；不要把“数据库提交后直接 `queue.add`”作为唯一可靠路径。
- [ ] publisher 领取可投递消息、调用 BullMQ `add`、成功后标记已发布；失败时记录错误、增加尝试次数并按退避时间重试。
- [ ] 对并发 publisher 使用数据库领取机制（例如行锁/`SKIP LOCKED` 或等价原子更新），避免同一条消息被并发处理。
- [ ] BullMQ 暂时不可用时，保持消息待重试，不能影响 `POST /alerts` 的事务成功响应。

验收：关闭 Redis 后创建告警仍成功且 outbox 可见；恢复 Redis 并运行 publisher 后，消息被投递且最终标记为已发布。

### 5. 实现分析 Worker 的最小运行生命周期

- [ ] Worker 消费分析队列，先用 Zod 校验任务，再加载并确认 `runId` 属于 `incidentId`。
- [ ] 在 application/db 层增加受条件保护的运行状态迁移接口，避免 Controller 或 Worker 直接写 Prisma 表。
- [ ] 开始处理时原子地将 Run 从 `QUEUED` 转为 `RUNNING`，并追加一次 `run.started`；重复 Job 应视为幂等成功，而不是重复追加事件。
- [ ] Day 5 的处理器只执行占位分析：成功时追加 `run.completed` 并转为 `COMPLETED`；受控异常时追加 `run.failed` 并转为 `FAILED`。
- [ ] 配置 BullMQ 重试、超时、失败日志和优雅关闭；不记录告警正文、工具参数或凭据。

验收：从 `POST /alerts` 取得的 run 最终为 `COMPLETED` 或 `FAILED`，并且时间线按顺序包含 `alert.received`、`run.started`、终态事件；重复 Job 不会重复产生这些状态变更。

### 6. 测试与运维验证

- [ ] 为消息 schema、outbox repository、publisher 重试/去重和运行状态迁移添加单元测试。
- [ ] 添加 API + PostgreSQL + Redis 的集成测试：创建告警 → 发布 → Worker 完成 → 查询 Incident 时间线。
- [ ] 添加 Redis 暂不可用、publisher 重启、重复投递、Worker 重试四个关键场景测试。
- [ ] 更新 README：API、publisher、Worker 的启动命令，环境变量和本地验证步骤。

验收：根目录测试和类型检查通过；按 README 在空数据库中可以完整跑通一次 Day 5 链路。

## 完成定义

Day 5 完成的必要条件：

- [ ] `POST /alerts` 不再只创建 `QUEUED` 的 Run，而是在同一事务中留下可恢复投递的分析任务。
- [ ] Redis、publisher 或 Worker 任意一个短暂故障，都不会使已提交的告警和 Run 消失。
- [ ] Worker 对同一 Run 的重复消费不会产生重复的开始/结束事件。
- [ ] 成功和失败都有持久化终态，且 `GET /incidents/:id` 能看到对应时间线。
- [ ] 未引入工具执行、模型调用或高风险写操作；这些属于 Day 6–9。

## Day 5 对项目的作用

Day 5 是把“同步 API 创建一条待处理记录”变成“可恢复、可审计的后台处理系统”的分界点。事务 outbox 解决数据库提交与消息投递之间的双写缺口：即使 Redis 或进程暂时故障，任务仍保存在 PostgreSQL 中，之后可以安全补投。BullMQ 与 Worker 则把耗时、可重试的诊断工作移出 HTTP 请求，避免告警接口因分析变慢或失败而阻塞。

这层基础直接支撑后续所有能力：Day 6 的并行工具查询、Day 7 的诊断编排、Day 8–9 的审批执行、Day 10 的 SSE 时间线，都会复用同一套“持久化事实 → 可重试投递 → 幂等消费”的机制。它也是项目能够证明异步可靠性、事件溯源与安全边界，而不只是调用模型 API 的关键部分。

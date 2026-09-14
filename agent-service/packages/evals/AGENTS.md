# @opspilot/evals AGENTS.md

`evals` 是 OpsPilot 最外层的离线评估 consumer。

## Boundaries

- 通过 Application 的公开 contract 驱动真实 Agent Turn。
- 不把 Eval contract 放入 Domain，也不让 production package 依赖 `evals`。
- Runner 只负责编排，Evaluator 只负责评分，Reporter 只负责输出。
- 评估执行必须保持顺序；PR1 不引入重试、并行、持久化或质量门禁。

## Development

```bash
pnpm --filter @opspilot/evals typecheck
pnpm --filter @opspilot/evals test
pnpm --filter @opspilot/evals build
```

新增 evaluator 时优先使用确定性的、可编程验证规则，并为成功、失败和异常路径增加单元测试。

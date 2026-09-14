# @opspilot/evals

## Purpose

`evals` 用于离线评估 OpsPilot Agent。它定义通用的 Eval Case、执行器、Evaluator、Runner
和 Report，并提供一个最小的真实 Agent smoke case。

## Boundary

```text
evals may depend on application/runtime-facing public contracts.

production packages must never depend on evals.
```

`AgentEvalExecutor` 通过 `@opspilot/application` 的 `ExecuteTurn.execute()` 驱动真实
Session/Turn/Agent execution path。它不直接调用 Model Gateway，也不实现另一套 Agent Loop。

## Evaluation philosophy

```text
Observability answers:
"What happened?"

Eval answers:
"How well did it happen?"
```

Deterministic evaluators should be preferred whenever the result can be verified programmatically.
PR1 暂时只实现 `RunCompletedEvaluator`；Excel correctness、Trace、LLM-as-Judge 和 UI 留给后续
PR。

## Run the smoke case

在 `agent-service/` 下配置模型 provider 所需的 API key，然后运行：

```bash
pnpm --filter @opspilot/evals eval
```

默认读取 `config/model-providers.json`，并使用 `DEFAULT_MODEL_PROVIDER` /
`DEFAULT_MODEL_ID`；也可以用 `EVAL_MODEL_CONFIG_PATH`、`EVAL_MODEL_PROVIDER` 和
`EVAL_MODEL_ID` 覆盖。运行会打印 Console report，并写入未纳入版本控制的
`packages/evals/results/eval-report.json`。

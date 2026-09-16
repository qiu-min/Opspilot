# @opspilot/evals

## Purpose

`evals` 用于离线评估 OpsPilot Agent。它定义通用的 Eval Case、执行器、Evaluator、Runner
和 Report，并提供真实 Agent smoke case 与 Excel Golden Cases。

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
能程序化验证的 Excel 事实优先使用 deterministic evaluator，不要优先使用 LLM-as-Judge。

## Outcome Eval and Behavior Eval

Outcome Eval determines whether the Agent completed the requested task correctly. The
`ExcelWorkbookCorrectnessEvaluator` is a fully durable read-only outcome evaluator: its evidence comes from
the durable `Turn`, `TurnEvent.tool_completed.resultDetails`, and the `SessionEntry` referenced by
the durable Turn events. It does not use `ExecuteTurnResult.messages`, so the evaluator can replay
an already-finished Turn after the transient runtime result has been discarded.

Behavior Eval uses the durable `TurnTrace` for the same run to decide whether execution followed
the expected behavior. The Excel dataset currently supports these optional constraints:

```text
requiredTools
forbiddenTools
maxToolErrors
```

The Trace evaluator also reports model calls, tool calls, tool errors, retries, compactions, token
usage, duration, and the unique tools used in first-seen order. In PR1 these efficiency metrics are
observational details only; they are not hard gates for an Eval Case.

## Excel Golden Cases

当前四个 Golden Case 使用真实 fixture `datasets/excel/sales.xlsx`。前三个 Case 验证：

```text
这个 Excel 工作簿总共有几个工作表？
```

Eval 会把 fixture 作为 `ExcelResource` 传入 Application `ExecuteTurn.execute()`，并在 Eval
自己的 composition root 中组合真实 Excel tools，包括 `get_workbook_info`、
`get_sheet_profile`、`aggregate_data`、`filter_data`、`read_range` 和 `write_data`。
`ExcelWorkbookCorrectnessEvaluator` 会从 `run.metadata.turnId` 加载 durable `Turn` 和
`TurnEvent`，使用 `tool_completed.resultDetails` 检查真实 `get_workbook_info`、
`get_sheet_profile`、`aggregate_data` facts，并通过 `turn_completed.resultLeafId`、
`assistant_message_completed` 和 `SessionEntry` 定位最终 Assistant。Case 1 检查固定
`sheetCount` Golden expected；Case 2 使用三个成功 profile 的结构化 `sheetName` / `rowCount`，按固定
`headerRowCount` 计算数据行数，并验证最终 Assistant 回答将 `SalesData`、`Products` 和
`MonthlySummary` 分别对应到 120、8 和 7 行数据。Case 3 同样只使用 durable aggregate facts
和被 Turn 引用的最终 Assistant 文本。

```text
Observability:
What happened?

Eval:
How well did it happen?
```

Runner 继续保留 `RunCompletedEvaluator` 和 smoke case；一个 case 只有在全部 required
evaluators 通过时才通过。Excel runner 额外运行 `TraceBehaviorEvaluator`；它通过共享的
Application `TurnStore` 调用 `GetTurnTrace`，不直接读取原始 `TurnEvent`，也不依赖
`ExecuteTurnResult.messages` 作为行为证据。

Excel deterministic outcome 现在分为两类：

```text
Read-only correctness
- workbook info
- sheet profile
- aggregate

Mutation correctness
- durable write evidence
- final workbook artifact verification
```

Case 4 使用 `WorkbookMutationEvaluator`。`write_data` 成功事件本身并不足以通过评估；评估器
会从 durable `TurnEvent` 确认成功写入，再通过 Eval composition root 注入的最小 workbook
reader 读取最终 committed working resource，并独立验证目标范围的真实值。它不检查写入后
是否调用 `read_range`、工具顺序、model calls 或 token usage。

两类 Eval 的证据边界保持分离：

```text
Observability / Behavior: TurnEvent -> TurnTrace
Read-only Outcome: TurnEvent + referenced Session durable state
Mutation Outcome: TurnEvent + final committed working workbook
```

Eval composition root 为 `ExecuteTurn`、`TraceBehaviorEvaluator`、
`ExcelWorkbookCorrectnessEvaluator` 和 `WorkbookMutationEvaluator` 共享同一个临时
`TurnStore` / `SessionStore` / Excel working-resource store；评估完成后临时 durable state
会统一清理。

Case 4 仍使用 `datasets/excel/sales.xlsx` 作为只读 Golden fixture。Application 的
`ExcelWorkingResourceManager` 会在 Eval workspace 中创建并提交 Session 级 working copy，
所以 Agent 的 `write_data` 不会修改 checked-in fixture。

## Run the Eval suite

在 `agent-service/` 下配置模型 provider 所需的 API key，然后运行：

```bash
pnpm --filter @opspilot/evals eval
```

默认读取 `config/model-providers.json`，并使用 `DEFAULT_MODEL_PROVIDER` /
`DEFAULT_MODEL_ID`；也可以用 `EVAL_MODEL_CONFIG_PATH`、`EVAL_MODEL_PROVIDER` 和
`EVAL_MODEL_ID` 覆盖。运行会依次评估 smoke case 与 Excel Golden Case，打印 Console report，
并写入未纳入版本控制的 `packages/evals/results/eval-report.json`。任一 required evaluator
失败时进程以非零状态退出。

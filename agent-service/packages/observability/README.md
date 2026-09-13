# `@opspilot/observability`

`@opspilot/observability` contains pure, in-memory projections of durable execution facts.

`projectTurnTrace(events)` sorts `TurnEvent[]` by durable sequence and returns a `TurnTrace` with
logical Model, Tool, and Compaction spans. It does not read stores, persist projections, call the
Runtime, or depend on wall-clock time. Missing terminal events remain visible as incomplete spans.

Model spans expose `error: ModelTraceError | null`. A `model_started` followed by `model_failed`
projects as `status: "error"` with the durable failure snapshot and duration; a started call with
no terminal fact remains incomplete. This lets `GET /turns/{turnId}/trace` diagnose one model call
without changing the ordinary live TurnStream protocol. `model_retry_scheduled` facts are retained
in `ModelTraceSpan.retries`; successful recovery remains one completed span with `error: null`, while
an exhausted call keeps both its retry history and final `model_failed` error.

The package depends on `@opspilot/domain` for the durable `TurnEvent` contract. Domain, Runtime,
Model Gateway, and Tool Gateway do not depend on Observability.

The package also exports `OpenTelemetryAgentTracer`, an adapter for the Runtime `AgentTracer` port.
It uses the fixed `opspilot.agent-runtime` instrumentation scope and OpenTelemetry API context
scoping, but does not configure an SDK, OTLP exporter, or telemetry backend. Runtime telemetry is
ephemeral and remains independent from `TurnEvent`, `TurnTrace`, checkpointing, recovery, and
TurnStore persistence. Application compaction uses the same port for the `agent.compaction` span
only when a compaction operation actually runs.

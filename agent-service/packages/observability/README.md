# `@opspilot/observability`

`@opspilot/observability` contains pure, in-memory projections of durable execution facts.

`projectTurnTrace(events)` sorts `TurnEvent[]` by durable sequence and returns a `TurnTrace` with
logical Model, Tool, and Compaction spans. It does not read stores, persist projections, call the
Runtime, or depend on wall-clock time. Missing terminal events remain visible as incomplete spans.

The package depends on `@opspilot/domain` for the durable `TurnEvent` contract. Domain, Runtime,
Model Gateway, and Tool Gateway do not depend on Observability.

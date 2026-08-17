# OpsPilot

用于演示 AI 辅助生产故障响应闭环的 TypeScript Monorepo。

## Prerequisites

- Node.js 20+
- pnpm 11+
- Docker Desktop（用于 PostgreSQL 和 Redis）

## Start development

```powershell
pnpm install
Copy-Item .env.example .env
docker compose up -d
pnpm dev
```

Web 应用启动后访问终端显示的本地地址，默认是 `http://localhost:3000`。

## Useful commands

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose down
```

## API usage (Day 4)

Start Docker PostgreSQL, apply the Prisma migrations, then run the API composition root:

```powershell
Copy-Item .env.example .env
docker compose up -d
pnpm --filter @opspilot/db exec prisma migrate deploy
pnpm dev:api
```

The API listens on `http://localhost:3001` by default.

## Worker bootstrap (Day 5.1)

The Worker is an independent server-side process. At this stage it only verifies
startup and graceful shutdown; it does not consume Redis jobs yet.

```powershell
pnpm dev:worker
```

Press `Ctrl+C` to close its database lifecycle cleanly. BullMQ task consumption
is introduced in the next Day 5 task.

### Create an alert

```powershell
$requestId = [guid]::NewGuid().ToString()
$body = @{
  title       = 'Database connection pool exhausted'
  source      = 'prometheus'
  severity    = 'critical'
  triggeredAt = '2026-08-12T08:00:00.000Z'
  service     = 'billing-api'
  summary     = 'Database connections reached the configured limit.'
  labels      = @{ environment = 'development' }
} | ConvertTo-Json -Depth 3

Invoke-RestMethod -Method Post -Uri 'http://localhost:3001/alerts' `
  -ContentType 'application/json' `
  -Headers @{ 'Idempotency-Key' = 'demo-alert-001'; 'X-Request-Id' = $requestId } `
  -Body $body
```

Successful requests return `201 Created` and a body like:

```json
{
  "incidentId": "2d7e0d42-5a7e-4ee3-978e-6d09887d7c86",
  "runId": "c1586d82-50e1-4f7f-a108-33d9e28734e5",
  "incidentStatus": "OPEN",
  "runStatus": "QUEUED",
  "createdAt": "2026-08-12T08:00:00.000Z",
  "requestId": "b7b746d5-627a-430f-91c2-4b7ec4edddaa"
}
```

### Get an incident

Use the `incidentId` returned above:

```powershell
Invoke-RestMethod -Method Get `
  -Uri 'http://localhost:3001/incidents/2d7e0d42-5a7e-4ee3-978e-6d09887d7c86' `
  -Headers @{ 'X-Request-Id' = ([guid]::NewGuid().ToString()) }
```

The response contains the incident projection, its analysis runs, and a safely filtered event timeline.

### Error responses

All expected errors share a safe JSON shape. For example, an invalid request returns:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_ERROR",
  "message": "Request validation failed.",
  "requestId": "b7b746d5-627a-430f-91c2-4b7ec4edddaa",
  "timestamp": "2026-08-12T08:00:00.000Z",
  "details": {
    "title": ["Required"]
  }
}
```

`Idempotency-Key` must be a non-empty value of at most 200 characters. Retrying the same alert with the same key returns the already-created Incident and AnalysisRun instead of creating duplicates.

`X-Request-Id` accepts a UUID. A valid client value is echoed in every response header (and in the alert-create response body); when it is missing or invalid, the server creates a UUID and returns it instead.

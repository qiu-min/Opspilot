-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'INVESTIGATING', 'MITIGATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AnalysisRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunEventType" AS ENUM ('run_started', 'model_response_delta', 'model_response_completed', 'tool_requested', 'tool_started', 'tool_progressed', 'tool_completed', 'action_proposed', 'approval_requested', 'approval_decided', 'execution_started', 'execution_completed', 'run_completed', 'run_failed');

-- CreateEnum
CREATE TYPE "EvidenceKind" AS ENUM ('LOGS', 'METRICS', 'RUNBOOK', 'TOPOLOGY');

-- CreateEnum
CREATE TYPE "ActionStatus" AS ENUM ('PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "incidents" (
    "id" UUID NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_runs" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "status" "AnalysisRunStatus" NOT NULL DEFAULT 'QUEUED',
    "modelName" TEXT,
    "promptVersion" TEXT,
    "toolPermissions" JSONB,
    "initiatedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_events" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "parentEventId" UUID,
    "type" "RunEventType" NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "sourceRunId" UUID,
    "kind" "EvidenceKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceUri" TEXT,
    "timeRangeStart" TIMESTAMP(3),
    "timeRangeEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "proposed_actions" (
    "id" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "status" "ActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "actionType" TEXT NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "parameters" JSONB NOT NULL,
    "rationale" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proposed_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "decision" "ApprovalDecision" NOT NULL,
    "decidedBy" TEXT NOT NULL,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'STARTED',
    "executor" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "result" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "context_checkpoints" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "summary" TEXT NOT NULL,
    "confirmedFacts" JSONB NOT NULL,
    "hypotheses" JSONB NOT NULL,
    "evidenceIds" JSONB NOT NULL,
    "openQuestions" JSONB NOT NULL,
    "actionStates" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "context_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_runs_incidentId_createdAt_idx" ON "analysis_runs"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "run_events_incidentId_createdAt_idx" ON "run_events"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "run_events_runId_createdAt_idx" ON "run_events"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "run_events_parentEventId_idx" ON "run_events"("parentEventId");

-- CreateIndex
CREATE INDEX "evidence_incidentId_createdAt_idx" ON "evidence"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "evidence_sourceRunId_idx" ON "evidence"("sourceRunId");

-- CreateIndex
CREATE UNIQUE INDEX "proposed_actions_idempotencyKey_key" ON "proposed_actions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "proposed_actions_incidentId_createdAt_idx" ON "proposed_actions"("incidentId", "createdAt");

-- CreateIndex
CREATE INDEX "proposed_actions_runId_createdAt_idx" ON "proposed_actions"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "proposed_actions_status_idx" ON "proposed_actions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "approvals_actionId_key" ON "approvals"("actionId");

-- CreateIndex
CREATE INDEX "approvals_decidedAt_idx" ON "approvals"("decidedAt");

-- CreateIndex
CREATE UNIQUE INDEX "executions_actionId_key" ON "executions"("actionId");

-- CreateIndex
CREATE UNIQUE INDEX "executions_idempotencyKey_key" ON "executions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "executions_status_startedAt_idx" ON "executions"("status", "startedAt");

-- CreateIndex
CREATE INDEX "context_checkpoints_runId_createdAt_idx" ON "context_checkpoints"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "analysis_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_parentEventId_fkey" FOREIGN KEY ("parentEventId") REFERENCES "run_events"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "analysis_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposed_actions" ADD CONSTRAINT "proposed_actions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "analysis_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "proposed_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "executions" ADD CONSTRAINT "executions_actionId_fkey" FOREIGN KEY ("actionId") REFERENCES "proposed_actions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "context_checkpoints" ADD CONSTRAINT "context_checkpoints_runId_fkey" FOREIGN KEY ("runId") REFERENCES "analysis_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

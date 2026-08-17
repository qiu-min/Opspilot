ALTER TYPE "RunEventType" ADD VALUE IF NOT EXISTS 'alert_received';

CREATE TABLE "alert_receipts" (
  "id" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "incidentId" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "alert_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alert_receipts_idempotencyKey_key" ON "alert_receipts"("idempotencyKey");
CREATE UNIQUE INDEX "alert_receipts_incidentId_key" ON "alert_receipts"("incidentId");
CREATE UNIQUE INDEX "alert_receipts_runId_key" ON "alert_receipts"("runId");

ALTER TABLE "alert_receipts"
  ADD CONSTRAINT "alert_receipts_incidentId_fkey"
  FOREIGN KEY ("incidentId") REFERENCES "incidents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alert_receipts"
  ADD CONSTRAINT "alert_receipts_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "analysis_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

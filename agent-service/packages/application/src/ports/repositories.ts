import type {
  ActionDto,
  AnalysisRunDto,
  Evidence,
  IncidentDto,
  RunEvent,
  RunEventType,
} from '@opspilot/domain';

export type JsonObject = Record<string, unknown>;

export interface CreateAnalysisRunInput {
  readonly incidentId: string;
  readonly modelName?: string;
  readonly promptVersion?: string;
  readonly toolPermissions?: JsonObject;
  readonly initiatedBy?: string;
}

export interface CreateIncidentWithRunInput {
  readonly run: Omit<CreateAnalysisRunInput, 'incidentId'>;
}

export interface AlertPayload {
  readonly title: string;
  readonly source: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly triggeredAt: string;
  readonly service: string;
  readonly summary: string;
  readonly labels?: Record<string, string>;
  readonly sourceReference?: string;
}

export interface ReceiveAlertInput {
  readonly idempotencyKey: string;
  readonly alert: AlertPayload;
  readonly run: Omit<CreateAnalysisRunInput, 'incidentId'>;
}

export interface ReceivedAlert {
  readonly incident: IncidentDto;
  readonly run: AnalysisRunDto;
  readonly replayed: boolean;
}

export interface AppendRunEventInput {
  readonly incidentId: string;
  readonly runId: string;
  readonly parentEventId?: string | null;
  readonly type: RunEventType;
  readonly payload: JsonObject;
  readonly schemaVersion?: number;
}

export interface CreateEvidenceInput {
  readonly incidentId: string;
  readonly sourceRunId?: string | null;
  readonly kind: Evidence['kind'];
  readonly summary: string;
  readonly content: unknown;
  readonly contentHash: string;
  readonly sourceUri?: string | null;
  readonly timeRangeStart?: string | null;
  readonly timeRangeEnd?: string | null;
}

export interface ContextCheckpoint {
  readonly id: string;
  readonly runId: string;
  readonly summary: string;
  readonly confirmedFacts: unknown;
  readonly hypotheses: unknown;
  readonly evidenceIds: unknown;
  readonly openQuestions: unknown;
  readonly actionStates: unknown;
  readonly createdAt: string;
}

export interface CreateContextCheckpointInput {
  readonly runId: string;
  readonly summary: string;
  readonly confirmedFacts: unknown;
  readonly hypotheses: unknown;
  readonly evidenceIds: unknown;
  readonly openQuestions: unknown;
  readonly actionStates: unknown;
}

export interface CreateProposedActionInput {
  readonly incidentId: string;
  readonly runId: string;
  readonly actionType: string;
  readonly riskLevel: string;
  readonly parameters: JsonObject;
  readonly rationale?: string | null;
  readonly idempotencyKey?: string | null;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly actionId: string;
  readonly decision: 'APPROVED' | 'REJECTED';
  readonly decidedBy: string;
  readonly reason: string | null;
  readonly decidedAt: string;
}

export interface ExecutionRecord {
  readonly id: string;
  readonly actionId: string;
  readonly status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  readonly executor: string;
  readonly idempotencyKey: string;
  readonly result: unknown;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface ProposedActionDetails {
  readonly action: ActionDto;
  readonly actionType: string;
  readonly riskLevel: string;
  readonly parameters: unknown;
  readonly rationale: string | null;
  readonly idempotencyKey: string | null;
  readonly approval: ApprovalRecord | null;
  readonly execution: ExecutionRecord | null;
}

export interface IncidentRepository {
  create(): Promise<IncidentDto>;
  createWithInitialRun(input: CreateIncidentWithRunInput): Promise<{
    incident: IncidentDto;
    run: AnalysisRunDto;
  }>;
  findById(id: string): Promise<IncidentDto | null>;
  listRuns(incidentId: string): Promise<AnalysisRunDto[]>;
}

/** Atomic boundary for an alert receipt, Incident/Run, and its initial event. */
export interface AlertReceiptRepository {
  receive(input: ReceiveAlertInput): Promise<ReceivedAlert>;
}

export interface AnalysisRunRepository {
  create(input: CreateAnalysisRunInput): Promise<AnalysisRunDto>;
  findById(id: string): Promise<AnalysisRunDto | null>;
  listForIncident(incidentId: string): Promise<AnalysisRunDto[]>;
  appendEvent(input: AppendRunEventInput): Promise<RunEvent>;
  listEvents(incidentId: string, runId?: string): Promise<RunEvent[]>;
  saveCheckpoint(input: CreateContextCheckpointInput): Promise<ContextCheckpoint>;
  findLatestCheckpoint(runId: string): Promise<ContextCheckpoint | null>;
}

export interface EvidenceRepository {
  create(input: CreateEvidenceInput): Promise<Evidence>;
  findById(id: string): Promise<Evidence | null>;
  listForIncident(incidentId: string): Promise<Evidence[]>;
}

export interface ActionRepository {
  create(input: CreateProposedActionInput): Promise<ActionDto>;
  findById(id: string): Promise<ProposedActionDetails | null>;
  listForIncident(incidentId: string): Promise<ProposedActionDetails[]>;
}

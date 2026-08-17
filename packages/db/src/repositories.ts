import type {
  ActionDto,
  AnalysisRunDto,
  Evidence,
  IncidentDto,
  RunEvent,
  RunEventType,
} from '@opspilot/domain';
import type {
  ActionRepository,
  AlertReceiptRepository,
  AnalysisRunRepository,
  ApprovalRecord,
  ContextCheckpoint,
  CreateAnalysisRunInput,
  CreateContextCheckpointInput,
  CreateEvidenceInput,
  CreateProposedActionInput,
  EvidenceRepository,
  ExecutionRecord,
  IncidentRepository,
  JsonObject,
  ProposedActionDetails,
  ReceiveAlertInput,
  ReceivedAlert,
} from '@opspilot/application';
import type { Prisma, PrismaClient } from '../generated/client/client.js';
import type {
  ActionStatus as DatabaseActionStatus,
  AnalysisRunStatus as DatabaseAnalysisRunStatus,
  ApprovalDecision,
  EvidenceKind,
  ExecutionStatus,
  IncidentStatus as DatabaseIncidentStatus,
  RunEventType as DatabaseRunEventType,
} from '../generated/client/enums.js';

type DatabaseClient = PrismaClient | Prisma.TransactionClient;

const eventTypeToDatabase: Record<RunEventType, DatabaseRunEventType> = {
  'alert.received': 'alert_received',
  'run.started': 'run_started',
  'model.response.delta': 'model_response_delta',
  'model.response.completed': 'model_response_completed',
  'tool.requested': 'tool_requested',
  'tool.started': 'tool_started',
  'tool.progressed': 'tool_progressed',
  'tool.completed': 'tool_completed',
  'action.proposed': 'action_proposed',
  'approval.requested': 'approval_requested',
  'approval.decided': 'approval_decided',
  'execution.started': 'execution_started',
  'execution.completed': 'execution_completed',
  'run.completed': 'run_completed',
  'run.failed': 'run_failed',
};

const eventTypeFromDatabase: Record<DatabaseRunEventType, RunEventType> = {
  alert_received: 'alert.received',
  run_started: 'run.started',
  model_response_delta: 'model.response.delta',
  model_response_completed: 'model.response.completed',
  tool_requested: 'tool.requested',
  tool_started: 'tool.started',
  tool_progressed: 'tool.progressed',
  tool_completed: 'tool.completed',
  action_proposed: 'action.proposed',
  approval_requested: 'approval.requested',
  approval_decided: 'approval.decided',
  execution_started: 'execution.started',
  execution_completed: 'execution.completed',
  run_completed: 'run.completed',
  run_failed: 'run.failed',
};

const asInputJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const asJson = (value: Prisma.JsonValue): unknown => value;
const asIso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toIncidentDto(value: {
  id: string;
  status: DatabaseIncidentStatus;
  createdAt: Date;
}): IncidentDto {
  return { id: value.id, status: value.status, createdAt: value.createdAt.toISOString() };
}

function toRunDto(value: {
  id: string;
  incidentId: string;
  status: DatabaseAnalysisRunStatus;
  createdAt: Date;
}): AnalysisRunDto {
  return {
    id: value.id,
    incidentId: value.incidentId,
    status: value.status,
    createdAt: value.createdAt.toISOString(),
  };
}

function toEvent(value: {
  id: string;
  incidentId: string;
  runId: string;
  parentEventId: string | null;
  type: DatabaseRunEventType;
  payload: Prisma.JsonValue;
  schemaVersion: number;
  createdAt: Date;
}): RunEvent {
  return {
    id: value.id,
    incidentId: value.incidentId,
    runId: value.runId,
    parentEventId: value.parentEventId,
    type: eventTypeFromDatabase[value.type],
    payload: value.payload as JsonObject,
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt.toISOString(),
  };
}

function toEvidence(value: {
  id: string;
  incidentId: string;
  sourceRunId: string | null;
  kind: EvidenceKind;
  summary: string;
  content: Prisma.JsonValue;
  contentHash: string;
  sourceUri: string | null;
  timeRangeStart: Date | null;
  timeRangeEnd: Date | null;
  createdAt: Date;
}): Evidence {
  return {
    ...value,
    content: asJson(value.content),
    timeRangeStart: asIso(value.timeRangeStart),
    timeRangeEnd: asIso(value.timeRangeEnd),
    createdAt: value.createdAt.toISOString(),
  };
}

function toCheckpoint(value: {
  id: string;
  runId: string;
  summary: string;
  confirmedFacts: Prisma.JsonValue;
  hypotheses: Prisma.JsonValue;
  evidenceIds: Prisma.JsonValue;
  openQuestions: Prisma.JsonValue;
  actionStates: Prisma.JsonValue;
  createdAt: Date;
}): ContextCheckpoint {
  return {
    ...value,
    confirmedFacts: asJson(value.confirmedFacts),
    hypotheses: asJson(value.hypotheses),
    evidenceIds: asJson(value.evidenceIds),
    openQuestions: asJson(value.openQuestions),
    actionStates: asJson(value.actionStates),
    createdAt: value.createdAt.toISOString(),
  };
}

function toActionDto(value: {
  id: string;
  incidentId: string;
  runId: string;
  status: DatabaseActionStatus;
}): ActionDto {
  return { id: value.id, incidentId: value.incidentId, runId: value.runId, status: value.status };
}

function toApproval(value: {
  id: string;
  actionId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  reason: string | null;
  decidedAt: Date;
}): ApprovalRecord {
  return { ...value, decidedAt: value.decidedAt.toISOString() };
}

function toExecution(value: {
  id: string;
  actionId: string;
  status: ExecutionStatus;
  executor: string;
  idempotencyKey: string;
  result: Prisma.JsonValue | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
}): ExecutionRecord {
  return {
    ...value,
    result: value.result === null ? null : asJson(value.result),
    startedAt: value.startedAt.toISOString(),
    completedAt: asIso(value.completedAt),
  };
}

function toActionDetails(value: {
  id: string;
  incidentId: string;
  runId: string;
  status: DatabaseActionStatus;
  actionType: string;
  riskLevel: string;
  parameters: Prisma.JsonValue;
  rationale: string | null;
  idempotencyKey: string | null;
  approval: {
    id: string;
    actionId: string;
    decision: ApprovalDecision;
    decidedBy: string;
    reason: string | null;
    decidedAt: Date;
  } | null;
  execution: {
    id: string;
    actionId: string;
    status: ExecutionStatus;
    executor: string;
    idempotencyKey: string;
    result: Prisma.JsonValue | null;
    errorMessage: string | null;
    startedAt: Date;
    completedAt: Date | null;
  } | null;
}): ProposedActionDetails {
  return {
    action: toActionDto(value),
    actionType: value.actionType,
    riskLevel: value.riskLevel,
    parameters: asJson(value.parameters),
    rationale: value.rationale,
    idempotencyKey: value.idempotencyKey,
    approval: value.approval ? toApproval(value.approval) : null,
    execution: value.execution ? toExecution(value.execution) : null,
  };
}

async function assertRunBelongsToIncident(
  database: DatabaseClient,
  runId: string,
  incidentId: string,
): Promise<void> {
  const run = await database.analysisRun.findUnique({
    where: { id: runId },
    select: { incidentId: true },
  });
  if (!run || run.incidentId !== incidentId)
    throw new Error('Analysis run does not belong to the incident.');
}

export class PrismaIncidentRepository implements IncidentRepository {
  constructor(private readonly database: DatabaseClient) {}
  async create(): Promise<IncidentDto> {
    return toIncidentDto(await this.database.incident.create({ data: {} }));
  }
  async createWithInitialRun(input: {
    run: Omit<CreateAnalysisRunInput, 'incidentId'>;
  }): Promise<{ incident: IncidentDto; run: AnalysisRunDto }> {
    const create = async (tx: DatabaseClient) => {
      const incident = await tx.incident.create({ data: {} });
      const run = await tx.analysisRun.create({
        data: {
          ...input.run,
          incidentId: incident.id,
          toolPermissions: input.run.toolPermissions
            ? asInputJson(input.run.toolPermissions)
            : undefined,
        },
      });
      return { incident: toIncidentDto(incident), run: toRunDto(run) };
    };
    return '$transaction' in this.database
      ? this.database.$transaction(create)
      : create(this.database);
  }
  async findById(id: string): Promise<IncidentDto | null> {
    const value = await this.database.incident.findUnique({ where: { id } });
    return value ? toIncidentDto(value) : null;
  }
  async listRuns(incidentId: string): Promise<AnalysisRunDto[]> {
    return (
      await this.database.analysisRun.findMany({
        where: { incidentId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(toRunDto);
  }
}

export class PrismaAlertReceiptRepository implements AlertReceiptRepository {
  constructor(private readonly database: DatabaseClient) {}

  async receive(input: ReceiveAlertInput): Promise<ReceivedAlert> {
    const receive = async (tx: DatabaseClient): Promise<ReceivedAlert> => {
      const existing = await tx.alertReceipt.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { incident: true, run: true },
      });
      if (existing) {
        return {
          incident: toIncidentDto(existing.incident),
          run: toRunDto(existing.run),
          replayed: true,
        };
      }

      const incident = await tx.incident.create({ data: {} });
      const run = await tx.analysisRun.create({
        data: {
          ...input.run,
          incidentId: incident.id,
          toolPermissions: input.run.toolPermissions
            ? asInputJson(input.run.toolPermissions)
            : undefined,
        },
      });
      await tx.runEvent.create({
        data: {
          incidentId: incident.id,
          runId: run.id,
          type: 'alert_received',
          payload: asInputJson(input.alert),
        },
      });
      await tx.alertReceipt.create({
        data: {
          idempotencyKey: input.idempotencyKey,
          payload: asInputJson(input.alert),
          incidentId: incident.id,
          runId: run.id,
        },
      });
      return { incident: toIncidentDto(incident), run: toRunDto(run), replayed: false };
    };

    try {
      return '$transaction' in this.database
        ? await this.database.$transaction(receive)
        : await receive(this.database);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const existing = await this.database.alertReceipt.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: { incident: true, run: true },
      });
      if (!existing) throw error;
      return {
        incident: toIncidentDto(existing.incident),
        run: toRunDto(existing.run),
        replayed: true,
      };
    }
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export class PrismaAnalysisRunRepository implements AnalysisRunRepository {
  constructor(private readonly database: DatabaseClient) {}
  async create(input: CreateAnalysisRunInput): Promise<AnalysisRunDto> {
    return toRunDto(
      await this.database.analysisRun.create({
        data: {
          ...input,
          toolPermissions: input.toolPermissions ? asInputJson(input.toolPermissions) : undefined,
        },
      }),
    );
  }
  async findById(id: string): Promise<AnalysisRunDto | null> {
    const value = await this.database.analysisRun.findUnique({ where: { id } });
    return value ? toRunDto(value) : null;
  }
  async listForIncident(incidentId: string): Promise<AnalysisRunDto[]> {
    return (
      await this.database.analysisRun.findMany({
        where: { incidentId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(toRunDto);
  }
  async appendEvent(input: import('@opspilot/application').AppendRunEventInput): Promise<RunEvent> {
    await assertRunBelongsToIncident(this.database, input.runId, input.incidentId);
    if (input.parentEventId) {
      const parent = await this.database.runEvent.findUnique({
        where: { id: input.parentEventId },
        select: { incidentId: true },
      });
      if (!parent || parent.incidentId !== input.incidentId)
        throw new Error('Parent event does not belong to the incident.');
    }
    return toEvent(
      await this.database.runEvent.create({
        data: {
          incidentId: input.incidentId,
          runId: input.runId,
          parentEventId: input.parentEventId ?? null,
          type: eventTypeToDatabase[input.type],
          payload: asInputJson(input.payload),
          schemaVersion: input.schemaVersion ?? 1,
        },
      }),
    );
  }
  async listEvents(incidentId: string, runId?: string): Promise<RunEvent[]> {
    return (
      await this.database.runEvent.findMany({
        where: { incidentId, ...(runId ? { runId } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(toEvent);
  }
  async saveCheckpoint(input: CreateContextCheckpointInput): Promise<ContextCheckpoint> {
    const run = await this.database.analysisRun.findUnique({
      where: { id: input.runId },
      select: { id: true },
    });
    if (!run) throw new Error('Analysis run does not exist.');
    return toCheckpoint(
      await this.database.contextCheckpoint.create({
        data: {
          ...input,
          confirmedFacts: asInputJson(input.confirmedFacts),
          hypotheses: asInputJson(input.hypotheses),
          evidenceIds: asInputJson(input.evidenceIds),
          openQuestions: asInputJson(input.openQuestions),
          actionStates: asInputJson(input.actionStates),
        },
      }),
    );
  }
  async findLatestCheckpoint(runId: string): Promise<ContextCheckpoint | null> {
    const value = await this.database.contextCheckpoint.findFirst({
      where: { runId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return value ? toCheckpoint(value) : null;
  }
}

export class PrismaEvidenceRepository implements EvidenceRepository {
  constructor(private readonly database: DatabaseClient) {}
  async create(input: CreateEvidenceInput): Promise<Evidence> {
    if (input.sourceRunId)
      await assertRunBelongsToIncident(this.database, input.sourceRunId, input.incidentId);
    return toEvidence(
      await this.database.evidence.create({
        data: {
          ...input,
          sourceRunId: input.sourceRunId ?? null,
          content: asInputJson(input.content),
          timeRangeStart: input.timeRangeStart ? new Date(input.timeRangeStart) : null,
          timeRangeEnd: input.timeRangeEnd ? new Date(input.timeRangeEnd) : null,
        },
      }),
    );
  }
  async findById(id: string): Promise<Evidence | null> {
    const value = await this.database.evidence.findUnique({ where: { id } });
    return value ? toEvidence(value) : null;
  }
  async listForIncident(incidentId: string): Promise<Evidence[]> {
    return (
      await this.database.evidence.findMany({
        where: { incidentId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(toEvidence);
  }
}

export class PrismaActionRepository implements ActionRepository {
  constructor(private readonly database: DatabaseClient) {}
  async create(input: CreateProposedActionInput): Promise<ActionDto> {
    await assertRunBelongsToIncident(this.database, input.runId, input.incidentId);
    return toActionDto(
      await this.database.proposedAction.create({
        data: {
          ...input,
          rationale: input.rationale ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          parameters: asInputJson(input.parameters),
        },
      }),
    );
  }
  async findById(id: string): Promise<ProposedActionDetails | null> {
    const value = await this.database.proposedAction.findUnique({
      where: { id },
      include: { approval: true, execution: true },
    });
    return value ? toActionDetails(value) : null;
  }
  async listForIncident(incidentId: string): Promise<ProposedActionDetails[]> {
    return (
      await this.database.proposedAction.findMany({
        where: { incidentId },
        include: { approval: true, execution: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    ).map(toActionDetails);
  }
}

export function createRepositories(database: PrismaClient | Prisma.TransactionClient): {
  incidents: IncidentRepository;
  alertReceipts: AlertReceiptRepository;
  analysisRuns: AnalysisRunRepository;
  evidence: EvidenceRepository;
  actions: ActionRepository;
} {
  return {
    incidents: new PrismaIncidentRepository(database),
    alertReceipts: new PrismaAlertReceiptRepository(database),
    analysisRuns: new PrismaAnalysisRunRepository(database),
    evidence: new PrismaEvidenceRepository(database),
    actions: new PrismaActionRepository(database),
  };
}

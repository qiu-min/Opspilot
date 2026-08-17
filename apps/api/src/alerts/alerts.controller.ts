import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  Req,
} from '@nestjs/common';
import {
  CREATE_INCIDENT_FROM_ALERT,
  type CreateIncidentFromAlert,
} from '@opspilot/application';
import {
  createAlertRequestSchema,
  createAlertResponseSchema,
  type CreateAlertRequest,
  type CreateAlertResponse,
} from '@opspilot/shared';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Response } from 'express';

import { API_LOGGER, type ApiLogger } from '../common/api-logger.js';
import { type RequestWithContext } from '../common/request-context.middleware.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

@Controller('alerts')
export class AlertsController {
  constructor(
    @Inject(CREATE_INCIDENT_FROM_ALERT)
    private readonly createIncidentFromAlert: CreateIncidentFromAlert,
    @Inject(API_LOGGER) private readonly logger: ApiLogger,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodValidationPipe(createAlertRequestSchema)) body: CreateAlertRequest,
    @Headers('idempotency-key') idempotencyKeyHeader: string | string[] | undefined,
    @Req() request: RequestWithContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreateAlertResponse> {
    const idempotencyKey = this.readIdempotencyKey(idempotencyKeyHeader);
    try {
      const result = await this.createIncidentFromAlert.execute({
        requestId: request.requestId,
        idempotencyKey,
        alert: body,
        run: { initiatedBy: 'alert-api' },
      });
      this.writeAuditLog({
        requestId: request.requestId,
        source: body.source,
        idempotencyKey,
        outcome: 'succeeded',
        incidentId: result.incident.id,
        runId: result.run.id,
      });
      const payload = createAlertResponseSchema.parse({
        incidentId: result.incident.id,
        runId: result.run.id,
        incidentStatus: result.incident.status,
        runStatus: result.run.status,
        createdAt: result.incident.createdAt,
        requestId: request.requestId,
      });
      response.setHeader('X-Request-Id', request.requestId);
      return payload;
    } catch (error) {
      this.writeAuditLog({
        requestId: request.requestId,
        source: body.source,
        idempotencyKey,
        outcome: 'failed',
      });
      throw error;
    }
  }

  private readIdempotencyKey(value: string | string[] | undefined): string {
    if (value === undefined) return randomUUID();
    if (Array.isArray(value) || value.trim().length === 0 || value.length > 200) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid Idempotency-Key.' });
    }
    return value;
  }

  private writeAuditLog(input: {
    readonly requestId: string;
    readonly source: string;
    readonly idempotencyKey: string;
    readonly outcome: 'succeeded' | 'failed';
    readonly incidentId?: string;
    readonly runId?: string;
  }): void {
    this.logger.info({
      event: 'alert.received',
      requestId: input.requestId,
      source: input.source,
      idempotencyKeyHash: createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 16),
      outcome: input.outcome,
      ...(input.incidentId ? { incidentId: input.incidentId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
    });
  }
}

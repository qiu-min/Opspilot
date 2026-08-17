import {
  Controller,
  Get,
  Inject,
  Param,
  Req,
} from '@nestjs/common';
import {
  GET_INCIDENT_DETAIL,
  type GetIncidentDetail,
  type IncidentDetail,
} from '@opspilot/application';
import {
  getIncidentDetailResponseSchema,
  type GetIncidentDetailResponse,
} from '@opspilot/shared';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { type RequestWithContext } from '../common/request-context.middleware.js';

const incidentParamsSchema = z.object({ id: z.uuid() });

const alertReceivedPayloadKeys = [
  'title',
  'source',
  'severity',
  'triggeredAt',
  'service',
  'summary',
] as const;

type TimelineEvent = IncidentDetail['events'][number];

function toPublicTimelineEvent(event: TimelineEvent): TimelineEvent {
  if (event.type !== 'alert.received') {
    return { ...event, payload: {} };
  }

  const payload = Object.fromEntries(
    alertReceivedPayloadKeys.flatMap((key) => {
      const value = event.payload[key];
      return typeof value === 'string' ? [[key, value]] : [];
    }),
  );

  return { ...event, payload };
}

@Controller('incidents')
export class IncidentsController {
  constructor(
    @Inject(GET_INCIDENT_DETAIL)
    private readonly getIncidentDetail: GetIncidentDetail,
  ) {}

  @Get(':id')
  async findOne(
    @Param(new ZodValidationPipe(incidentParamsSchema)) params: { readonly id: string },
    @Req() request: RequestWithContext,
  ): Promise<GetIncidentDetailResponse> {
    const detail = await this.getIncidentDetail.execute({
      incidentId: params.id,
      requestId: request.requestId,
    });
    return getIncidentDetailResponseSchema.parse({
      incident: detail.incident,
      runs: detail.runs,
      timeline: detail.events.map(toPublicTimelineEvent),
    });
  }
}

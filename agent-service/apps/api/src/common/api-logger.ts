import { Injectable } from '@nestjs/common';
import pino, { type Logger } from 'pino';

export const API_LOGGER = Symbol('API_LOGGER');

export type ApiLogger = Pick<Logger, 'info'>;

@Injectable()
export class ApiLoggerFactory {
  create(): ApiLogger {
    return pino({
      level: process.env.LOG_LEVEL ?? 'info',
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    });
  }
}

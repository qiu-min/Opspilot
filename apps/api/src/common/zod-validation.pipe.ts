import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { z } from 'zod';

export type ValidationDetails = Record<string, readonly string[]>;

export class RequestValidationError extends BadRequestException {
  constructor(readonly details: ValidationDetails) {
    super({ code: 'VALIDATION_ERROR', message: 'Request validation failed.', details });
  }
}

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw new RequestValidationError(toValidationDetails(parsed.error));
  }
}

function toValidationDetails(error: z.ZodError): ValidationDetails {
  const details: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.length ? issue.path.join('.') : 'root';
    (details[path] ??= []).push(issue.message);
  }
  return details;
}

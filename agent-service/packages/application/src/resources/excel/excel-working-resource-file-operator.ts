import type {
  ExcelWorkingMutationContext,
  ExcelWorkingMutationRequest,
  ExcelWorkingResource,
} from './excel-working-resource.js';

/** Filesystem boundary for preparing and atomically committing a staged workbook mutation. */
export interface ExcelWorkingResourceFileOperator {
  prepareMutation(input: ExcelWorkingMutationRequest): Promise<ExcelWorkingMutationContext>;

  commitMutation(
    input: ExcelWorkingMutationRequest,
    context: ExcelWorkingMutationContext,
    receipt: unknown,
  ): Promise<ExcelWorkingResource>;

  abortMutation(
    input: ExcelWorkingMutationRequest,
    context: ExcelWorkingMutationContext,
  ): Promise<void>;
}

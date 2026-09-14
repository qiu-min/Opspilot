/** The normalized result produced by one evaluator. Score values are in the 0..1 range. */
export interface EvalScore {
  readonly evaluator: string;
  readonly score: number;
  readonly passed: boolean;
  readonly reason?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

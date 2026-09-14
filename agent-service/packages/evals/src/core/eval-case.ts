/** A stable, domain-neutral input case for one evaluation run. */
export interface EvalCase<TInput = unknown, TExpected = unknown> {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly input: TInput;
  readonly expected?: TExpected;
  readonly tags?: readonly string[];
}

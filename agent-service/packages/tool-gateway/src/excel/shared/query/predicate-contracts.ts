/** Values supported by the shared Excel predicate evaluator. */
export type ExcelPredicateValue = string | number | boolean | Date;

export type ExcelPredicateOperator =
  | 'equals'
  | 'notEquals'
  | 'greaterThan'
  | 'lessThan'
  | 'contains'
  | 'isEmpty'
  | 'isNotEmpty';

export type ExcelPredicateLogic = 'all' | 'any';

/** A typed, exact-header predicate shared by filtering and aggregation. */
export interface ExcelPredicate {
  readonly column: string;
  readonly operator: ExcelPredicateOperator;
  readonly value?: ExcelPredicateValue;
}
